import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_APP_NAME,
  DEFAULT_BUNDLE_ID,
  EXIT_REJECTED,
  EXIT_SUPPRESSED,
  EXIT_UNAVAILABLE,
  HELPER_EXECUTABLE,
  MIN_SYSTEM_VERSION,
  SOCKET_NAME,
  buildInfoPlist,
  buildRequest,
  buildSwiftArgs,
  escapePlistText,
  helperAppPath,
  helperRoot,
  helperSocketPath,
  mtimeOf,
  outcomeOf,
  parseReply,
  planHelperBuild,
  resolution,
  resolveHarnessIconDarwin,
  resolveSwiftc,
  showMacToast,
} from "../lib/darwin.js";

/** Read one `<key>K</key><string>V</string>` value out of a plist document. */
function plistValue(plist, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u").exec(plist);
  assert.ok(match, `Info.plist must carry ${key} as a string`);
  return match[1];
}

/** Read one `<key>K</key><true/>` flag out of a plist document. */
function plistFlag(plist, key) {
  return new RegExp(`<key>${key}</key>\\s*<true/>`, "u").test(plist);
}

test("escapePlistText neutralizes every character that can break a plist text node", () => {
  // Quotes are deliberately left alone: this escape only ever feeds XML *text*
  // nodes (the values inside <string>), where `"` and `'` are ordinary data and
  // only the three below can terminate or corrupt the document.
  assert.equal(escapePlistText("a & b < c > d \" e ' f"), "a &amp; b &lt; c &gt; d \" e ' f");
  // Escaping runs in one pass per character, so an already-escaped entity is
  // escaped again rather than being left as a live entity.
  assert.equal(escapePlistText("&amp;"), "&amp;amp;");
  assert.equal(escapePlistText("&"), "&amp;");
});

test("buildInfoPlist carries the bundle identity, version, and minimum system version", () => {
  const plist = buildInfoPlist();
  assert.equal(plistValue(plist, "CFBundleIdentifier"), DEFAULT_BUNDLE_ID);
  assert.equal(plistValue(plist, "CFBundleName"), DEFAULT_APP_NAME);
  assert.equal(plistValue(plist, "CFBundleDisplayName"), DEFAULT_APP_NAME);
  assert.equal(plistValue(plist, "CFBundleExecutable"), HELPER_EXECUTABLE);
  assert.equal(plistValue(plist, "CFBundleShortVersionString"), "0.1.0");
  assert.equal(plistValue(plist, "CFBundleVersion"), "0.1.0");
  assert.equal(plistValue(plist, "LSMinimumSystemVersion"), MIN_SYSTEM_VERSION);
});

test("buildInfoPlist declares a background agent with an AppKit principal class", () => {
  const plist = buildInfoPlist();
  // LSUIElement is load-bearing: without it the helper appears in the Dock and
  // the app switcher, and NSPrincipalClass is what makes AppKit start the
  // NSApplication the notification centre needs to route a click back to us.
  assert.equal(plistFlag(plist, "LSUIElement"), true);
  assert.equal(plistValue(plist, "NSPrincipalClass"), "NSApplication");
  assert.equal(plistValue(plist, "CFBundlePackageType"), "APPL");
  assert.equal(plistValue(plist, "CFBundleIconFile"), "icon.icns");
  assert.equal(plistValue(plist, "CFBundleInfoDictionaryVersion"), "6.0");
});

test("buildInfoPlist honors an explicit identity override", () => {
  const plist = buildInfoPlist({ bundleId: "com.example.helper", appName: "My Helper", minSystemVersion: "14.0" });
  assert.equal(plistValue(plist, "CFBundleIdentifier"), "com.example.helper");
  assert.equal(plistValue(plist, "CFBundleName"), "My Helper");
  assert.equal(plistValue(plist, "LSMinimumSystemVersion"), "14.0");
});

test("buildInfoPlist cannot be broken out of by a hostile app name", () => {
  const plist = buildInfoPlist({ appName: "</string><key>LSUIElement</key><false/>" });
  const clean = buildInfoPlist();
  assert.ok(!plist.includes("<false/>"), "the injected element must not become markup");
  // The document keeps exactly the keys it was built with: an escaped hostile
  // name can add text but never a new key.
  assert.equal((plist.match(/<key>/gu) ?? []).length, (clean.match(/<key>/gu) ?? []).length);
  assert.ok(plist.includes("&lt;/string&gt;&lt;key&gt;LSUIElement&lt;/key&gt;&lt;false/&gt;"));
  assert.equal(plistFlag(plist, "LSUIElement"), true);
});

