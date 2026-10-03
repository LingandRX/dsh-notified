/**
 * Native Windows toast delivery for the DSH host process.
 *
 * The DSH host is spawned with `ELECTRON_RUN_AS_NODE=1`, so Electron's own
 * `Notification` class is unreachable from a plugin and the Web Notification
 * API lives in the renderer rather than here. The one channel available to a
 * host-side plugin is a Windows PowerShell 5.1 child running the WinRT toast
 * API, which this module builds and launches.
 *
 * Two details drive the shape of the code:
 *
 * - Windows PowerShell 5.1 (`System32\WindowsPowerShell\v1.0\powershell.exe`)
 *   is required. PowerShell 7 does not project the WinRT types this API needs,
 *   so the host PATH is never trusted to supply the interpreter.
 * - Every dynamic value travels as one Base64 payload decoded inside the
 *   child. Nothing is interpolated into the script text, so quotes, newlines,
 *   emoji, and non-Latin text cannot break the invocation or be re-parsed.
 *
 * One launch option is counter-intuitive and load-bearing: the child must NOT
 * be spawned detached. A detached child has no console, and Windows PowerShell
 * then abandons the WinRT script without raising anything — the process still
 * exits 0 while no notification is ever posted. {@link showToast} therefore
 * spawns a non-detached child and unrefs the handle instead.
 *
 * @module dsh-notified/toast
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** Application User Model Id the toast is attributed to. */
export const DEFAULT_APP_ID = "DeepSeek.Harness.Notified";

/**
 * Windows PowerShell's own registered AUMID, used when the branded identity is
 * unavailable. Its toast renders as "Windows PowerShell", which is why it is
 * only the second choice.
 */
export const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Process name the desktop application reports while its window is focused.
 * `Get-Process` reports the image name without its extension, so this is the
 * bare name rather than `DeepSeek Harness.exe`.
 */
export const DESKTOP_PROCESS_NAME = "DeepSeek Harness";

/** Exit code the child uses to report that focus suppression skipped the toast. */
export const EXIT_SUPPRESSED = 3;

/** Exit code the child uses to report that no toast API was reachable. */
export const EXIT_UNAVAILABLE = 4;

/** Exit code the child uses to report that the toast API rejected the toast. */
export const EXIT_REJECTED = 5;

/** Upper bound on a child's lifetime before it is killed, in milliseconds. */
const CHILD_TIMEOUT_MS = 15_000;

/** Package specifier used by {@link __} */
const POWERSHELL_RELATIVE = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Escape a string for use as XML text content.
 *
 * The toast is built as XML and parsed by the child, so unescaped `&` or `<`
 * from model output would otherwise make the whole document invalid.
 * @param input - raw text.
 * @returns text safe to place between XML tags.
 */
export function escapeXmlText(input) {
  return String(input)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * Escape a string for use as an XML attribute value.
 * @param input - raw text.
 * @returns text safe to place inside a double-quoted attribute.
 */
export function escapeXmlAttribute(input) {
  return escapeXmlText(input);
}

/**
 * Resolve the Windows PowerShell 5.1 executable.
 *
 * `%SystemRoot%` is used rather than the process PATH so a shadowing
 * `powershell.exe` (or a PowerShell 7 alias) cannot silently take over.
 * @param options - platform override and existence probe, for tests.
 * @returns the absolute interpreter path, or `undefined` when unavailable.
 */
export function resolvePowerShellPath(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    exists = existsSync,
  } = options;
  if (platform !== "win32") return undefined;
  const root = env.SystemRoot ?? env.windir;
  if (typeof root !== "string" || root.length === 0) return undefined;
  const candidate = win32.join(root, POWERSHELL_RELATIVE);
  return exists(candidate) ? candidate : undefined;
}

/**
 * Resolve the DeepSeek Harness application icon shipped beside the desktop app.
 *
 * The toast shows this icon only when it is referenced by the AUMID's
 * `IconUri`, so a missing file is reported as `undefined` rather than written
 * as a broken registry value.
 * @param options - environment and existence probe, for tests.
 * @returns the absolute icon path, or `undefined` when not found.
 */
export function resolveHarnessIcon(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    exists = existsSync,
    extra = [],
  } = options;
  if (platform !== "win32") return undefined;
  const roots = [];
  const local = env.LOCALAPPDATA;
  if (typeof local === "string" && local.length > 0) {
    roots.push(win32.join(local, "Programs", "DeepSeek Harness", "resources", "icon.png"));
  }
  roots.push(...extra);
  for (const candidate of roots) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Build the Toast XML document for one notification.
 *
 * `activationType="protocol"` with an `launch` URI is what makes a click on
 * the toast hand control back to the desktop app instead of doing nothing.
 * @param input - rendered title, body, and display options.
 * @returns the complete toast XML document.
 */
