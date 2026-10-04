/**
 * dsh-notified — native conversation-completion notifications for DSH.
 *
 * A profile bundle that watches sessions settle a turn and posts a native
 * notification on Windows or macOS, so a user who switched away learns that the
 * agent finished. Clicking the notification hands focus back through the
 * `dsh://open` protocol the desktop application already registers.
 *
 * Design constraints, each verified against the running 0.2.0-rc.2 runtime:
 *
 * - The host process runs as Electron-with-`ELECTRON_RUN_AS_NODE`, so
 *   `electron` is not importable and its `Notification` class is out of reach.
 *   A platform module owns the channel that replaces it: `lib/toast.js` drives
 *   PowerShell/WinRT on Windows, `lib/darwin.js` drives a compiled
 *   `UserNotifications` helper on macOS.
 * - `turn/end` is the settlement signal; it is appended post-commit and carries
 *   `reason.kind`, so it distinguishes a real answer from an abort or an error.
 * - A turn that produces no assistant text (a pure tool round trip) is not a
 *   finished conversation, so it is tracked and skipped.
 * - Notification work must never appear on the conversation's critical path:
 *   delivery is launched as a child process and its promise is intentionally
 *   not awaited by the event listener.
 * - Everything above the platform module is shared, so one policy, one body
 *   budget and one title rule decide *whether* and *what* to say on both
 *   platforms; only the last hop differs.
 *
 * @module dsh-notified
 */

import z from "@deepseek-ai/schemastery";

import { composeBody, composeMergedSummary, composeTitle } from "./text.js";
import { decideTurnEnd, foldTurnState } from "./policy.js";
import { DEFAULT_APP_ID, registerAumid, resolveHarnessIcon, showToast } from "./toast.js";
import { ensureHelper, showMacToast } from "./darwin.js";
import { WebNotificationHub } from "./web.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-notified";

/**
 * Services this plugin consumes. `sessionTitle` is optional at runtime (its
 * absence only degrades the title), so it is read through the optional `ctx.get`
 * seam rather than declared here.
 */
export const inject = [];

/** Turn-end reasons that can trigger a notification, for reference by operators. */
export const REASONS = ["completed", "aborted", "error", "interrupted"];

/** Toast durations accepted by the Windows toast schema. */
export const DURATIONS = ["short", "long"];

/** Schemastery configuration; each field is projected into the settings form. */
export const Config = z.object({
  /** Master switch for the whole plugin. */
  enabled: z.boolean().default(true).description("Post a notification when a turn finishes."),
  /** Which turn settlements are worth surfacing. */
  notifyOn: z
    .array(z.string())
    .default(["completed"])
    .description("Turn outcomes that notify: completed, aborted, error, interrupted."),
  /** Stay quiet while the user is already looking at the app. */
  suppressWhenFocused: z
    .boolean()
    .default(true)
    .description("Skip the notification while the DSH window is in the foreground."),
  /** Process names treated as "the app is focused". */
  foregroundProcessNames: z
    .array(z.string())
    .default(["DeepSeek Harness"])
    .description("Foreground process or app names that count as the app already being visible."),
  /** Merge window in milliseconds; multiple settlements inside it become one notification. */
  coalesceMs: z
    .number()
    .default(1500)
    .description("Merge notifications that arrive within this window (ms). 0 disables merging."),
  /** Ignore turns shorter than this, which are usually incidental. */
  minTurnDurationMs: z
    .number()
    .default(0)
    .description("Do not notify for turns shorter than this (ms)."),
  /** Whether delegated child sessions may notify. */
  includeSubagents: z.boolean().default(false).description("Also notify for delegated subagent sessions."),
  /** Maximum characters in the notification body. */
  bodyMaxChars: z.number().default(140).description("Maximum characters in the notification body. The duration is reserved inside this budget."),
  /** Whether to append the turn's wall-clock duration. */
  showDuration: z.boolean().default(true).description("Append how long the turn took; the duration is reserved so truncation never drops it."),
  /** Application identity the toast is attributed to. */
  appId: z.string().default(DEFAULT_APP_ID).description("Windows only: application identity the toast is attributed to."),
  /** Register that identity under HKCU so the toast is branded. */
  registerAumid: z.boolean().default(true).description("Windows only: register the app identity so the toast shows the app name and icon."),
  /** Override the icon shown by the registered identity. */
  iconPath: z.string().default("").description("Icon for the app identity. Empty uses the app's own icon."),
  /** Deep link the notification opens when clicked. */
  launch: z.string().default("dsh://open").description("URI opened when the notification is clicked."),
  /** Display duration. */
  duration: z.string().default("short").description("Notification duration: short or long. On macOS, long becomes time-sensitive."),
  /** Whether the notification plays a sound. */
  sound: z.boolean().default(false).description("Play the notification sound."),
  /** Copy used when several turns are merged into one notification. */
  mergedTemplate: z.string().default("{count} conversations finished").description("Body for a merged notification; {count} is replaced."),
  /** Copy used when the reply text is empty. */
  emptyBody: z.string().default("Turn finished").description("Body used when there is no reply text to show."),
  /** Log the child's outcome for each delivery. */
  verbose: z.boolean().default(false).description("Log notification delivery details."),
});