test("buildInfoPlist cannot be broken out of by a hostile bundle id", () => {
  const plist = buildInfoPlist({ bundleId: "a&b<c>d'", executable: "x</string>" });
  assert.equal(plistValue(plist, "CFBundleIdentifier"), "a&amp;b&lt;c&gt;d'");
  assert.ok(!plist.includes("x</string></string>"));
  assert.ok(plist.includes("&lt;/string&gt;"));
});

test("planHelperBuild asks for a build when the binary is absent", () => {
  assert.deepEqual(planHelperBuild({ binaryExists: false }), { needed: true, reason: "missing" });
  assert.deepEqual(planHelperBuild({}), { needed: true, reason: "missing" });
});

test("planHelperBuild rebuilds when the Swift source is newer than the binary", () => {
  assert.deepEqual(planHelperBuild({ binaryExists: true, sourceMtimeMs: 2000, binaryMtimeMs: 1000 }), {
    needed: true,
    reason: "stale",
  });
});

test("planHelperBuild leaves a current build alone", () => {
  assert.deepEqual(planHelperBuild({ binaryExists: true, sourceMtimeMs: 1000, binaryMtimeMs: 2000 }), {
    needed: false,
    reason: "current",
  });
  // Equal timestamps are not evidence of staleness.
  assert.deepEqual(planHelperBuild({ binaryExists: true, sourceMtimeMs: 1000, binaryMtimeMs: 1000 }), {
    needed: false,
    reason: "current",
  });
});

test("planHelperBuild treats an unreadable mtime as current rather than thrashing", () => {
  assert.deepEqual(planHelperBuild({ binaryExists: true, sourceMtimeMs: undefined, binaryMtimeMs: 1 }), {
    needed: false,
    reason: "current",
  });
});

test("mtimeOf reads the disk so the stale verdict is reachable in production", () => {
  // Without a real probe the plan could only ever say "missing" or "current",
  // and editing macos/main.swift would silently keep running the old helper.
  const stats = statSync(fileURLToPath(import.meta.url));
  assert.equal(mtimeOf(fileURLToPath(import.meta.url)), stats.mtimeMs);
  // An unreadable path is "unknown", never a number that could look stale.
  assert.equal(mtimeOf("/nonexistent/dsh-notified/probe"), undefined);
});

test("resolution detects a rebuilt source through the real filesystem", () => {
  // A production-shaped resolution of this repository: the helper is installed,
  // and the timestamp probe is the default one rather than an injected stub.
  const root = helperRoot(process.env);
  const resolved = resolution({ root });
  assert.ok(["missing", "stale", "current"].includes(resolved.plan.reason));
  const binaryExists = existsSync(resolved.binary);
  if (binaryExists) {
    const sourceMtime = mtimeOf(resolved.source);
    const binaryMtime = mtimeOf(resolved.binary);
    assert.ok(Number.isFinite(sourceMtime), "the shipped Swift source must be readable");
    if (sourceMtime > binaryMtime) assert.equal(resolved.plan.reason, "stale");
  }
});

test("buildSwiftArgs pins the deployment target below the installed SDK", () => {
  // swiftc otherwise defaults to a target matching the *installed SDK* (macOS
  // 28 on this machine), and LaunchServices then refuses the bundle with
  // kLSIncompatibleSystemVersionErr / -10825 on the older system running it.
  const args = buildSwiftArgs({ source: "/src/main.swift", output: "/out/dsh-notified" });
  assert.ok(args.includes("-target"));
  assert.equal(args[args.indexOf("-target") + 1], "arm64-apple-macosx13.0");
  assert.equal(args[args.indexOf("-target") + 1], `arm64-apple-macosx${MIN_SYSTEM_VERSION}`);
});

test("buildSwiftArgs emits an optimizing vector that writes the requested output", () => {
  const args = buildSwiftArgs({ source: "/src/main.swift", output: "/out/dsh-notified", target: "x86_64-apple-macosx13.0" });
  assert.deepEqual(args, ["-O", "-target", "x86_64-apple-macosx13.0", "-o", "/out/dsh-notified", "/src/main.swift"]);
});

test("buildSwiftArgs names the tool when the resolved compiler is xcrun", () => {
  // xcrun is a dispatcher, so the bare swiftc flags are read as xcrun's own
  // options: `/usr/bin/xcrun -O` fails with "unrecognized option: -O", exit 64.
  // The tool name has to head the vector for the shim to work at all.
  const args = buildSwiftArgs({ source: "/src/main.swift", output: "/out/dsh-notified", compiler: "/usr/bin/xcrun" });
  assert.equal(args[0], "swiftc");
  assert.deepEqual(args.slice(1), ["-O", "-target", "arm64-apple-macosx13.0", "-o", "/out/dsh-notified", "/src/main.swift"]);
  // A real swiftc must not get the extra word.
  assert.ok(!buildSwiftArgs({ source: "s", output: "o", compiler: "/usr/bin/swiftc" }).includes("swiftc"));
});

