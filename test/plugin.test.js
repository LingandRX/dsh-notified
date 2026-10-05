import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, Config, DURATIONS, isDesktopShell, PLATFORMS, REASONS, explainFailure, name, resolveChannel } from "../lib/index.js";

/**
 * Minimal recorder standing in for a Cordis context, plus a fake delivery
 * function, so `apply` can be exercised end to end without the loader tree or a
 * real notification.
 */
function harness(configOverrides = {}) {
  const delivered = [];
  const injected = [];
  const listeners = new Map();
  const logged = { info: [], warn: [] };
  const ctx = {
    logger: {
      info: (...a) => logged.info.push(a.join(" ")),
      warn: (...a) => logged.warn.push(a.join(" ")),
      error: (...a) => logged.warn.push(a.join(" ")),
    },
    get: () => undefined,
    effect: (fn) => {
      fn();
    },
    on: (event, handler) => listeners.set(event, handler),
    inject: (deps, callback) => {
      injected.push(deps);
      if (deps.includes("tools")) callback(ctx);
    },
    tools: { register: () => () => {} },
  };
  const registered = [];
  ctx.tools.register = (definition) => {
    registered.push(definition);
    return () => {};
  };
  const settings = new Config({ registerAumid: false, coalesceMs: 0, verbose: true, ...configOverrides });
  const send = async (request) => {
    delivered.push(request);
    return { ok: true, suppressed: false, code: 0 };
  };
  apply(ctx, settings, { showToast: send });
  return {
    emitted: (session, event) => listeners.get("session/event")(session, event),
    disposed: (session) => listeners.get("session/disposed")(session),
    delivered,
    logged,
    injected,
    registered,
  };
}

/** Build a session-like object with a header. */
function session(header = {}) {
  return { header: { id: "s-1", cwd: "C:\\work\\demo", ...header } };
}

/** Emit a complete turn: start, assistant reply, end. */
function runTurn(h, s, { turn = 1, text = "All done.", kind = "completed", start = 1000, end = 4000 } = {}) {
  h.emitted(s, { type: "turn/start", time: start, data: { turn } });
  if (text !== null) {
    h.emitted(s, { type: "assistant/message", time: start + 1, data: { message: { content: [{ type: "text", text }] } } });
  }
  h.emitted(s, { type: "turn/end", time: end, data: { turn, reason: { kind } } });
}

test("the plugin exports the cordis contract", () => {
  assert.equal(name, "dsh-notified");
  assert.equal(typeof apply, "function");
  assert.equal(typeof Config, "function");
  assert.ok(REASONS.includes("completed"));
  assert.deepEqual(DURATIONS, ["short", "long"]);
});

test("apply validates its config defaults", () => {
  const parsed = new Config({});
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.notifyOn, ["completed"]);
  assert.equal(parsed.suppressWhenFocused, true);
  assert.deepEqual(parsed.foregroundProcessNames, ["DeepSeek Harness"]);
  assert.equal(parsed.bodyMaxChars, 140);
  assert.equal(parsed.launch, "dsh://open");
  // `auto` is the published contract: one notification per turn, never the pair
  // of identical banners that a both-channels default used to produce.
  assert.equal(parsed.webNotification, "auto");
});

test("apply registers the manual test tool through the tools service", () => {
  const h = harness();
  // The plugin also watches for `webServer` so the SSE route is installed even
  // when that sibling service is applied after this row.
  assert.deepEqual(h.injected, [["webServer"], ["tools"]]);
  assert.equal(h.registered.length, 1);
  const tool = h.registered[0];
  assert.equal(tool.name, "dsh_notify_test");
  assert.equal(typeof tool.execute, "function");
  assert.equal(typeof tool.output.render, "function");
});