/** Turn-settlement reasons that count as "the user is being waited on". */
export const INFORMATIVE_REASONS = new Set(["completed", "error", "interrupted"]);

/** Platforms that have a delivery channel. */
export const PLATFORMS = ["win32", "darwin"];

/**
 * Remedies for the delivery failures that have one.
 *
 * A bare reason code leaves an operator stuck: "denied" on macOS means a switch
 * has to be flipped in System Settings, and "no-swiftc" means a compiler is
 * missing. Only reasons with a real remedy appear here; anything else is
 * reported as-is rather than with a guess.
 */
const FAILURE_HINTS = {
  "darwin:denied": 'allow notifications for "DeepSeek Harness" in System Settings › Notifications',
  "darwin:no-swiftc": "install the Xcode command-line tools so the helper can be compiled",
  "darwin:compile-failed": "the bundled Swift helper did not compile",
  "darwin:helper-timeout": "the helper did not start; launch it once by hand to see why",
  "darwin:launch-failed": "the helper bundle could not be launched",
  "win32:no-powershell": "Windows PowerShell 5.1 could not be located",
};

/**
 * Describe a failed delivery so the log line is actionable.
 * @param outcome - the failed outcome from a channel.
 * @param platform - the platform the delivery ran on.
 * @returns the reason, any detail, and a remedy when one is known.
 */
export function explainFailure(outcome, platform) {
  const detail = outcome.stderr || outcome.detail;
  const parts = [`(${outcome.reason}${outcome.code === undefined ? "" : `, exit ${outcome.code}`})`];
  if (detail) parts.push(`: ${detail}`);
  const hint = FAILURE_HINTS[`${platform}:${outcome.reason}`];
  if (hint) parts.push(` — ${hint}`);
  return parts.join("");
}

/**
 * Register the Windows application identity so the toast is branded.
 *
 * The toast is attributed to whatever `appId` names, but Windows only shows a
 * display name and icon for an identity that is registered under HKCU, so this
 * is what turns an opaque "DeepSeek.Harness.Notified" into "DeepSeek Harness".
 * @param ctx - plugin context, for logging.
 * @param config - effective configuration.
 * @param log - the verbosity-aware logger.
 * @returns `{ registered }`, read by the delivery path.
 */
function prepareWindows(ctx, config, log) {
  if (!config.registerAumid) return { registered: false };
  const icon = config.iconPath.length > 0 ? config.iconPath : resolveHarnessIcon();
  const outcome = registerAumid({ appId: config.appId, iconUri: icon });
  if (outcome.ok) {
    log("info", `dsh-notified: registered app identity ${config.appId}${icon ? ` with icon ${icon}` : ""}`);
  } else {
    ctx.logger.warn(`dsh-notified: could not register the app identity (${outcome.reason}); the toast will use the fallback identity`);
  }
  return { registered: outcome.ok };
}

/**
 * Install the macOS helper.
 *
 * Compiling the Swift helper takes about half a second, so the work is started
 * here without being awaited: it overlaps whatever the user does next, and a
 * notification that arrives before the build finishes awaits the same cached
 * promise instead of starting a second compile. The failure is reported once,
 * here, where it is actionable — the notification path should not repeat it on
 * every turn.
 *
 * The bundle identifier is deliberately NOT taken from `config.appId`: macOS
 * keys the user's notification permission to the bundle identifier, so making it
 * configurable would silently revoke that grant the moment the field was edited.
 * `appId` therefore remains a Windows-only setting.
 * @param ctx - plugin context, for logging.
 * @param config - effective configuration.
 * @param log - the verbosity-aware logger.
 * @param overrides - delivery seams; `ensureHelper` replaces the installer in tests.
 * @returns `{ registered: false }`; macOS has no Windows-style identity to register.
 */