test("helperRoot keeps the helper under Application Support, never a temp directory", () => {
  // A bundle under /tmp fails with `sandbox_extension_issue_file_to_process
  // failed … Operation not permitted` and never becomes a notification client.
  const root = helperRoot({ HOME: "/Users/example" });
  assert.equal(root, "/Users/example/Library/Application Support/dsh-notified");
  assert.ok(!root.startsWith("/tmp"));
  assert.ok(!root.startsWith("/var/folders"));
});

test("helperRoot falls back to the real home directory when HOME is unset or empty", () => {
  for (const env of [{}, { HOME: "" }]) {
    const root = helperRoot(env);
    assert.ok(root.endsWith("/Library/Application Support/dsh-notified"), root);
  }
});

test("helperAppPath and helperSocketPath are both derived from the root", () => {
  const root = "/Users/example/Library/Application Support/dsh-notified";
  assert.equal(helperAppPath(root), `${root}/DSHNotify.app`);
  assert.equal(helperSocketPath(root, { TMPDIR: "/tmp" }), `${root}/${SOCKET_NAME}`);
  assert.notEqual(helperSocketPath("/other/root", { TMPDIR: "/tmp" }), helperSocketPath(root, { TMPDIR: "/tmp" }));
});

test("helperSocketPath moves only the socket to a temp directory when the path is too long", () => {
  // A Unix socket path is capped near 104 bytes, which a deeply nested home can
  // exceed. The bundle itself must stay in Application Support; only the socket
  // is allowed to relocate.
  const longRoot = `/${"nested/".repeat(30)}dsh-notified`;
  const socket = helperSocketPath(longRoot, { TMPDIR: "/var/folders/xyz" });
  assert.ok(!socket.startsWith(longRoot), socket);
  assert.equal(socket.slice(0, socket.lastIndexOf("/")), "/var/folders/xyz");
  assert.match(socket, /^\/var\/folders\/xyz\/dsh-notified-\d+-[0-9a-f]+\.sock$/u);
  assert.ok(Buffer.byteLength(socket, "utf8") < 100);
  assert.ok(helperAppPath(longRoot).startsWith(longRoot));
});

test("helperSocketPath keeps relocated installs apart", () => {
  // Two over-long roots for the same user must not share one socket: they would
  // be separate helpers, and one install could then drive the other's.
  const long = (name) => `/${"nested/".repeat(30)}${name}`;
  const a = helperSocketPath(long("rootA"), { TMPDIR: "/tmp" });
  const b = helperSocketPath(long("rootB"), { TMPDIR: "/tmp" });
  assert.notEqual(a, b);
  // The digest is a pure function of the root, so the path stays stable across
  // runs and a resident helper is still found on the next notification.
  assert.equal(a, helperSocketPath(long("rootA"), { TMPDIR: "/tmp" }));
  assert.ok(a.startsWith("/tmp/"));
});

test("parseReply returns the object a complete reply line describes", () => {
  assert.deepEqual(parseReply('{"ok":true,"code":0}\n'), { ok: true, code: 0 });
  // The helper terminates every reply with a newline; the reader may still hand
  // over surrounding whitespace.
  assert.deepEqual(parseReply('  {"ok":false,"reason":"denied"}  '), { ok: false, reason: "denied" });
});

test("parseReply reports a partial line as no reply instead of throwing", () => {
  // The line is only parsed once a newline has arrived, so a fragment must
  // degrade into "no reply" — never into an exception inside the notify path.
  assert.equal(parseReply("{"), undefined);
  assert.equal(parseReply('{"ok":tr'), undefined);
});

test("parseReply returns undefined for empty, non-JSON, and non-object lines", () => {
  assert.equal(parseReply(""), undefined);
  assert.equal(parseReply("   \n"), undefined);
  assert.equal(parseReply("not json at all"), undefined);
  assert.equal(parseReply("42"), undefined);
  assert.equal(parseReply("null"), undefined);
});

