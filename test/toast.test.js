import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXIT_REJECTED,
  EXIT_SUPPRESSED,
  EXIT_UNAVAILABLE,
  buildPayload,
  buildPowerShellArgs,
  buildPowerShellScript,
  buildToastXml,
  encodeCommand,
  escapeXmlText,
  registerAumid,
  resolveHarnessIcon,
  resolvePowerShellPath,
  showToast,
  unregisterAumid,
} from "../lib/toast.js";

/** Read the JSON payload the script will decode inside the child. */
function payloadOf(script) {
  const match = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(script);
  assert.ok(match, "the script must embed one Base64 payload");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

test("escapeXmlText neutralizes every markup-significant character", () => {
  assert.equal(escapeXmlText("a & b < c > d \" e ' f"), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
});

test("escapeXmlText escapes the ampersand exactly once", () => {
  assert.equal(escapeXmlText("&amp;"), "&amp;amp;");
});

test("buildToastXml produces a protocol-activated toast", () => {
  const xml = buildToastXml({ title: "Title", body: "Body" });
  assert.ok(xml.includes('activationType="protocol"'));
  assert.ok(xml.includes('launch="dsh://open"'));
  assert.ok(xml.includes("<text>Title</text>"));
  assert.ok(xml.includes("<text>Body</text>"));
});

test("buildToastXml escapes caller text so the document stays valid", () => {
  const xml = buildToastXml({ title: "a & b", body: "<script>" });
  assert.ok(xml.includes("<text>a &amp; b</text>"));
  assert.ok(xml.includes("<text>&lt;script&gt;</text>"));
  assert.ok(!xml.includes("<script>"));
});

test("buildToastXml omits an empty body and adds silent audio on request", () => {
  const xml = buildToastXml({ title: "T", body: "", silent: true });
  assert.equal(xml.match(/<text>/gu).length, 1);
  assert.ok(xml.includes('<audio silent="true"/>'));
  assert.ok(!buildToastXml({ title: "T", body: "B", silent: false }).includes("<audio"));
});

test("buildToastXml carries the requested duration and launch target", () => {
  const xml = buildToastXml({ title: "T", body: "B", duration: "long", launch: "dsh://focus" });
  assert.ok(xml.includes('duration="long"'));
  assert.ok(xml.includes('launch="dsh://focus"'));
});

test("encodeCommand emits UTF-16LE Base64 that round-trips", () => {
  const script = "$x = '值'; Write-Output $x";
  const decoded = Buffer.from(encodeCommand(script), "base64").toString("utf16le");
  assert.equal(decoded, script);
});

test("buildPowerShellArgs pins the invocation-immune flags", () => {
  const args = buildPowerShellArgs("Write-Output 1");
  assert.deepEqual(args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
  assert.equal(args[5], "-EncodedCommand");
  assert.equal(Buffer.from(args[6], "base64").toString("utf16le"), "Write-Output 1");
});

test("the generated script embeds the payload without interpolating it into code", () => {
  const hostile = "x'; Remove-Item -Recurse C:\\; #";
  const script = buildPowerShellScript(buildPayload({ title: hostile, body: hostile }));
  assert.ok(!script.includes("Remove-Item"), "caller text must not reach the script body");
  const payload = payloadOf(script);
  assert.ok(payload.xml.includes("Remove-Item"));
});

test("the generated script routes each outcome to its exit code", () => {
  const script = buildPowerShellScript(buildPayload({ title: "t", body: "b" }));
  assert.ok(script.includes(`exit ${EXIT_SUPPRESSED}`));
  assert.ok(script.includes(`exit ${EXIT_UNAVAILABLE}`));
  assert.ok(script.includes(`exit ${EXIT_REJECTED}`));
});

test("buildPayload defaults the identity and focus policy", () => {
  const payload = buildPayload({ title: "t", body: "b" });
  assert.equal(payload.appId, "DeepSeek.Harness.Notified");
  assert.equal(payload.suppressWhenFocused, false);
  assert.deepEqual(payload.foregroundProcessNames, ["DeepSeek Harness"]);
  assert.ok(payload.fallbackAppId.includes("WindowsPowerShell"));
});

test("buildPayload honors an explicit focus policy", () => {
  const payload = buildPayload({ title: "t", body: "b", suppressWhenFocused: true, foregroundProcessNames: ["app"] });
  assert.equal(payload.suppressWhenFocused, true);
  assert.deepEqual(payload.foregroundProcessNames, ["app"]);
});

test("resolvePowerShellPath uses SystemRoot rather than the process PATH", () => {
  const resolved = resolvePowerShellPath({ platform: "win32", env: { SystemRoot: "C:\\Win" }, exists: () => true });
  assert.equal(resolved, "C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("resolvePowerShellPath returns undefined off Windows or when missing", () => {
  assert.equal(resolvePowerShellPath({ platform: "linux", env: { SystemRoot: "C:\\Win" }, exists: () => true }), undefined);
  assert.equal(resolvePowerShellPath({ platform: "win32", env: {}, exists: () => true }), undefined);
  assert.equal(resolvePowerShellPath({ platform: "win32", env: { SystemRoot: "C:\\Win" }, exists: () => false }), undefined);
});

test("resolveHarnessIcon probes the desktop install and returns a hit", () => {
  const icon = resolveHarnessIcon({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    exists: (p) => p.endsWith("icon.png"),
  });
  assert.equal(icon, "C:\\Users\\a\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\icon.png");
});

test("resolveHarnessIcon returns undefined when no candidate exists", () => {
  assert.equal(resolveHarnessIcon({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, exists: () => false }), undefined);
  assert.equal(resolveHarnessIcon({ platform: "darwin", env: {}, exists: () => true }), undefined);
});

test("registerAumid writes the display name and icon under HKCU", () => {
  const calls = [];
  const outcome = registerAumid({
    appId: "App.Id",
    displayName: "My App",
    iconUri: "C:\\icon.png",
    platform: "win32",
    run: (file, args) => calls.push([file, args]),
  });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "reg.exe");
  assert.deepEqual(calls[0][1].slice(0, 3), ["add", "HKCU\\SOFTWARE\\Classes\\AppUserModelId\\App.Id", "/v"]);
  assert.ok(calls[0][1].includes("DisplayName"));
  assert.ok(calls[1][1].includes("IconUri"));
});

test("registerAumid skips the icon value when none is available", () => {
  const calls = [];
  registerAumid({ platform: "win32", run: (file, args) => calls.push([file, args]) });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0][1].includes("IconUri"));
});

test("registerAumid reports a failed reg call instead of throwing", () => {
  const outcome = registerAumid({
    platform: "win32",
    run: () => {
      throw new Error("denied");
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "reg-failed");
});

test("registerAumid is a no-op off Windows", () => {
  assert.equal(registerAumid({ platform: "linux", run: () => assert.fail("must not run") }).reason, "not-windows");
});

test("unregisterAumid deletes the key and reports failure safely", () => {
  const calls = [];
  assert.equal(unregisterAumid({ platform: "win32", run: (f, a) => calls.push([f, a]) }).ok, true);
  assert.deepEqual(calls[0][1].slice(0, 2), ["delete", "HKCU\\SOFTWARE\\Classes\\AppUserModelId\\DeepSeek.Harness.Notified"]);
  assert.equal(
    unregisterAumid({
      platform: "win32",
      run: () => {
        throw new Error("missing");
      },
    }).reason,
    "reg-failed",
  );
});

/** Build a fake child whose `close` fires on the next tick with `code`. */
function fakeChild(code, options = {}) {
  const listeners = { close: [], error: [], data: [] };
  const child = {
    stderr: { on: (_event, handler) => listeners.data.push(handler) },
    on(event, handler) {
      if (event === "error") listeners.error.push(handler);
      if (event === "close") listeners.close.push(handler);
      return child;
    },
    kill() {
      child.killed = true;
    },
    killed: false,
  };
  process.nextTick(() => {
    if (options.stderr !== undefined) for (const handler of listeners.data) handler(options.stderr);
    if (options.emitError !== undefined) {
      for (const handler of listeners.error) handler(options.emitError);
      return;
    }
    for (const handler of listeners.close) handler(code);
  });
  return child;
}

/** Capture the spawn call and hand back a fake child. */
function spawnRecorder(child) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    return child;
  };
  return { calls, spawnImpl };
}

test("showToast is a no-op off Windows", async () => {
  assert.equal((await showToast({ platform: "linux", title: "t", body: "b" })).reason, "not-windows");
});

test("showToast reports a missing interpreter instead of spawning", async () => {
  const outcome = await showToast({ platform: "win32", powershell: undefined, env: {}, title: "t", body: "b" });
  assert.equal(outcome.reason, "no-powershell");
});

test("showToast spawns a non-detached, hidden child", async () => {
  const { calls, spawnImpl } = spawnRecorder(fakeChild(0));
  const outcome = await showToast({ platform: "win32", powershell: "C:\\ps.exe", spawnImpl, title: "t", body: "b" });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  // Detaching is load-bearing: a detached child has no console and PowerShell
  // then abandons the toast script while still exiting 0.
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsHide, true);
});

