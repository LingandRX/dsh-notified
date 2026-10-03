/**
 * dsh-notified — Windows conversation-completion notifications for DSH.
 *
 * A profile bundle that watches sessions settle a turn and posts a native
 * Windows toast, so a user who switched away learns that the agent finished.
 * Clicking the toast hands focus back through the `dsh://open` protocol the
 * desktop application already registers.
 *
 * Design constraints, each verified against the running 0.2.0-rc.2 runtime:
 *
 * - The host process runs as Electron-with-`ELECTRON_RUN_AS_NODE`, so
 *   `electron` is not importable and its `Notification` class is out of reach.
 *   `lib/toast.js` owns the PowerShell/WinRT channel that replaces it.
 * - `turn/end` is the settlement signal; it is appended post-commit and carries
 *   `reason.kind`, so it distinguishes a real answer from an abort or an error.
 * - A turn that produces no assistant text (a pure tool round trip) is not a
 *   finished conversation, so it is tracked and skipped.
 * - Notification work must never appear on the conversation's critical path:
 *   delivery is launched as a child process and its promise is intentionally
 *   not awaited by the event listener.
 *
 * @module dsh-notified
 */

import z from "@deepseek-ai/schemastery";

import { composeBody, composeMergedSummary, composeTitle } from "./text.js";
import { decideTurnEnd, foldTurnState } from "./policy.js";
import { DEFAULT_APP_ID, registerAumid, resolveHarnessIcon, showToast } from "./toast.js";

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
    .description("Foreground process names that count as the app already being visible."),
  /** Merge window in milliseconds; multiple settlements inside it become one toast. */
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
  bodyMaxChars: z.number().default(140).description("Maximum characters in the toast body. The duration is reserved inside this budget."),
  /** Whether to append the turn's wall-clock duration. */
  showDuration: z.boolean().default(true).description("Append how long the turn took; the duration is reserved so truncation never drops it."),
  /** Application identity the toast is attributed to. */
  appId: z.string().default(DEFAULT_APP_ID).description("Application identity the toast is attributed to."),
  /** Register that identity under HKCU so the toast is branded. */
  registerAumid: z.boolean().default(true).description("Register the app identity so the toast shows the app name and icon."),
  /** Override the icon shown by the registered identity. */
  iconPath: z.string().default("").description("Icon path for the registered identity. Empty uses the app's own icon."),
  /** Deep link the toast opens when clicked. */
  launch: z.string().default("dsh://open").description("URI opened when the toast is clicked."),
  /** Toast display duration. */
  duration: z.string().default("short").description("Toast duration: short or long."),
  /** Whether the toast plays a sound. */
  sound: z.boolean().default(false).description("Play the notification sound."),
  /** Copy used when several turns are merged into one toast. */
  mergedTemplate: z.string().default("{count} conversations finished").description("Body for a merged notification; {count} is replaced."),
  /** Copy used when the reply text is empty. */
  emptyBody: z.string().default("Turn finished").description("Body used when there is no reply text to show."),
  /** Log the child's outcome for each delivery. */
  verbose: z.boolean().default(false).description("Log notification delivery details."),
});

/** Turn-settlement reasons that count as "the user is being waited on". */
export const INFORMATIVE_REASONS = new Set(["completed", "error", "interrupted"]);

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
 * @returns a registry-ready tool definition.
 */
function TEST_TOOL(config, isRegistered, send) {
  return {
    name: "dsh_notify_test",
    description: "Send a test desktop notification through dsh-notified to verify the Windows toast channel works.",
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
      const outcome = await send({
        title: typeof args.title === "string" && args.title.length > 0 ? args.title : "DeepSeek Harness",
        body: typeof args.body === "string" && args.body.length > 0 ? args.body : "dsh-notified test notification",
        appId: isRegistered() ? config.appId : undefined,
        launch: config.launch,
        duration: config.duration,
        silent: !config.sound,
        suppressWhenFocused: false,
        foregroundProcessNames: config.foregroundProcessNames,
      });
      return outcome.ok
        ? { delivered: true, detail: `Toast delivered${outcome.suppressed ? " (suppressed by focus policy)" : ""}.` }
        : { delivered: false, detail: `Toast failed: ${outcome.reason}${outcome.stderr ? ` (${outcome.stderr})` : ""}` };
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
  const send = overrides.showToast ?? showToast;
  const log = (level, ...args) => {
    if (level === "info" || config.verbose) ctx.logger[level](...args);
  };

  if (process.platform !== "win32") {
    ctx.logger.info("dsh-notified: not running on Windows; notifications stay idle");
    return;
  }

  let registered = false;
  if (config.registerAumid) {
    const icon = config.iconPath.length > 0 ? config.iconPath : resolveHarnessIcon();
    const outcome = registerAumid({ appId: config.appId, iconUri: icon });
    registered = outcome.ok;
    if (outcome.ok) {
      log("info", `dsh-notified: registered app identity ${config.appId}${icon ? ` with icon ${icon}` : ""}`);
    } else {
      ctx.logger.warn(`dsh-notified: could not register the app identity (${outcome.reason}); the toast will use the fallback identity`);
    }
  }

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

    const outcome = await send({
      title: title.length > 0 ? title : "DeepSeek Harness",
      body,
      appId: registered ? config.appId : undefined,
      launch: config.launch,
      duration: config.duration,
      silent: !config.sound,
      suppressWhenFocused: config.suppressWhenFocused,
      foregroundProcessNames: config.foregroundProcessNames,
    });

    if (outcome.ok) {
      log("info", outcome.suppressed ? "dsh-notified: skipped, the app is already focused" : `dsh-notified: notified "${title}"`);
      return;
    }
    ctx.logger.warn(`dsh-notified: delivery failed (${outcome.reason}${outcome.code === undefined ? "" : `, exit ${outcome.code}`})${outcome.stderr ? `: ${outcome.stderr}` : ""}`);
  };

  const enqueue = (batch) => {
    if (config.coalesceMs > 0 && pending !== null) {
      // Fold into the batch already waiting: one toast for the whole burst
      // rather than a stack of them for each auto-continued turn.
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
  });

  // A manual trigger keeps the channel independently testable: the user can
  // confirm the toast works without waiting for a long turn to finish.
  ctx.inject(["tools"], (tctx) => {
    tctx.effect(() => tctx.tools.register(TEST_TOOL(config, () => registered, send)));
  });
}
