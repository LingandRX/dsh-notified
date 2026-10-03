import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, Config, DURATIONS, REASONS, name } from "../lib/index.js";

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
});

test("apply registers the manual test tool through the tools service", () => {
  const h = harness();
  assert.deepEqual(h.injected, [["tools"]]);
  assert.equal(h.registered.length, 1);
  const tool = h.registered[0];
  assert.equal(tool.name, "dsh_notify_test");
  assert.equal(typeof tool.execute, "function");
  assert.equal(typeof tool.output.render, "function");
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