test("the SSE route is installed even when webServer arrives late", async () => {
  // `ctx.get` only sees services that already exist. Wiring the route through a
  // one-shot read (or through `ctx.on("service", …)`, an event Cordis never
  // emits) left the route unregistered for the process lifetime, so browser
  // notifications silently never worked. `ctx.inject` must be the fallback.
  const { EVENT_ROUTE_PATH } = await import("../lib/web.js");

  let deferred;
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined, // webServer not available yet
    effect: (fn) => fn(),
    on: () => {},
    inject: (deps, callback) => {
      if (deps.includes("webServer")) deferred = callback;
      if (deps.includes("tools")) callback(ctx);
    },
    tools: { register: () => () => {} },
  };

  apply(ctx, new Config({ coalesceMs: 0 }), { showToast: async () => ({ ok: true, code: 0 }) });
  assert.equal(typeof deferred, "function", "the plugin must defer on webServer");

  // The sibling plugin applies afterwards and provides the service.
  const attached = [];
  const fakeServer = {
    register: (route) => {
      attached.push(route);
      return () => {};
    },
  };
  deferred({ webServer: fakeServer });

  assert.equal(attached.length, 1, "the SSE route must be registered once webServer appears");
  assert.equal(attached[0].path, EVENT_ROUTE_PATH);
  assert.equal(attached[0].kind, "exact");
});

test("the registered tool declares a schema the registry can validate", () => {
  const tool = harness().registered[0];
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["title", "body"]);
  assert.equal(tool.output.schema.type, "object");
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.deepEqual(tool.output.schema.required, ["delivered", "detail"]);
});

test("apply subscribes to the session events it needs", () => {
  const h = harness();
  assert.ok(h.injected.length >= 1);
  assert.equal(typeof h.emitted, "function");
});

test("an assistant reply followed by turn/end notifies once", async () => {
  const h = harness();
  runTurn(h, session());
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 1);
  const request = h.delivered[0];
  assert.equal(request.title, "demo");
  assert.ok(request.body.includes("All done."));
  assert.ok(request.body.includes("(3s)"));
  assert.equal(request.suppressWhenFocused, true);
});

test("the payload carries the session id so a web click can reopen it", async () => {
  const h = harness();
  runTurn(h, session({ id: "session-abc" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered[0].sessionId, "session-abc");
});

test("a merged batch drops the session id rather than pointing at one reply", async () => {
  const h = harness({ coalesceMs: 50 });
  runTurn(h, session({ id: "s-a" }), { turn: 1 });
  runTurn(h, session({ id: "s-b" }), { turn: 1, start: 5000, end: 6000 });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].sessionId, undefined);
});