export function buildToastXml(input) {
  const {
    title,
    body,
    launch = "dsh://open",
    duration = "short",
    silent = true,
  } = input;
  const lines = [];
  lines.push(`<toast activationType="protocol" launch="${escapeXmlAttribute(launch)}" duration="${escapeXmlAttribute(duration)}">`);
  lines.push("  <visual>");
  lines.push('    <binding template="ToastGeneric">');
  lines.push(`      <text>${escapeXmlText(title)}</text>`);
  if (typeof body === "string" && body.length > 0) {
    lines.push(`      <text>${escapeXmlText(body)}</text>`);
  }
  lines.push("    </binding>");
  lines.push("  </visual>");
  if (silent) lines.push('  <audio silent="true"/>');
  lines.push("</toast>");
  return lines.join("\n");
}

/**
 * Build the complete PowerShell program that shows one toast.
 *
 * The payload is embedded as Base64 and decoded in the child, so no caller
 * value is ever concatenated into executable script text.
 * @param payload - the JSON-serializable facts the child needs.
 * @returns the PowerShell script source.
 */
export function buildPowerShellScript(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Read-DshNotifyPayload {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
  return ConvertFrom-Json $json
}

function Test-DshNotifyForeground {
  param([string[]] $Names)
  try {
    Add-Type -Namespace DshNotify -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
'@ -ErrorAction Stop
  } catch {
    # Without the P/Invoke binding the page status is unknown; treat the user
    # as away so the notification is still delivered.
    return $false
  }
  $handle = [DshNotify.Native]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { return $false }
  $owner = 0
  [void][DshNotify.Native]::GetWindowThreadProcessId($handle, [ref] $owner)
  if ($owner -eq 0) { return $false }
  $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  foreach ($name in $Names) {
    if ($process.ProcessName -eq $name) { return $true }
  }
  return $false
}

function Show-DshNotifyToast {
  param([string] $Xml, [string] $AppId)
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($Xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
  $notifier.Show($toast)
}

$payload = Read-DshNotifyPayload

if ($payload.suppressWhenFocused -and (Test-DshNotifyForeground -Names $payload.foregroundProcessNames)) {
  exit ${EXIT_SUPPRESSED}
}

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
} catch {
  [Console]::Error.WriteLine('dsh-notified: the WinRT toast API is unavailable on this system')
  exit ${EXIT_UNAVAILABLE}
}

try {
  Show-DshNotifyToast -Xml $payload.xml -AppId $payload.appId
  exit 0
} catch {
  [Console]::Error.WriteLine("dsh-notified: branded toast failed (" + $_.Exception.Message + ")")
}

if ($payload.fallbackAppId -and $payload.fallbackAppId -ne $payload.appId) {
  try {
    Show-DshNotifyToast -Xml $payload.xml -AppId $payload.fallbackAppId
    [Console]::Error.WriteLine('dsh-notified: delivered with the fallback application identity')
    exit 0
  } catch {
    [Console]::Error.WriteLine("dsh-notified: fallback toast failed (" + $_.Exception.Message + ")")
  }
}

exit ${EXIT_REJECTED}
`.trim();
}

/**
 * Encode a PowerShell program for `-EncodedCommand`.
 *
 * `-EncodedCommand` expects UTF-16LE Base64 and is the only invocation form
 * that is immune to quoting and code-page differences in the host environment.
 * @param script - PowerShell source.
 * @returns Base64 text for the child's command line.
 */
export function encodeCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Compose the arguments for one PowerShell toast invocation.
 * @param script - PowerShell source.
 * @returns the argument vector, excluding the executable.
 */
export function buildPowerShellArgs(script) {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(script)];
}

/**
 * Assemble the child payload from one notification request.
 * @param input - notification facts and delivery policy.
 * @returns the JSON-serializable child payload.
 */
export function buildPayload(input) {
  const {
    title,
    body,
    appId = DEFAULT_APP_ID,
    fallbackAppId = POWERSHELL_APP_ID,
    launch = "dsh://open",
    duration = "short",
    silent = true,
    suppressWhenFocused = false,
    foregroundProcessNames = [DESKTOP_PROCESS_NAME],
  } = input;
  return {
    xml: buildToastXml({ title, body, launch, duration, silent }),
    appId,
    fallbackAppId,
    suppressWhenFocused,
    foregroundProcessNames,
  };
}

/**
 * Register the branded Application User Model Id under `HKCU`.
 *
 * A toast attributed to an unregistered id renders without a name or icon, so
 * this is what makes the notification read as "DeepSeek Harness". The key is
 * per-user, needs no elevation, and is idempotent; `reg.exe` is used because it
 * is a single fast call and cannot be blocked by execution policy.
 * @param input - identity to register and the effect used to write it.
 * @returns the outcome, or a failure description.
 */
export function registerAumid(input) {
  const {
    appId = DEFAULT_APP_ID,
    displayName = "DeepSeek Harness",
    iconUri,
    platform = process.platform,
    run = execFileSync,
  } = input;
  if (platform !== "win32") return { ok: false, reason: "not-windows" };
  const key = `HKCU\\SOFTWARE\\Classes\\AppUserModelId\\${appId}`;
  const writes = [["/v", "DisplayName", "/t", "REG_SZ", "/d", displayName]];
  if (typeof iconUri === "string" && iconUri.length > 0) {
    writes.push(["/v", "IconUri", "/t", "REG_SZ", "/d", iconUri]);
  }
  try {
    for (const write of writes) {
      run("reg.exe", ["add", key, ...write, "/f"], { stdio: "ignore", windowsHide: true });
    }
    return { ok: true, key };
  } catch (error) {
    return { ok: false, reason: "reg-failed", error };
  }
}

/**
 * Delete the branded identity this plugin registered.
 * @param input - identity to remove and the effect used to delete it.
 * @returns the outcome, or a failure description.
 */
export function unregisterAumid(input) {
  const {
    appId = DEFAULT_APP_ID,
    platform = process.platform,
    run = execFileSync,
  } = input;
  if (platform !== "win32") return { ok: false, reason: "not-windows" };
  const key = `HKCU\\SOFTWARE\\Classes\\AppUserModelId\\${appId}`;
  try {
    run("reg.exe", ["delete", key, "/f"], { stdio: "ignore", windowsHide: true });
    return { ok: true, key };
  } catch (error) {
    return { ok: false, reason: "reg-failed", error };
  }
}

/**
 * Send one notification through a Windows PowerShell child.
 *
 * The returned promise settles with the child's outcome, but callers on the
 * conversation path deliberately do not await it: a notification must never add
 * latency to, or fail, the turn that triggered it.
 * @param input - notification facts, delivery policy, and launcher seams.
 * @returns the delivery outcome.
 */
export function showToast(input) {
  const {
    platform = process.platform,
    spawnImpl = spawn,
    powershell,
    timeoutMs = CHILD_TIMEOUT_MS,
    env = process.env,
    exists = existsSync,
  } = input;
  if (platform !== "win32") return Promise.resolve({ ok: false, reason: "not-windows" });
  const executable = powershell ?? resolvePowerShellPath({ platform, env, exists });
  if (executable === undefined) return Promise.resolve({ ok: false, reason: "no-powershell" });

  const payload = buildPayload(input);
  const args = buildPowerShellArgs(buildPowerShellScript(payload));

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(executable, args, {
        // Not detached, and this is load-bearing: a detached child is created
        // without a console, and Windows PowerShell then aborts the WinRT toast
        // script without reporting anything, so `detached: true` yields a clean
        // exit code and no notification. Measured against the toast history,
        // only a non-detached child actually delivers.
        detached: false,
        // windowsHide stops a console window from flashing over the user's work.
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, reason: "spawn-failed", error });
      return;
    }

    let stderr = "";
    let settled = false;
    let timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    // Bounds the child's lifetime so a hung interpreter cannot leak a process.
    // The handle is deliberately NOT unref'd: an unref'd child lets the event
    // loop drain while `close` is still pending, which would strand this
    // promise forever in a short-lived script. The child completes in well
    // under a second, so a caller that does await it pays a bounded cost.
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A child that already exited needs no cleanup.
      }
      finish({ ok: false, reason: "timeout", stderr });
    }, timeoutMs);
    // The safety net itself must never hold the host open; the child below
    // already keeps the loop alive until `close` fires.
    if (typeof timer.unref === "function") timer.unref();

    child.stderr?.on("data", (chunk) => {
      // Bounded so a noisy child cannot grow memory without limit.
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.on("error", (error) => finish({ ok: false, reason: "spawn-failed", error }));
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, suppressed: false, code, stderr });
        return;
      }
      if (code === EXIT_SUPPRESSED) {
        finish({ ok: true, suppressed: true, code, stderr });
        return;
      }
      finish({ ok: false, reason: code === EXIT_UNAVAILABLE ? "unavailable" : "rejected", code, stderr });
    });
  });
}
