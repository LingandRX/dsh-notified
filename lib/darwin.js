/**
 * The macOS half of dsh-notified: the notification channel and its helper app.
 *
 * A Windows toast can be posted by any process; a macOS notification cannot.
 * The system's `UserNotifications` framework will only accept a poster that is
 * a real application bundle registered with LaunchServices, so this module owns
 * the lifecycle of one: it compiles `macos/main.swift` into a small `.app`
 * under the user's Application Support directory, starts it through `open`, and
 * then talks to it over a Unix domain socket.
 *
 * Three constraints shape the design, each verified against macOS 27:
 *
 * - **The helper must be started by LaunchServices, not merely exec'd.** A child
 *   process spawned directly from Node is not recognised as an application
 *   instance: the notification daemon logs `Failed to find or validate client of
 *   identifier <id> with audit token …` and `requestAuthorization` returns
 *   "Notifications are not allowed for this application" without ever showing a
 *   prompt. Starting the bundle with `open` teaches the daemon the bundle path
 *   behind the identifier, after which it is a first-class client that can ask
 *   the user for permission.
 *
 * - **Bundle location matters as much as invocation.** A bundle under `/tmp`
 *   fails with `sandbox_extension_issue_file_to_process failed … Operation not
 *   permitted` and never becomes a client, which is exactly the failure
 *   `terminal-notifier` exhibits when run from a temporary directory. The helper
 *   therefore always lives in Application Support.
 *
 * - **`open` gives the parent no pipe.** Since the parent cannot hand the child
 *   a stdin, requests travel over a Unix socket that the helper listens on. That
 *   keeps the LaunchServices-owned launch *and* a request/reply channel.
 *
 * The outcome contract is deliberately identical to `lib/toast.js`: `ok`,
 * `suppressed` for a focus-policy skip, and exit codes 3 / 4 / 5 mirrored as
 * `code` so `lib/index.js` can treat both platforms the same way.
 *
 * @module dsh-notified/darwin
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Application identity the notification is attributed to. */
export const DEFAULT_BUNDLE_ID = "com.deepseek.dsh-notified";

/** Name shown on the banner and in System Settings. */
export const DEFAULT_APP_NAME = "DeepSeek Harness";

/** Name of the compiled helper inside the `.app`. */
export const HELPER_EXECUTABLE = "dsh-notified";

/** Exit codes, mirroring lib/toast.js so both platforms read the same. */
export const EXIT_SUPPRESSED = 3;
export const EXIT_UNAVAILABLE = 4;
export const EXIT_REJECTED = 5;

/** How long one request may take before the channel is declared broken. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** How long to wait for the helper's socket to appear after launching it. */
export const READY_TIMEOUT_MS = 10_000;

/** Lowest macOS the compiled helper targets, also its `LSMinimumSystemVersion`. */
export const MIN_SYSTEM_VERSION = "13.0";

/** The name of the socket file the helper listens on. */
export const SOCKET_NAME = "helper.sock";

/**
 * Escape a string for use inside an XML plist value.
 *
 * The values here are ours (a bundle id and a product name) rather than caller
 * input, but the plist is written as text and must stay well-formed for any
 * configured name, so escaping is unconditional.
 * @param input - raw text.
 * @returns the text with plist-significant characters escaped.
 */