test("the title falls back to the workspace directory name", async () => {
  const h = harness();
  runTurn(h, session({ cwd: "C:\\Users\\a\\Documents\\ChatGPT\\my-project" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered[0].title, "my-project");
});

test("a turn that only ran tools does not notify", async () => {
  const h = harness();
  runTurn(h, session(), { text: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 0);
  assert.ok(h.logged.info.some((line) => line.includes("no-output")), JSON.stringify(h.logged.info));
});

test("a turn/end without a matching turn/start is ignored quietly", async () => {
  const h = harness();
  h.emitted(session(), { type: "turn/end", time: 4000, data: { turn: 9, reason: { kind: "completed" } } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 0);
  assert.equal(h.logged.info.length, 0);
});

test("an aborted turn stays silent by default but reports why", async () => {
  const h = harness();
  runTurn(h, session(), { kind: "aborted" });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 0);
  assert.ok(h.logged.info.some((line) => line.includes("reason-filtered")), JSON.stringify(h.logged.info));
});

test("an aborted turn notifies when the user opts in", async () => {
  const h = harness({ notifyOn: ["completed", "aborted"] });
  runTurn(h, session(), { kind: "aborted" });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 1);
});

test("a subagent session stays silent unless opted in", async () => {
  const h = harness();
  runTurn(h, session({ id: "s-child", parentSession: "s-1", origin: "subagent" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 0);
  assert.ok(h.logged.info.some((line) => line.includes("subagent")), JSON.stringify(h.logged.info));
});

test("a subagent session notifies when the user opts in", async () => {
  const h = harness({ includeSubagents: true });
  runTurn(h, session({ id: "s-child", parentSession: "s-1", origin: "subagent" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 1);
});

test("a disabled plugin never notifies", async () => {
  const h = harness({ enabled: false });
  runTurn(h, session());
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 0);
  assert.ok(h.logged.info.some((line) => line.includes("disabled")), JSON.stringify(h.logged.info));
});

test("the minimum duration floor filters short turns", async () => {
  const h = harness({ minTurnDurationMs: 10_000 });
  runTurn(h, session(), { start: 1000, end: 3000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 0);
  assert.ok(h.logged.info.some((line) => line.includes("too-short")), JSON.stringify(h.logged.info));
});

test("the duration is omitted when showDuration is off", async () => {
  const h = harness({ showDuration: false });
  runTurn(h, session());
  await new Promise((r) => setImmediate(r));
  assert.ok(!h.delivered[0].body.includes("(3s)"));
});

test("a long reply keeps its duration inside the default body budget", async () => {
  // End-to-end guard for the reservation: with the default 140-character
  // budget a substantive reply used to fill the line and push the duration off
  // the end, so the setting was on while never appearing.
  const h = harness();
  runTurn(h, session(), { text: "word ".repeat(200), start: 1000, end: 4000 });
  await new Promise((r) => setImmediate(r));
  const body = h.delivered[0].body;
  assert.equal(Array.from(body).length, 140);
  assert.ok(body.endsWith("(3s)"), body);
  // 140 - "(3s)"(4) - separator(1) = 135 prose slots: 134 code points + ellipsis.
  assert.equal(body, `${"word ".repeat(26)}word\u2026 (3s)`);
});

test("an empty body falls back to the configured copy", async () => {
  const h = harness({ emptyBody: "Nothing to say" });
  // A reply made only of whitespace counts as no output, so drive the tool path
  // through a reply that strips to nothing after Markdown removal.
  h.emitted(session(), { type: "turn/start", time: 1000, data: { turn: 1 } });
  h.emitted(session(), { type: "assistant/message", time: 1001, data: { message: { content: [{ type: "text", text: "```\ncode only\n```" }] } } });
  h.emitted(session(), { type: "turn/end", time: 2000, data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0].body.includes("Nothing to say"));
});

test("consecutive turns on one session each notify", async () => {
  const h = harness();
  const s = session();
  runTurn(h, s, { turn: 1 });
  runTurn(h, s, { turn: 2, start: 5000, end: 6000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 2);
});

test("only the final assistant reply of a turn is used as the body", async () => {
  const h = harness();
  const s = session();
  h.emitted(s, { type: "turn/start", time: 1000, data: { turn: 1 } });
  h.emitted(s, { type: "assistant/message", time: 1500, data: { message: { content: [{ type: "text", text: "interim thinking" }] } } });
  h.emitted(s, { type: "assistant/message", time: 2000, data: { message: { content: [{ type: "text", text: "final answer" }] } } });
  h.emitted(s, { type: "turn/end", time: 3000, data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((r) => setImmediate(r));
  assert.ok(h.delivered[0].body.includes("final answer"));
  assert.ok(!h.delivered[0].body.includes("interim"));
});

test("a settling turn with no header is tolerated", () => {
  const h = harness();
  assert.doesNotThrow(() => h.emitted({}, { type: "turn/start", time: 1, data: { turn: 1 } }));
  assert.doesNotThrow(() => h.emitted(undefined, { type: "turn/end", time: 2, data: { turn: 1 } }));
  assert.equal(h.delivered.length, 0);
});

test("disposing a session clears its tracked state", async () => {
  const h = harness();
  const s = session();
  h.emitted(s, { type: "turn/start", time: 1000, data: { turn: 1 } });
  h.disposed(s);
  // After disposal the turn is unknown, so a late settle is ignored quietly.
  h.emitted(s, { type: "turn/end", time: 2000, data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.delivered.length, 0);
  assert.equal(h.logged.info.length, 0);
});

test("a delivery failure is reported without throwing", async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: (event, handler) => {
      ctx.__emit = handler;
    },
    inject: (deps, cb) => {
      if (deps.includes("tools")) cb(ctx);
    },
    tools: { register: () => () => {} },
  };
  const settings = new Config({ registerAumid: false, coalesceMs: 0 });
  apply(ctx, settings, { showToast: async () => ({ ok: false, reason: "rejected", code: 5, stderr: "nope" }) });
  const s = session();
  ctx.__emit(s, { type: "turn/start", time: 1000, data: { turn: 1 } });
  ctx.__emit(s, { type: "assistant/message", time: 1001, data: { message: { content: [{ type: "text", text: "hi" }] } } });
  assert.doesNotThrow(() => ctx.__emit(s, { type: "turn/end", time: 2000, data: { turn: 1, reason: { kind: "completed" } } }));
  await new Promise((r) => setImmediate(r));
});

test("the test tool reports a delivery failure without throwing", async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => {},
    inject: (deps, cb) => {
      if (deps.includes("tools")) cb(ctx);
    },
    tools: { register: () => () => {} },
  };
  const settings = new Config({ registerAumid: false });
  let tool;
  ctx.tools.register = (definition) => {
    tool = definition;
    return () => {};
  };
  apply(ctx, settings, { showToast: async () => ({ ok: false, reason: "unavailable", stderr: "no WinRT" }) });
  const result = await tool.execute({});
  assert.equal(result.delivered, false);
  assert.ok(result.detail.includes("unavailable"));
  assert.ok(result.detail.includes("no WinRT"));
  assert.equal(tool.output.render({}, result)[0].text, result.detail);
});

test("the test tool sends through the configured identity", async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => {},
    inject: (deps, cb) => {
      if (deps.includes("tools")) cb(ctx);
    },
    tools: { register: () => () => {} },
  };
  let tool;
  ctx.tools.register = (definition) => {
    tool = definition;
    return () => {};
  };
  const calls = [];
  apply(ctx, new Config({ registerAumid: true, appId: "Probe.App", sound: true, duration: "long" }), {
    showToast: async (request) => {
      calls.push(request);
      return { ok: true, suppressed: true, code: 3 };
    },
  });
  const result = await tool.execute({ title: "T", body: "B" });
  assert.equal(result.delivered, true);
  assert.equal(calls[0].title, "T");
  assert.equal(calls[0].body, "B");
  assert.equal(calls[0].appId, "Probe.App");
  assert.equal(calls[0].silent, false);
  assert.equal(calls[0].duration, "long");
  // The manual trigger always shows the toast, even while the app is focused.
  assert.equal(calls[0].suppressWhenFocused, false);
});

test("the plugin claims both desktop platforms", () => {
  assert.deepEqual(PLATFORMS, ["win32", "darwin"]);
});

test("resolveChannel picks a real channel per platform", () => {
  // The platform is injected rather than read from `process.platform`, so this
  // asserts the selection logic on any machine the suite runs on.
  const win = resolveChannel({ platform: "win32", overrides: {} });
  assert.equal(win.ok, true);
  assert.equal(win.injected, false);
  assert.equal(win.noun, "toast");
  assert.equal(typeof win.send, "function");

  const mac = resolveChannel({ platform: "darwin", overrides: {} });
  assert.equal(mac.ok, true);
  assert.equal(mac.injected, false);
  assert.equal(mac.noun, "notification");
  assert.equal(typeof mac.send, "function");

  const other = resolveChannel({ platform: "linux", overrides: {} });
  assert.equal(other.ok, false);
  assert.equal(other.reason, "unsupported-platform");
});

test("resolveChannel lets an injected sender win on every platform", () => {
  const send = async () => ({ ok: true, code: 0 });
  // The injection seam has to short-circuit the platform choice, otherwise the
  // suite could only exercise the one platform it happens to run on.
  for (const platform of ["win32", "darwin", "linux"]) {
    const channel = resolveChannel({ platform, overrides: { showToast: send } });
    assert.equal(channel.ok, true, platform);
    assert.equal(channel.injected, true, platform);
    assert.equal(channel.send, send, platform);
  }
});

test("the injected channel reports the configured identity as registered", () => {
  const channel = resolveChannel({ platform: "darwin", overrides: { showToast: async () => ({ ok: true }) } });
  assert.deepEqual(channel.prepare(null, { registerAumid: true }), { registered: true });
  assert.deepEqual(channel.prepare(null, { registerAumid: false }), { registered: false });
});

test("apply stays idle without a channel instead of throwing", () => {
  // A host-side plugin must never break the conversation it observes, so an
  // unsupported platform is a logged no-op rather than an error.
  const info = [];
  const ctx = {
    logger: { info: (...a) => info.push(a.join(" ")), warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => {},
    inject: () => {},
    tools: { register: () => () => {} },
  };
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    apply(ctx, new Config());
  } finally {
    Object.defineProperty(process, "platform", original);
  }
  assert.ok(info.some((line) => line.includes("no notification channel on linux")));
});

test("explainFailure turns a bare reason code into a remedy", () => {
  // A reason alone leaves the operator with nothing to do; each platform's
  // actionable failures must carry a hint.
  const denied = explainFailure({ ok: false, reason: "denied" }, "darwin");
  assert.ok(denied.includes("denied"));
  assert.ok(denied.includes("System Settings"));

  const noSwift = explainFailure({ ok: false, reason: "no-swiftc" }, "darwin");
  assert.ok(noSwift.includes("Xcode"));

  const noPowerShell = explainFailure({ ok: false, reason: "no-powershell" }, "win32");
  assert.ok(noPowerShell.includes("PowerShell 5.1"));
});

test("explainFailure includes the exit code and stderr when present", () => {
  const text = explainFailure({ ok: false, reason: "rejected", code: 5, stderr: "boom" }, "win32");
  assert.ok(text.includes("rejected"));
  assert.ok(text.includes("5"));
  assert.ok(text.includes("boom"));
});

test("explainFailure still describes an unknown reason", () => {
  // An unmapped reason must not render as "undefined": a future failure mode
  // should degrade into a readable line.
  const text = explainFailure({ ok: false, reason: "brand-new-failure" }, "linux");
  assert.ok(text.includes("brand-new-failure"));
  assert.ok(!text.includes("undefined"));
});

test("the test tool reports an injected delivery as a notification", async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => {},
    inject: (deps, cb) => {
      if (deps.includes("tools")) cb(ctx);
    },
    tools: { register: () => () => {} },
  };
  let tool;
  ctx.tools.register = (definition) => {
    tool = definition;
    return () => {};
  };
  apply(ctx, new Config({ coalesceMs: 0 }), { showToast: async () => ({ ok: true, suppressed: false, code: 0 }) });
  const result = await tool.execute({});
  // The injected channel is platform-neutral, so it is described generically
  // rather than as a Windows toast.
  assert.equal(result.detail, "Notification delivered.");
});

test("the darwin channel prepares the helper through its injected seam", async () => {
  const calls = [];
  const info = [];
  const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} } };
  const channel = resolveChannel({ platform: "darwin", overrides: { ensureHelper: async (options) => {
    calls.push(options);
    return { ok: true, reason: "built" };
  } } });
  const state = channel.prepare(ctx, new Config({ iconPath: "/tmp/x.icns" }), (level, ...rest) => info.push([level, ...rest].join(" ")));
  // macOS keys the user's notification permission to the bundle identifier, so
  // the bundle id must not follow `appId`; nothing is "registered" the way an
  // AUMID is on Windows.
  assert.deepEqual(state, { registered: false });
  await new Promise((resolve) => setImmediate(resolve));
  // The install is deliberately not awaited: compiling must overlap whatever the
  // user does next rather than delaying the first notification.
  assert.deepEqual(calls, [{ iconPath: "/tmp/x.icns" }]);
  assert.ok(info.some((line) => line.includes("helper installed")), info.join(" | "));
});