function prepareDarwin(ctx, config, log, overrides = {}) {
  const install = overrides.ensureHelper ?? ensureHelper;
  void install({ iconPath: config.iconPath })
    .then((outcome) => {
      if (outcome.ok) {
        log("info", `dsh-notified: macOS notification helper ${outcome.reason === "current" ? "ready" : "installed"}`);
        return;
      }
      ctx.logger.warn(
        `dsh-notified: the macOS helper could not be prepared (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}); notifications will not be delivered`,
      );
    })
    .catch((error) => {
      ctx.logger.warn(`dsh-notified: the macOS helper could not be prepared (${String(error?.message ?? error)})`);
    });
  return { registered: false };
}

/**
 * Choose the channel that delivers on a platform.
 *
 * An injected `showToast` short-circuits the choice entirely: it is the test
 * seam, and on a platform with no real channel it is the only way to exercise
 * the plugin at all.
 * @param input - the platform, and the caller's overrides.
 * @returns the channel, or `{ok:false, reason}` when the platform is unsupported.
 */
export function resolveChannel(input = {}) {
  const platform = input.platform ?? process.platform;
  const overrides = input.overrides ?? {};
  if (typeof overrides.showToast === "function") {
    return {
      ok: true,
      platform,
      injected: true,
      send: overrides.showToast,
      noun: "notification",
      // The caller owns delivery, so the identity question is theirs too. The
      // configured identity counts as usable, which keeps `appId` plumbing
      // observable from a test on any platform.
      prepare: (_ctx, config) => ({ registered: config.registerAumid === true }),
    };
  }
  if (platform === "win32") {
    return { ok: true, platform, injected: false, send: showToast, noun: "toast", prepare: prepareWindows };
  }
  if (platform === "darwin") {
    return {
      ok: true,
      platform,
      injected: false,
      send: showMacToast,
      noun: "notification",
      prepare: (ctx, config, log) => prepareDarwin(ctx, config, log, overrides),
    };
  }
  return { ok: false, platform, reason: "unsupported-platform" };
}

/**
 * Build the manual test tool's definition.
 *
 * The definition is assembled here rather than through `@deepseek-ai/dsh-tools`'s
 * `defineTool` helper on purpose: that package is supplied by the running
 * installation, and a plugin reached through a `link:` install is resolved to
 * its real path outside the profile, where the helper cannot be imported. The
 * registry only requires the shape below, so a hand-built definition keeps the
 * test tool working under every install style.
 * @param config - effective configuration.
 * @param isRegistered - reads whether the branded identity was registered.
 * @param send - the delivery function.
 * @param channel - the resolved platform channel, for user-facing wording.
 * @returns a registry-ready tool definition.
 */
function TEST_TOOL(config, isRegistered, send, channel, webHub) {
  const noun = channel?.noun ?? "notification";
  return {
    name: "dsh_notify_test",
    description: "Send a test desktop notification through dsh-notified to verify the notification channel works.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Notification title. Defaults to the app name." },
        body: { type: "string", description: "Notification body text. Defaults to a fixed probe line." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          delivered: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["delivered", "detail"],
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    execute: async (args) => {
      const payload = {
        title: typeof args.title === "string" && args.title.length > 0 ? args.title : "DeepSeek Harness",
        body: typeof args.body === "string" && args.body.length > 0 ? args.body : "dsh-notified test notification",
        appId: isRegistered() ? config.appId : undefined,
        launch: config.launch,
        duration: config.duration,
        silent: !config.sound,
        suppressWhenFocused: false,
        foregroundProcessNames: config.foregroundProcessNames,
      };
      const outcome = await send(payload);
      if (webHub && channel?.platform !== "web" && webHub.hasClients) {
        void webHub.broadcast(payload);
      }
      return outcome.ok
        ? { delivered: true, detail: `${noun === "toast" ? "Toast" : "Notification"} delivered${outcome.suppressed ? " (suppressed by focus policy)" : ""}.` }
        : { delivered: false, detail: `Delivery failed ${explainFailure(outcome, channel?.platform ?? process.platform)}` };
    },
  };
}

/**
 * Register the plugin against one Cordis context.
 * @param ctx - plugin context; every listener and resource is disposed with it.
 * @param config - validated configuration from the loader entry.
 * @param overrides - delivery seams for tests; production omits them.
 */