test("outcomeOf mirrors the toast exit-code contract", () => {
  assert.deepEqual(outcomeOf({ ok: true, code: 0 }), { ok: true, suppressed: false, code: 0 });
  assert.deepEqual(outcomeOf({ ok: true, suppressed: true, code: EXIT_SUPPRESSED }), {
    ok: true,
    suppressed: true,
    code: EXIT_SUPPRESSED,
  });
  assert.equal(outcomeOf({ ok: false, reason: "unavailable", code: EXIT_UNAVAILABLE }).reason, "unavailable");
  assert.equal(outcomeOf({ ok: false, reason: "unavailable", code: EXIT_UNAVAILABLE }).code, EXIT_UNAVAILABLE);
  assert.equal(outcomeOf({ ok: false, reason: "rejected", code: EXIT_REJECTED }).code, EXIT_REJECTED);
  assert.deepEqual(outcomeOf({ ok: false, reason: "denied", code: EXIT_REJECTED }), {
    ok: false,
    reason: "denied",
    code: EXIT_REJECTED,
    detail: undefined,
  });
});

test("outcomeOf defaults a reply that carries no usable code or reason", () => {
  const outcome = outcomeOf({ ok: true });
  assert.deepEqual(outcome, { ok: true, suppressed: false, code: 0 });
  const failure = outcomeOf({ ok: false, reason: 7, code: "5" });
  assert.equal(failure.ok, false);
  assert.equal(failure.reason, "rejected");
  assert.equal(failure.code, EXIT_REJECTED);
  // A missing reply is a distinct, named failure rather than a bare rejection.
  assert.deepEqual(outcomeOf(undefined), { ok: false, reason: "bad-reply" });
  // The helper's diagnostic detail survives only when it is a string.
  assert.equal(outcomeOf({ ok: false, reason: "denied", detail: "auth=denied" }).detail, "auth=denied");
  assert.equal(outcomeOf({ ok: false, reason: "denied", detail: 9 }).detail, undefined);
});

test("outcomeOf classifies a reply that carries only an exit code", () => {
  // lib/toast.js derives the reason from the Windows child's exit code, so the
  // macOS reader must not lump every codeless failure into "rejected" — a code 4
  // is an unavailable channel, which the log turns into a specific remedy.
  assert.deepEqual(outcomeOf({ ok: false, code: EXIT_UNAVAILABLE }), {
    ok: false,
    reason: "unavailable",
    code: EXIT_UNAVAILABLE,
    detail: undefined,
  });
  assert.equal(outcomeOf({ ok: false, code: EXIT_SUPPRESSED }).reason, "suppressed");
  assert.equal(outcomeOf({ ok: false, code: EXIT_REJECTED }).reason, "rejected");
  // An empty reason is as useless as a missing one.
  assert.equal(outcomeOf({ ok: false, reason: "", code: EXIT_UNAVAILABLE }).reason, "unavailable");
  // An explicit reason always wins over the code.
  assert.equal(outcomeOf({ ok: false, reason: "denied", code: EXIT_UNAVAILABLE }).reason, "denied");
});

test("buildRequest treats the Harness bundle id as foreground alongside the configured names", () => {
  // The shared config defaults to the Windows-facing product name, while macOS
  // reports "com.deepseek.dsh" — accepting both keeps one setting meaningful on
  // both platforms.
  const request = buildRequest({ foregroundProcessNames: ["DeepSeek Harness"] });
  assert.ok(request.foregroundBundleIds.includes("DeepSeek Harness"));
  assert.ok(request.foregroundBundleIds.includes("com.deepseek.dsh"));
  assert.ok(request.foregroundBundleIds.includes(DEFAULT_BUNDLE_ID));
  // Only one entry per identity, and nothing non-string survives the filter.
  const deduped = buildRequest({ foregroundProcessNames: ["com.deepseek.dsh", "com.deepseek.dsh"] });
  assert.equal(deduped.foregroundBundleIds.filter((value) => value === "com.deepseek.dsh").length, 1);
  const filtered = buildRequest({ foregroundProcessNames: ["ok", 7, "", null] });
  assert.ok(filtered.foregroundBundleIds.every((value) => typeof value === "string" && value.length > 0));
  assert.ok(filtered.foregroundBundleIds.includes("ok"));
});

test("buildRequest defaults the kind, launch target, and channel policy", () => {
  const request = buildRequest({});
  assert.equal(request.kind, "notify");
  assert.equal(request.launch, "dsh://open");
  assert.equal(request.duration, "short");
  assert.equal(request.title, "");
  assert.equal(request.body, "");
  assert.equal(request.suppressWhenFocused, false);
  assert.equal(request.group, undefined);
  // `silent` defaults to true, which the helper reads as "no sound".
  assert.equal(request.sound, false);
});