test("the darwin channel warns once when the helper cannot be prepared", async () => {
  const warns = [];
  const ctx = { logger: { info: () => {}, warn: (...a) => warns.push(a.join(" ")), error: () => {} } };
  const channel = resolveChannel({ platform: "darwin", overrides: { ensureHelper: async () => ({ ok: false, reason: "no-swiftc", detail: "no compiler" }) } });
  channel.prepare(ctx, new Config(), () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("no-swiftc"));
  assert.ok(warns[0].includes("no compiler"));
});

test("a rejected helper install still cannot break the turn path", async () => {
  // `prepare` runs on the conversation path, so even a helper that throws must
  // be contained; otherwise installing the plugin could break every turn.
  const warns = [];
  const ctx = { logger: { info: () => {}, warn: (...a) => warns.push(a.join(" ")), error: () => {} } };
  const channel = resolveChannel({ platform: "darwin", overrides: { ensureHelper: async () => { throw new Error("kaboom"); } } });
  assert.doesNotThrow(() => channel.prepare(ctx, new Config(), () => {}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("kaboom"));
});

/**
 * Build a harness whose native channel and browser hub are both observable.
 * @param configOverrides - Config fields to override.
 * @param webConnected - whether a browser client is connected.
 * @returns the recorded deliveries, broadcasts, and the emit seam.
 */
function dualHarness(configOverrides = {}, webConnected = true) {
  const webBroadcasts = [];
  const fakeWebHub = {
    hasClients: webConnected,
    clientCount: webConnected ? 1 : 0,
    broadcast: async (payload) => {
      webBroadcasts.push(payload);
      return { ok: true, suppressed: false, code: 0, detail: "broadcast" };
    },
    attach: () => () => {},
    dispose: () => {},
  };

  const delivered = [];
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: (event, handler) => listeners.set(event, handler),
    inject: () => {},
    tools: { register: () => () => {} },
  };

  apply(ctx, new Config({ coalesceMs: 0, ...configOverrides }), {
    showToast: async (p) => {
      delivered.push(p);
      return { ok: true, suppressed: false, code: 0 };
    },
    webHub: fakeWebHub,
  });

  return { delivered, webBroadcasts, emitted: (s, e) => listeners.get("session/event")(s, e) };
}