export function apply(ctx, config, overrides = {}) {
  const log = (level, ...args) => {
    if (level === "info" || config.verbose) ctx.logger[level](...args);
  };

  let channel = resolveChannel({ overrides });
  const webServer = overrides.webServer ?? (typeof ctx.get === "function" ? ctx.get("webServer") : undefined);
  const webHub = overrides.webHub ?? new WebNotificationHub();

  if (webServer) {
    ctx.effect(() => webHub.attach(webServer));
  } else if (typeof ctx.on === "function") {
    ctx.on("service", (svc) => {
      if (svc === "webServer") {
        const srv = ctx.get("webServer");
        if (srv) ctx.effect(() => webHub.attach(srv));
      }
    });
  }

  if (!channel.ok && (webServer || overrides.webHub)) {
    channel = {
      ok: true,
      platform: "web",
      injected: false,
      send: (p) => webHub.broadcast(p),
      noun: "notification",
      prepare: () => ({ registered: false }),
    };
  }

  if (!channel.ok) {
    ctx.logger.info(`dsh-notified: no notification channel on ${channel.platform}; notifications stay idle`);
    return;
  }
  const send = channel.send;
  const { registered } = channel.prepare(ctx, config, log);

  /** Per-session turn bookkeeping, cleared when the turn closes or the session goes away. */
  const sessions = new Map();

  /** Pending coalesced notification, if any. */
  let pending = null;
  let pendingTimer;

  const flushPending = () => {
    pendingTimer = undefined;
    const batch = pending;
    pending = null;
    if (batch === null) return;
    void deliver(batch);
  };

  const deliver = async (batch) => {
    const title = composeTitle({
      sessionTitle: batch.title,
      cwd: batch.cwd,
      fallback: "DeepSeek Harness",
    });
    // A merged batch describes the count instead of one reply: quoting a single
    // reply under "3 conversations finished" would be misleading.
    const text = batch.count > 1 ? composeMergedSummary(batch.count, config.mergedTemplate) : batch.bodyText;
    const body = composeBody({
      text,
      turnDurationMs: batch.count === 1 && config.showDuration ? batch.turnDurationMs : undefined,
      maxChars: config.bodyMaxChars,
      emptyBody: config.emptyBody,
    });

    const payload = {
      title: title.length > 0 ? title : "DeepSeek Harness",
      body,
      appId: registered ? config.appId : undefined,
      launch: config.launch,
      duration: config.duration,
      silent: !config.sound,
      suppressWhenFocused: config.suppressWhenFocused,
      foregroundProcessNames: config.foregroundProcessNames,
    };

    const outcome = await send(payload);

    if (channel.platform !== "web" && webHub.hasClients) {
      void webHub.broadcast(payload);
    }

    if (outcome.ok) {
      log("info", outcome.suppressed ? "dsh-notified: skipped, the app is already focused" : `dsh-notified: notified "${title}"`);
      return;
    }
    ctx.logger.warn(`dsh-notified: delivery failed ${explainFailure(outcome, channel.platform)}`);
  };

  const enqueue = (batch) => {
    if (config.coalesceMs > 0 && pending !== null) {
      // Fold into the batch already waiting: one notification for the whole
      // burst rather than a stack of them for each auto-continued turn.
      pending.count += 1;
      pending.turnDurationMs += batch.turnDurationMs;
      return;
    }
    if (config.coalesceMs > 0) {
      pending = batch;
      pendingTimer = setTimeout(flushPending, config.coalesceMs);
      if (typeof pendingTimer.unref === "function") pendingTimer.unref();
      return;
    }
    void deliver(batch);
  };

  ctx.on("session/event", (session, event) => {
    // Defensive: a future runtime could hand a session without a header.
    const header = session?.header;
    if (header === undefined) return;
    const id = header.id;
    const state = sessions.get(id);

    if (event.type === "turn/end") {
      const decision = decideTurnEnd({ state, event, header, config });
      sessions.delete(id);
      if (!decision.notify) {
        // `unknown-turn` is an expected condition (a resumed session's inherited
        // history, or a settle that arrived after disposal), so it is not noise
        // worth reporting on every occurrence.
        if (decision.reason !== "unknown-turn") {
          log("info", `dsh-notified: skipped turn ${event.data?.turn} of ${id} (${decision.reason})`);
        }
        return;
      }
      enqueue({
        count: 1,
        title: ctx.get("sessionTitle")?.get(session)?.title,
        cwd: decision.request.cwd,
        bodyText: decision.request.bodyText,
        turnDurationMs: decision.request.turnDurationMs,
      });
      return;
    }

    const next = foldTurnState(state, event);
    if (next === undefined) sessions.delete(id);
    else sessions.set(id, next);
  });

  ctx.on("session/disposed", (session) => {
    if (session?.header !== undefined) sessions.delete(session.header.id);
  });

  ctx.effect(() => () => {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    pending = null;
    sessions.clear();
    webHub.dispose();
  });

  // A manual trigger keeps the channel independently testable: the user can
  // confirm the notification works without waiting for a long turn to finish.
  ctx.inject(["tools"], (tctx) => {
    tctx.effect(() => tctx.tools.register(TEST_TOOL(config, () => registered, send, channel, webHub)));
  });
}