test("showToast maps each exit code onto its outcome", async () => {
  const run = async (code) => {
    const { spawnImpl } = spawnRecorder(fakeChild(code));
    return showToast({ platform: "win32", powershell: "C:\\ps.exe", spawnImpl, title: "t", body: "b" });
  };
  assert.equal((await run(0)).ok, true);
  assert.equal((await run(EXIT_SUPPRESSED)).suppressed, true);
  assert.equal((await run(EXIT_REJECTED)).reason, "rejected");
  assert.equal((await run(EXIT_UNAVAILABLE)).reason, "unavailable");
});

test("showToast surfaces child stderr on failure", async () => {
  const { spawnImpl } = spawnRecorder(fakeChild(EXIT_REJECTED, { stderr: "branded toast failed" }));
  const outcome = await showToast({ platform: "win32", powershell: "C:\\ps.exe", spawnImpl, title: "t", body: "b" });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.stderr.includes("branded toast failed"));
});

test("showToast reports a spawn failure rather than rejecting", async () => {
  const outcome = await showToast({
    platform: "win32",
    powershell: "C:\\ps.exe",
    spawnImpl: () => {
      throw new Error("EPERM");
    },
    title: "t",
    body: "b",
  });
  assert.equal(outcome.reason, "spawn-failed");
});

test("showToast reports an asynchronous child error", async () => {
  const { spawnImpl } = spawnRecorder(fakeChild(0, { emitError: new Error("gone") }));
  const outcome = await showToast({ platform: "win32", powershell: "C:\\ps.exe", spawnImpl, title: "t", body: "b" });
  assert.equal(outcome.reason, "spawn-failed");
});

test("showToast kills a child that never reports back", async () => {
  const child = fakeChild(0);
  child.on = () => child;
  const outcome = await showToast({
    platform: "win32",
    powershell: "C:\\ps.exe",
    spawnImpl: () => child,
    title: "t",
    body: "b",
    timeoutMs: 20,
  });
  assert.equal(outcome.reason, "timeout");
  assert.equal(child.killed, true);
});