/** Emit one completed turn through the given emit seam. */
function completeTurn(emitted, s, text = "Done.") {
  emitted(s, { type: "turn/start", time: 1000, data: { turn: 1 } });
  emitted(s, { type: "assistant/message", time: 1001, data: { message: { content: [{ type: "text", text }] } } });
  emitted(s, { type: "turn/end", time: 2000, data: { turn: 1, reason: { kind: "completed" } } });
}

test("one settled turn produces exactly one notification when a browser is watching", async () => {
  // The regression this guards: sending to the native channel *and* broadcasting
  // to the browser produced two identical banners for a single turn, because a
  // `dsh web` host on macOS has both channels live and they reach the same user.
  const h = dualHarness();
  completeTurn(h.emitted, session(), "Done on web!");
  await new Promise((r) => setImmediate(r));

  assert.equal(h.delivered.length, 0, "the native channel must stand down");
  assert.equal(h.webBroadcasts.length, 1, "exactly one browser notification");
  assert.ok(h.webBroadcasts[0].body.includes("Done on web!"));
});

test("the desktop shell keeps its native banner instead of duplicating it in-window", async () => {
  // The desktop application bundles its own web server, so its renderer is also
  // an SSE client. Without the shell guard that client would receive a web
  // notification inside the very window the native banner already announced.
  const webBroadcasts = [];
  const fakeWebHub = {
    hasClients: true,
    clientCount: 1,
    broadcast: async (p) => {
      webBroadcasts.push(p);
      return { ok: true, code: 0 };
    },
    attach: () => () => {},
    dispose: () => {},
  };
  const delivered = [];
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: (event, handler) => listeners.set(event, handler),
    inject: () => {},
    tools: { register: () => () => {} },
  };

  apply(ctx, new Config({ coalesceMs: 0 }), {
    showToast: async (p) => {
      delivered.push(p);
      return { ok: true, code: 0 };
    },
    webHub: fakeWebHub,
    desktopShell: true,
  });

  completeTurn((s, e) => listeners.get("session/event")(s, e), session());
  await new Promise((r) => setImmediate(r));

  assert.equal(delivered.length, 1);
  assert.equal(webBroadcasts.length, 0);
});