export function escapePlistText(input) {
  return String(input)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/**
 * Build the helper bundle's `Info.plist`.
 *
 * `LSUIElement` is what keeps the helper out of the Dock and the app switcher:
 * it is a background agent that only ever exists to post notifications.
 * `NSPrincipalClass` is required for AppKit to start an `NSApplication`, which
 * the notification centre needs in order to deliver a click back to us.
 * @param input - identity and version facts.
 * @returns the plist document as text.
 */
export function buildInfoPlist(input = {}) {
  const {
    bundleId = DEFAULT_BUNDLE_ID,
    appName = DEFAULT_APP_NAME,
    version = "0.1.0",
    executable = HELPER_EXECUTABLE,
    minSystemVersion = MIN_SYSTEM_VERSION,
  } = input;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key><string>${escapePlistText(bundleId)}</string>
\t<key>CFBundleName</key><string>${escapePlistText(appName)}</string>
\t<key>CFBundleDisplayName</key><string>${escapePlistText(appName)}</string>
\t<key>CFBundleExecutable</key><string>${escapePlistText(executable)}</string>
\t<key>CFBundlePackageType</key><string>APPL</string>
\t<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
\t<key>CFBundleShortVersionString</key><string>${escapePlistText(version)}</string>
\t<key>CFBundleVersion</key><string>${escapePlistText(version)}</string>
\t<key>LSMinimumSystemVersion</key><string>${escapePlistText(minSystemVersion)}</string>
\t<key>LSUIElement</key><true/>
\t<key>NSPrincipalClass</key><string>NSApplication</string>
\t<key>CFBundleIconFile</key><string>icon.icns</string>
</dict>
</plist>
`;
}

/**
 * Parse one JSON reply line from the helper.
 *
 * The helper answers every request with exactly one line, so this is the whole
 * reply protocol. A malformed line is reported rather than thrown: the caller is
 * a notification path that must never raise into the conversation.
 * @param line - one line read from the socket.
 * @returns the parsed reply, or `undefined` when the line is not an object.
 */
export function parseReply(line) {
  const text = String(line).trim();
  if (text.length === 0) return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Translate a helper reply into the channel's outcome shape.
 * @param reply - a parsed reply, or `undefined` when none arrived.
 * @returns the outcome `lib/index.js` understands.
 */
export function outcomeOf(reply) {
  if (reply === undefined) return { ok: false, reason: "bad-reply" };
  if (reply.ok === true) {
    return {
      ok: true,
      suppressed: reply.suppressed === true,
      code: typeof reply.code === "number" ? reply.code : 0,
    };
  }
  // The exit code is a fallback for the reason, not decoration: `lib/toast.js`
  // reads the Windows child's exit code the same way, and a reply that carries
  // only a code must still be classified as "unavailable" rather than lumped
  // into the generic rejection.
  const code = typeof reply.code === "number" ? reply.code : EXIT_REJECTED;
  const reason = typeof reply.reason === "string" && reply.reason.length > 0
    ? reply.reason
    : code === EXIT_UNAVAILABLE ? "unavailable" : code === EXIT_SUPPRESSED ? "suppressed" : "rejected";
  return {
    ok: false,
    reason,
    code,
    detail: typeof reply.detail === "string" ? reply.detail : undefined,
  };
}

/**
 * Decide whether the helper has to be compiled.
 *
 * The bundle is rebuilt when it is absent, and also when the Swift source is
 * newer than the compiled binary — otherwise editing the helper would silently
 * keep running the old one.
 * @param input - presence and modification facts.
 * @returns whether a build is needed, and why.
 */
export function planHelperBuild(input = {}) {
  const { binaryExists, sourceMtimeMs, binaryMtimeMs } = input;
  if (binaryExists !== true) return { needed: true, reason: "missing" };
  if (Number.isFinite(sourceMtimeMs) && Number.isFinite(binaryMtimeMs) && sourceMtimeMs > binaryMtimeMs) {
    return { needed: true, reason: "stale" };
  }
  return { needed: false, reason: "current" };
}

/**
 * Compose the arguments for the Swift compile.
 *
 * `-target` is not optional. `swiftc` defaults to a target matching the
 * *installed SDK*, which on this machine is macOS 28 while the system running it
 * is 27; LaunchServices then refuses the result with `kLSIncompatibleSystemVersionErr`
 * ("Application being launched requires conditional 28.0"). Pinning the target
 * below the running OS makes the bundle launchable everywhere it claims to be.
 *
 * When the resolved compiler is `xcrun` rather than `swiftc`, the tool name is
 * part of the argument vector: `xcrun` is a dispatcher, so the bare `swiftc`
 * flags would be read as `xcrun`'s own options and rejected with "unrecognized
 * option: -O". This keeps the command-line-tools shim usable as a fallback.
 * @param input - the paths involved, and the compiler that will run them.
 * @returns the argument vector for the compiler.
 */
export function buildSwiftArgs(input = {}) {
  const {
    source,
    output,
    target = `arm64-apple-macosx${MIN_SYSTEM_VERSION}`,
    compiler = "/usr/bin/swiftc",
  } = input;
  const args = ["-O", "-target", target, "-o", output, source];
  return compiler.endsWith("xcrun") ? ["swiftc", ...args] : args;
}

/** The root directory the helper lives under. */
export function helperRoot(env = process.env) {
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, "Library", "Application Support", "dsh-notified");
}

/** The helper `.app` path. */
export function helperAppPath(root) {
  return join(root, "DSHNotify.app");
}

/**
 * The socket the helper listens on.
 *
 * The path is kept beside the bundle rather than in `/tmp`: a bundle in a
 * temporary directory is refused by the notification sandbox, and keeping the
 * two together means a relocated install stays self-contained. A Unix socket
 * path is limited to roughly 104 bytes, which a deeply nested home directory
 * could exceed, so an over-long path falls back to a short one in the temporary
 * directory — where only the *socket* lives, never the bundle.
 * @param root - the helper root directory.
 * @param env - environment, for the fallback location.
 * @returns an absolute socket path within the platform limit.
 */
export function helperSocketPath(root, env = process.env) {
  const candidate = join(root, SOCKET_NAME);
  if (Buffer.byteLength(candidate, "utf8") < 100) return candidate;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const tmp = env.TMPDIR !== undefined && env.TMPDIR.length > 0 ? env.TMPDIR : "/tmp";
  // The root is folded into the name as a short digest: two relocated installs
  // for the same user would otherwise share one socket path and one could talk
  // to the other's helper.
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(tmp, `dsh-notified-${uid}-${digest}.sock`);
}

/**
 * Locate the Swift source shipped with this plugin.
 * @param overrides - a path override, and an existence check for tests.
 * @returns the absolute path to `macos/main.swift`.
 */
export function swiftSourcePath(overrides = {}) {
  if (typeof overrides.source === "string" && overrides.source.length > 0) return overrides.source;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(dirname(here), "macos", "main.swift");
}

/**
 * The compiler to use.
 *
 * The absolute path is preferred over `PATH` so a shell that hides
 * `/usr/bin/swiftc` cannot silently disable notifications; the command-line
 * tools shim is accepted as a fallback.
 * @param overrides - an explicit path, an environment, and an existence check.
 * @returns the compiler path, or `undefined` when none is installed.
 */
export function resolveSwiftc(overrides = {}) {
  if (typeof overrides.swiftc === "string" && overrides.swiftc.length > 0) return overrides.swiftc;
  const exists = overrides.exists ?? existsSync;
  for (const candidate of ["/usr/bin/swiftc", "/usr/bin/xcrun"]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Find the running application's own icon to brand the banner with.
 *
 * On macOS a notification's icon always comes from the posting bundle, so the
 * way to show the Harness mark is to copy its `.icns` into our bundle. The
 * running application is asked first (it is the install actually in use), then
 * the standard location.
 * @param overrides - an environment, an existence check, and a path override.
 * @returns the icon path, or `undefined` when none is found.
 */
export function resolveHarnessIconDarwin(overrides = {}) {
  if (typeof overrides.iconPath === "string" && overrides.iconPath.length > 0) {
    const exists = overrides.exists ?? existsSync;
    return exists(overrides.iconPath) ? overrides.iconPath : undefined;
  }
  const exists = overrides.exists ?? existsSync;
  const candidates = ["/Applications/DeepSeek Harness.app/Contents/Resources/icon.icns"];
  // A bundle outside /Applications is still discoverable from the running
  // process, which knows its own location.
  if (typeof process.execPath === "string" && process.execPath.includes(".app/Contents/MacOS/")) {
    candidates.unshift(join(dirname(dirname(process.execPath)), "Resources", "icon.icns"));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Everything needed to build one helper, resolved up front.
 *
 * Split out from the compile itself so the decision — where the bundle goes,
 * which compiler, which icon, whether a rebuild is even due — is testable
 * without touching the disk.
 * @param overrides - path, environment, and probe overrides.
 * @returns the resolved plan.
 */
/**
 * The modification time of a path, or `undefined` when it cannot be read.
 *
 * Used as the staleness probe: an unreadable time is deliberately reported as
 * "unknown" rather than as zero or now, so a transient failure can never look
 * like a stale build and trigger a compile on every notification.
 * @param path - the file to inspect.
 * @returns the mtime in milliseconds, or `undefined`.
 */
export function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function resolution(overrides = {}) {
  const env = overrides.env ?? process.env;
  const exists = overrides.exists ?? existsSync;
  const root = overrides.root ?? helperRoot(env);
  const app = overrides.app ?? helperAppPath(root);
  const binary = join(app, "Contents", "MacOS", HELPER_EXECUTABLE);
  const source = swiftSourcePath(overrides);
  // The default probe must actually read the disk. Returning a constant here
  // would make the "stale" verdict unreachable, so editing macos/main.swift
  // would keep running the previous helper forever.
  const stat = overrides.statMtime ?? mtimeOf;
  return {
    env,
    root,
    app,
    binary,
    plist: join(app, "Contents", "Info.plist"),
    icon: join(app, "Contents", "Resources", "icon.icns"),
    source,
    socket: overrides.socket ?? helperSocketPath(root, env),
    swiftc: resolveSwiftc(overrides),
    harnessIcon: resolveHarnessIconDarwin(overrides),
    plan: planHelperBuild({
      binaryExists: exists(binary),
      sourceMtimeMs: stat(source),
      binaryMtimeMs: stat(binary),
    }),
  };
}

/**
 * Copy the branding icon into a built bundle, if one is available.
 *
 * A missing icon is not an error: the banner simply falls back to the generic
 * application icon, which is better than refusing to notify.
 * @param target - the bundle plan.
 * @returns whether an icon was installed.
 */
function installIcon(target) {
  if (target.harnessIcon === undefined) return false;
  try {
    mkdirSync(dirname(target.icon), { recursive: true });
    copyFileSync(target.harnessIcon, target.icon);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile the helper into its bundle.
 *
 * A compiled binary must be executable for LaunchServices to accept the bundle,
 * and the ad-hoc signature is applied last so it covers the final bytes. The
 * signature is deliberately ad-hoc (`-`): the helper needs no entitlements
 * beyond what any user application has, and requiring a Developer ID would make
 * the plugin useless without a paid certificate.
 * @param input - the resolved plan, plus process seams for tests.
 * @returns `{ ok, reason, detail }`.
 */
export function buildHelper(input = {}) {
  const target = input.target ?? resolution(input);
  const run = input.runImpl ?? spawnSync;
  const log = input.logImpl ?? (() => {});

  if (target.swiftc === undefined) return { ok: false, reason: "no-swiftc" };
  if (target.source === undefined || !(input.exists ?? existsSync)(target.source)) {
    return { ok: false, reason: "no-source" };
  }

  try {
    mkdirSync(join(target.app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(target.app, "Contents", "Resources"), { recursive: true });
    writeFileSync(
      target.plist,
      buildInfoPlist({
        bundleId: input.bundleId ?? DEFAULT_BUNDLE_ID,
        appName: input.appName ?? DEFAULT_APP_NAME,
        version: input.version ?? "0.1.0",
        executable: HELPER_EXECUTABLE,
      }),
      "utf8",
    );
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: String(error?.message ?? error) };
  }

  // Remove a previous binary first: an interrupted compile otherwise leaves a
  // truncated file that `swiftc` may refuse to overwrite.
  try {
    rmSync(target.binary, { force: true });
  } catch {
    /* A missing binary is the expected case. */
  }

  const args = buildSwiftArgs({ source: target.source, output: target.binary, compiler: target.swiftc });
  log(`dsh-notified: compiling the macOS helper (${target.swiftc})`);
  const result = run(target.swiftc, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, reason: "no-swiftc", detail: String(result.error.message ?? result.error) };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim().split("\n").slice(0, 4).join(" ").slice(0, 512);
    return { ok: false, reason: "compile-failed", detail };
  }
  if (!(input.exists ?? existsSync)(target.binary)) return { ok: false, reason: "compile-failed", detail: "no binary produced" };

  try {
    chmodSync(target.binary, 0o755);
  } catch {
    /* The compiler already produced an executable. */
  }

  installIcon(target);

  // Signing is best-effort: an unsigned bundle still delivers notifications,
  // it just cannot be granted a time-sensitive interruption level.
  const signed = run("/usr/bin/codesign", ["--force", "-s", "-", target.app], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (signed.status !== 0) log("dsh-notified: ad-hoc signing failed; continuing unsigned");

  // Registering the bundle is what lets the notification daemon resolve the
  // bundle identifier to a path. Without it the first launch can be refused as
  // an unknown client.
  const register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if ((input.exists ?? existsSync)(register)) {
    run(register, ["-f", target.app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  return { ok: true, reason: "built" };
}

/**
 * The install step, run at most once per process.
 *
 * Compiling takes about half a second, which is short but not free, and the
 * result never changes while the plugin is loaded — so the promise is cached and
 * every caller awaits the same work.
 * @param overrides - resolution overrides plus the build seam.
 * @returns `{ ok, reason, detail }` for the install.
 */
let installPromise;
export function ensureHelper(overrides = {}, force = false) {
  if (force) installPromise = undefined;
  if (installPromise !== undefined) return installPromise;
  installPromise = (async () => {
    const target = resolution(overrides);
    if (!target.plan.needed) {
      // A bundle that exists is still registered, so a reinstall or a move is
      // picked up without a rebuild.
      const register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      if ((overrides.exists ?? existsSync)(register)) {
        (overrides.runImpl ?? spawnSync)(register, ["-f", target.app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      }
      return { ok: true, reason: "current" };
    }
    return buildHelper({ ...overrides, target });
  })();
  return installPromise;
}

/**
 * Launch the helper so LaunchServices adopts it as an application.
 *
 * `-g` matters: without it `open` would bring the helper to the foreground,
 * which both steals focus from the user and makes the helper itself the
 * frontmost application — so the focus policy would then see a foreground app
 * that is not the Harness and notify despite the user looking at it.
 * @param input - the bundle path, plus process seams.
 * @returns whether the launch command reported success.
 */
export function launchHelper(input = {}) {
  const run = input.runImpl ?? spawnSync;
  const result = run("/usr/bin/open", ["-g", "-a", input.app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined && result.error !== null) return { ok: false, detail: String(result.error.message ?? result.error) };
  if (result.status !== 0) {
    return { ok: false, detail: String(result.stderr ?? "").trim().slice(0, 512) };
  }
  return { ok: true };
}

/**
 * Wait for a socket file to accept a connection.
 * @param input - the socket path, a deadline, and a connect seam.
 * @returns whether the socket became reachable.
 */
export function waitForSocket(input = {}) {
  const { path, timeoutMs = READY_TIMEOUT_MS, connectImpl = net.connect } = input;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = connectImpl({ path });
      let settled = false;
      const done = (reachable) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners?.();
        try {
          socket.destroy();
        } catch {
          /* Already gone. */
        }
        if (reachable) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 100);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout?.(500, () => done(false));
    };
    attempt();
  });
}

/**
 * Send one newline-delimited JSON request and read the single reply line.
 *
 * The bounded timeout is the whole reason this returns an outcome instead of
 * rejecting: a hung helper must degrade into "delivery failed" rather than
 * leaving a promise wedged in the notification path forever.
 * @param input - the socket path, the request, and process seams.
 * @returns the outcome for one request.
 */
export function sendRequest(input = {}) {
  const {
    path,
    request,
    timeoutMs = REQUEST_TIMEOUT_MS,
    connectImpl = net.connect,
  } = input;

  return new Promise((resolve) => {
    let settled = false;
    const socket = connectImpl({ path });
    let buffer = "";

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* Already closed. */
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    socket.setEncoding?.("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finish(outcomeOf(parseReply(buffer.slice(0, newline))));
    });
    socket.on("error", (error) => finish({ ok: false, reason: "unavailable", detail: String(error?.message ?? error) }));
    socket.on("close", () => finish({ ok: false, reason: "unavailable", detail: "the helper closed the connection" }));
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        finish({ ok: false, reason: "unavailable", detail: String(error?.message ?? error) });
      }
    });
  });
}

/**
 * Build the request the helper understands from the plugin's notification shape.
 *
 * `foregroundBundleIds` carries both the configured names and the desktop
 * application's bundle identifier, because the shared configuration defaults to
 * the Windows-facing product name ("DeepSeek Harness") while macOS reports a
 * bundle identifier ("com.deepseek.dsh"). Accepting either keeps one setting
 * meaningful on both platforms.
 * @param input - the notification request.
 * @returns the helper request payload.
 */
export function buildRequest(input = {}) {
  const {
    title = "",
    body = "",
    launch = "dsh://open",
    duration = "short",
    silent = true,
    suppressWhenFocused = false,
    foregroundProcessNames = [],
    group,
    id,
    bundleId = DEFAULT_BUNDLE_ID,
  } = input;
  const names = Array.isArray(foregroundProcessNames) ? foregroundProcessNames : [];
  const identifiers = new Set(names);
  // The application's own identity is always treated as "the app is focused",
  // even if the operator only configured the Windows-facing name.
  identifiers.add(bundleId);
  identifiers.add("com.deepseek.dsh");
  return {
    kind: "notify",
    id: id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(title),
    body: String(body),
    launch: String(launch),
    duration: String(duration),
    sound: silent !== true,
    suppressWhenFocused: suppressWhenFocused === true,
    foregroundBundleIds: [...identifiers].filter((value) => typeof value === "string" && value.length > 0),
    group: typeof group === "string" ? group : undefined,
  };
}

/**
 * Post one notification on macOS, starting the helper when needed.
 *
 * This is the macOS counterpart of `showToast` in `lib/toast.js` and returns the
 * same outcome shape, so the plugin's delivery path needs no branching beyond
 * picking the function.
 * @param input - the notification request, plus seams for tests.
 * @returns `{ ok, suppressed, code }` or `{ ok: false, reason, detail }`.
 */
export async function showMacToast(input = {}) {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin") return { ok: false, reason: "not-darwin" };

  const target = resolution(input);
  if (target.swiftc === undefined && !(input.exists ?? existsSync)(target.binary)) {
    return { ok: false, reason: "no-swiftc" };
  }

  const install = await (input.ensureImpl ?? ensureHelper)(input);
  if (!install.ok) {
    return { ok: false, reason: install.reason === "compile-failed" ? "compile-failed" : "helper-failed", detail: install.detail };
  }

  const request = input.request ?? buildRequest({ bundleId: input.bundleId, ...input });
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // A live helper is the common case; only launch one when the socket is cold.
  const reachable = await (input.waitImpl ?? waitForSocket)({ path: target.socket, timeoutMs: 250, connectImpl: input.connectImpl });
  if (!reachable) {
    const launched = (input.launchImpl ?? launchHelper)({ app: target.app, runImpl: input.runImpl });
    if (!launched.ok) return { ok: false, reason: "launch-failed", detail: launched.detail };
    const ready = await (input.waitImpl ?? waitForSocket)({
      path: target.socket,
      timeoutMs: input.readyTimeoutMs ?? READY_TIMEOUT_MS,
      connectImpl: input.connectImpl,
    });
    if (!ready) return { ok: false, reason: "helper-timeout" };
  }

  return (input.sendImpl ?? sendRequest)({ path: target.socket, request, timeoutMs, connectImpl: input.connectImpl });
}

/**
 * Remove the compiled helper and its socket.
 *
 * Exposed for an operator removing the plugin: the bundle sits in a durable
 * location, so uninstalling the bundle alone would leave it behind.
 * @param overrides - resolution overrides.
 * @returns whether the directory was removed.
 */
export function uninstallHelper(overrides = {}) {
  const target = resolution(overrides);
  try {
    rmSync(target.root, { recursive: true, force: true });
    return { ok: true, root: target.root };
  } catch (error) {
    return { ok: false, reason: "remove-failed", detail: String(error?.message ?? error) };
  }
}

/** List the helper's installed files, for diagnostics. */
export function describeInstall(overrides = {}) {
  const target = resolution(overrides);
  const exists = overrides.exists ?? existsSync;
  let files = [];
  try {
    files = readdirSync(target.root);
  } catch {
    files = [];
  }
  return {
    root: target.root,
    app: target.app,
    socket: target.socket,
    built: exists(target.binary),
    source: target.source,
    icon: target.harnessIcon,
    files,
  };
}