test("buildRequest honors explicit request options and generates a unique id", () => {
  const request = buildRequest({
    title: "T",
    body: "B",
    launch: "dsh://focus",
    duration: "long",
    silent: false,
    suppressWhenFocused: true,
    group: "g",
    id: "explicit",
    bundleId: "com.example.app",
  });
  assert.equal(request.title, "T");
  assert.equal(request.body, "B");
  assert.equal(request.launch, "dsh://focus");
  assert.equal(request.duration, "long");
  assert.equal(request.sound, true);
  assert.equal(request.suppressWhenFocused, true);
  assert.equal(request.group, "g");
  assert.equal(request.id, "explicit");
  assert.ok(request.foregroundBundleIds.includes("com.example.app"));
  assert.ok(request.foregroundBundleIds.includes("com.deepseek.dsh"));
  assert.notEqual(buildRequest({}).id, undefined);
  assert.ok(String(buildRequest({}).id).length > 0);
});

test("resolution reports a build as needed when nothing is installed yet", () => {
  const resolved = resolution({
    root: "/nonexistent-test-root",
    source: "/nonexistent-test-source/main.swift",
    env: { HOME: "/nonexistent-test-root", TMPDIR: "/tmp" },
    exists: () => false,
    statMtime: () => 0,
  });
  assert.deepEqual(resolved.plan, { needed: true, reason: "missing" });
  assert.equal(resolved.swiftc, undefined);
  assert.equal(resolved.harnessIcon, undefined);
  assert.equal(resolved.binary, "/nonexistent-test-root/DSHNotify.app/Contents/MacOS/dsh-notified");
});

test("resolution describes a current install from injected probes alone", () => {
  const root = "/Users/example/Library/Application Support/dsh-notified";
  const resolved = resolution({
    root,
    source: "/src/main.swift",
    env: { HOME: "/Users/example", TMPDIR: "/tmp" },
    exists: () => true,
    statMtime: (path) => (path === "/src/main.swift" ? 1000 : 2000),
  });
  assert.deepEqual(resolved.plan, { needed: false, reason: "current" });
  assert.equal(resolved.root, root);
  assert.equal(resolved.app, `${root}/DSHNotify.app`);
  assert.equal(resolved.plist, `${root}/DSHNotify.app/Contents/Info.plist`);
  assert.equal(resolved.icon, `${root}/DSHNotify.app/Contents/Resources/icon.icns`);
  assert.equal(resolved.socket, `${root}/${SOCKET_NAME}`);
  assert.equal(resolved.source, "/src/main.swift");
  assert.equal(resolved.swiftc, "/usr/bin/swiftc");
});

test("resolveSwiftc prefers an absolute compiler path and falls back to xcrun", () => {
  assert.equal(resolveSwiftc({ exists: (path) => path === "/usr/bin/swiftc" }), "/usr/bin/swiftc");
  assert.equal(resolveSwiftc({ exists: (path) => path === "/usr/bin/xcrun" }), "/usr/bin/xcrun");
  assert.equal(resolveSwiftc({ exists: () => false }), undefined);
  // An explicit path is trusted without probing: it may be a shim.
  assert.equal(resolveSwiftc({ swiftc: "/opt/swift/bin/swiftc", exists: () => false }), "/opt/swift/bin/swiftc");
});

test("resolveHarnessIconDarwin honors an explicit path and otherwise probes the standard install", () => {
  assert.equal(resolveHarnessIconDarwin({ iconPath: "/custom/icon.icns", exists: () => true }), "/custom/icon.icns");
  assert.equal(resolveHarnessIconDarwin({ iconPath: "/custom/icon.icns", exists: () => false }), undefined);

  const probed = [];
  const accepted = "/Applications/DeepSeek Harness.app/Contents/Resources/icon.icns";
  const icon = resolveHarnessIconDarwin({
    exists: (path) => {
      probed.push(path);
      return path === accepted;
    },
  });
  assert.equal(icon, accepted);
  assert.ok(probed.includes(accepted));
  assert.equal(resolveHarnessIconDarwin({ exists: () => false }), undefined);
});

test("showMacToast is a no-op off macOS", async () => {
  const outcome = await showMacToast({ platform: "linux", title: "t", body: "b" });
  assert.deepEqual(outcome, { ok: false, reason: "not-darwin" });
});

test("showMacToast reports a missing compiler instead of installing anything", async () => {
  const outcome = await showMacToast({
    platform: "darwin",
    root: "/nonexistent-test-root",
    source: "/nonexistent-test-source/main.swift",
    env: { HOME: "/nonexistent-test-root", TMPDIR: "/tmp" },
    exists: () => false,
    title: "t",
    body: "b",
  });
  assert.deepEqual(outcome, { ok: false, reason: "no-swiftc" });
});