test("webNotification=always deliberately sends to both audiences", async () => {
  const h = dualHarness({ webNotification: "always" });
  completeTurn(h.emitted, session());
  await new Promise((r) => setImmediate(r));

  assert.equal(h.delivered.length, 1);
  assert.equal(h.webBroadcasts.length, 1);
});

test("webNotification=off keeps the browser silent", async () => {
  const h = dualHarness({ webNotification: "off" });
  completeTurn(h.emitted, session());
  await new Promise((r) => setImmediate(r));

  assert.equal(h.delivered.length, 1);
  assert.equal(h.webBroadcasts.length, 0);
});

test("with no browser connected the native channel still notifies", async () => {
  const h = dualHarness({}, false);
  completeTurn(h.emitted, session());
  await new Promise((r) => setImmediate(r));

  assert.equal(h.delivered.length, 1);
  assert.equal(h.webBroadcasts.length, 0);
});

test("a failed native delivery falls back to a connected browser", async () => {
  // A denied permission or a helper that will not start must not swallow the
  // notification while somebody is watching in a browser.
  const webBroadcasts = [];
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: (event, handler) => listeners.set(event, handler),
    inject: () => {},
    tools: { register: () => () => {} },
  };

  apply(ctx, new Config({ coalesceMs: 0 }), {
    showToast: async () => ({ ok: false, reason: "denied" }),
    webHub: {
      hasClients: true,
      clientCount: 1,
      broadcast: async (p) => {
        webBroadcasts.push(p);
        return { ok: true, suppressed: false, code: 0, detail: "broadcast" };
      },
      attach: () => () => {},
      dispose: () => {},
    },
  });

  completeTurn((s, e) => listeners.get("session/event")(s, e), session());
  await new Promise((r) => setImmediate(r));

  assert.equal(webBroadcasts.length, 1, "the browser must pick up the failed native delivery");
});

test("the test tool broadcasts to active web clients", async () => {
  const webBroadcasts = [];
  const fakeWebHub = {
    hasClients: true,
    clientCount: 1,
    broadcast: async (p) => {
      webBroadcasts.push(p);
      return { ok: true, code: 0 };
    },
    attach: () => () => {},
    dispose: () => {},
  };

  let tool;
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => {},
    inject: (deps, cb) => {
      if (deps.includes("tools")) cb(ctx);
    },
    tools: {
      register: (def) => {
        tool = def;
        return () => {};
      },
    },
  };

  apply(ctx, new Config(), {
    showToast: async () => ({ ok: true, code: 0 }),
    webHub: fakeWebHub,
  });

  assert.ok(tool);
  const result = await tool.execute({ title: "Web Test", body: "Hello Web" });
  assert.equal(result.delivered, true);
  assert.equal(webBroadcasts.length, 1);
  assert.equal(webBroadcasts[0].title, "Web Test");
  assert.equal(webBroadcasts[0].body, "Hello Web");
});

test("apply mounts web channel on linux when webServer is available", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });

  const webBroadcasts = [];
  const fakeWebHub = {
    hasClients: true,
    clientCount: 1,
    broadcast: async (p) => {
      webBroadcasts.push(p);
      return { ok: true, code: 0 };
    },
    attach: () => () => {},
    dispose: () => {},
  };

  let registeredTool;
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (key) => (key === "webServer" ? {} : undefined),
    effect: (fn) => fn(),
    on: (event, handler) => listeners.set(event, handler),
    inject: (deps, cb) => {
      if (deps.includes("tools")) cb(ctx);
    },
    tools: {
      register: (def) => {
        registeredTool = def;
        return () => {};
      },
    },
  };

  try {
    apply(ctx, new Config({ coalesceMs: 0 }), { webHub: fakeWebHub });
    assert.ok(registeredTool, "Tool should be registered because web channel resolved");
    const toolResult = await registeredTool.execute({ title: "Linux Web", body: "OK" });
    assert.equal(toolResult.delivered, true);
    assert.equal(webBroadcasts.length, 1);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("isDesktopShell detects the Electron-hosted desktop application", () => {
  // Verified against the shipped 0.2.0-rc.2 runtime: the desktop host runs under
  // Electron with ELECTRON_RUN_AS_NODE=1 and still reports versions.electron,
  // while a plain `dsh web` on stock Node reports undefined. This is what lets
  // `auto` tell the desktop's own renderer apart from a real browser user.
  assert.equal(isDesktopShell({ electron: "44.0.0", node: "24.20.0" }), true);
  assert.equal(isDesktopShell({ node: "24.20.0" }), false);
  assert.equal(isDesktopShell({}), false);
  assert.equal(isDesktopShell(undefined), false);
});
