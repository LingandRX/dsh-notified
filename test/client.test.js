import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * `client.js` ships as a **classic script** (the Harness bundle transport
 * appends `<script src>` with no module type), so the suite must not import it
 * as an ES module — that reading would hide the parse error the browser hits.
 * These tests evaluate the real file in a `node:vm` context with a fake module
 * loader and assert against the surface it registers.
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../client.js");
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, "utf8");

/**
 * Evaluate the shipped bundle and return its plugin surface.
 * @param {object} [globals] - Extra globals the bundle body may see.
 * @returns {{ api: object, registrations: object[] }}
 */
function loadBundle(globals = {}) {
  const registrations = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration) => registrations.push(registration),
      },
    },
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    console,
    ...globals,
  };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: "client.js" });

  assert.equal(registrations.length, 1, "the bundle must register exactly once");
  const registration = registrations[0];
  assert.equal(registration.id, "dsh-notified");
  assert.equal(typeof registration.factory, "function");
  return { api: registration.factory(), registrations, sandbox };
}

/** Mock Notification constructor. */
function createMockNotificationClass(initialPermission = "granted") {
  const instances = [];
  class MockNotification {
    static permission = initialPermission;
    static requests = 0;
    static async requestPermission() {
      MockNotification.requests += 1;
      MockNotification.permission = "granted";
      return "granted";
    }

    constructor(title, options = {}) {
      this.title = title;
      this.options = options;
      this.closed = false;
      this.onclick = null;
      instances.push(this);
    }

    close() {
      this.closed = true;
    }
  }
  return { MockNotification, instances };
}

/** Mock Document. */
function createMockDocument(visibilityState = "visible", hasFocus = true) {
  return {
    visibilityState,
    hasFocus: () => hasFocus,
  };
}

/** Mock Window. */
function createMockWindow() {
  const listeners = new Map();
  let focused = false;
  return {
    get focused() {
      return focused;
    },
    focus: () => {
      focused = true;
    },
    addEventListener: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    removeEventListener: (event, fn) => {
      const list = listeners.get(event);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    emit: (event) => {
      const list = listeners.get(event) ?? [];
      for (const fn of list.slice()) fn();
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  };
}

/** Mock EventSource. */
function createMockEventSourceClass() {
  const instances = [];
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      instances.push(this);
    }

    close() {
      this.closed = true;
    }

    send(data) {
      if (typeof this.onmessage === "function") {
        this.onmessage({ data: typeof data === "string" ? data : JSON.stringify(data) });
      }
    }

    triggerError() {
      if (typeof this.onerror === "function") {
        this.onerror(new Error("Connection lost"));
      }
    }
  }
  return { MockEventSource, instances };
}

test("client.js parses and registers as a classic script", () => {
  // A top-level `export` or `import.meta` makes this throw a SyntaxError, which
  // is exactly how the browser would fail to activate the plugin.
  const { api } = loadBundle();
  assert.equal(api.name, "dsh-notified");
  assert.deepEqual([...api.inject], []);
  assert.equal(typeof api.apply, "function");
});

test("the bundle stays inert when no module loader is present", () => {
  const sandbox = { window: {}, setTimeout, clearTimeout, Promise, Math, console };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(CLIENT_SOURCE, sandbox, { filename: "client.js" }));
});

test("handleNotification reports unsupported when Notification is missing", () => {
  const { api } = loadBundle();
  const outcome = api.handleNotification({ title: "T", body: "B" }, {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "notifications-unsupported");
});

test("handleNotification reports permission-not-granted when permission is default or denied", () => {
  const { api } = loadBundle();
  const { MockNotification } = createMockNotificationClass("denied");
  const outcome = api.handleNotification({ title: "T" }, { Notification: MockNotification });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "permission-not-granted");
});

test("handleNotification suppresses notification when window is focused and policy requests it", () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const doc = createMockDocument("visible", true);

  const outcome = api.handleNotification({ title: "T", suppressWhenFocused: true }, {
    Notification: MockNotification,
    document: doc,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.suppressed, true);
  assert.equal(outcome.reason, "app-focused");
  assert.equal(instances.length, 0);
});

test("handleNotification creates Notification when document is in background", () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const doc = createMockDocument("hidden", false);
  const win = createMockWindow();

  const outcome = api.handleNotification({
    title: "Session Finished",
    body: "Done in 5s",
    suppressWhenFocused: true,
    silent: true,
  }, {
    Notification: MockNotification,
    document: doc,
    window: win,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.suppressed, false);
  assert.equal(instances.length, 1);

  const n = instances[0];
  assert.equal(n.title, "Session Finished");
  assert.equal(n.options.body, "Done in 5s");
  assert.equal(n.options.silent, true);

  // Trigger click
  n.onclick();
  assert.equal(win.focused, true);
  assert.equal(n.closed, true);
});

test("clicking a notification navigates to the session it announced", () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const doc = createMockDocument("hidden", false);
  const win = createMockWindow();
  const navigated = [];

  api.handleNotification({
    title: "Turn done",
    body: "Body",
    sessionId: "session-42",
    suppressWhenFocused: true,
  }, {
    Notification: MockNotification,
    document: doc,
    window: win,
    navigate: (sessionId) => {
      navigated.push(sessionId);
      return Promise.resolve({ ok: true, via: "uiWorkspace" });
    },
  });

  assert.equal(instances.length, 1);
  instances[0].onclick();

  assert.deepEqual(navigated, ["session-42"]);
  assert.equal(win.focused, true);
});

test("a click without a navigate seam still focuses and never throws", () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const win = createMockWindow();

  api.handleNotification({ title: "T", sessionId: "session-1" }, {
    Notification: MockNotification,
    window: win,
  });

  assert.doesNotThrow(() => instances[0].onclick());
  assert.equal(win.focused, true);
});

test("a throwing navigator cannot break the notification click", () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");

  api.handleNotification({ title: "T", sessionId: "session-1" }, {
    Notification: MockNotification,
    window: createMockWindow(),
    navigate: () => {
      throw new Error("navigation exploded");
    },
  });

  assert.doesNotThrow(() => instances[0].onclick());
});

test("createSessionNavigator opens the session through uiWorkspace", async () => {
  const { api } = loadBundle();
  const opened = [];
  const navigator = api.createSessionNavigator({
    getService: (svcName) => (svcName === "uiWorkspace" ? { openSession: (id) => opened.push(id) } : undefined),
    wait: () => Promise.resolve(),
  });

  const outcome = await navigator("session-7");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.via, "uiWorkspace");
  assert.deepEqual(opened, ["session-7"]);
});

test("createSessionNavigator prefers uiWorkspace over sessions.open", async () => {
  const { api } = loadBundle();
  const calls = [];
  const navigator = api.createSessionNavigator({
    getService: (name) => (
      name === "uiWorkspace"
        ? { openSession: (id) => calls.push(`workspace:${id}`) }
        : { open: (id) => calls.push(`sessions:${id}`) }
    ),
    wait: () => Promise.resolve(),
  });

  await navigator("s-1");
  assert.deepEqual(calls, ["workspace:s-1"]);
});

test("createSessionNavigator falls back to sessions.open without a workspace", async () => {
  const { api } = loadBundle();
  const calls = [];
  const navigator = api.createSessionNavigator({
    getService: (name) => (name === "sessions" ? { open: (id) => calls.push(id) } : undefined),
    wait: () => Promise.resolve(),
  });

  const outcome = await navigator("s-2");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.via, "sessions");
  assert.deepEqual(calls, ["s-2"]);
});

test("createSessionNavigator refreshes a cold catalog before retrying", async () => {
  const { api } = loadBundle();
  let listed = false;
  const refreshes = [];
  const opened = [];

  const navigator = api.createSessionNavigator({
    attempts: 5,
    wait: () => Promise.resolve(),
    getService: (name) => {
      if (name === "sessions") {
        return {
          refresh: async () => {
            refreshes.push(1);
            listed = true;
          },
        };
      }
      if (name !== "uiWorkspace" || !listed) return undefined;
      return { openSession: (id) => opened.push(id) };
    },
  });

  // The workspace provider only appears once the catalog lists the session.
  const outcome = await navigator("late-session");
  assert.equal(outcome.ok, true);
  assert.ok(refreshes.length >= 1);
  assert.deepEqual(opened, ["late-session"]);
});

test("createSessionNavigator retries when openSession throws for an unlisted session", async () => {
  const { api } = loadBundle();
  let ready = false;
  let opens = 0;

  const navigator = api.createSessionNavigator({
    attempts: 4,
    wait: () => Promise.resolve(),
    getService: (name) => {
      if (name === "sessions") {
        return { refresh: async () => { ready = true; } };
      }
      if (name !== "uiWorkspace") return undefined;
      return {
        openSession: (id) => {
          opens += 1;
          if (!ready) throw new Error(`sessions.retain: unknown session ${id}`);
        },
      };
    },
  });

  const outcome = await navigator("s-retry");
  assert.equal(outcome.ok, true);
  assert.ok(opens >= 2, `expected a retry after the first throw, saw ${opens}`);
});

test("createSessionNavigator reports failure when no opener ever appears", async () => {
  const { api } = loadBundle();
  const navigator = api.createSessionNavigator({
    attempts: 2,
    wait: () => Promise.resolve(),
    getService: () => undefined,
  });

  const outcome = await navigator("nowhere");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "session-unavailable");
});

test("createSessionNavigator reports no-session for a missing id", async () => {
  const { api } = loadBundle();
  const navigator = api.createSessionNavigator({ getService: () => undefined });
  // Values come from the vm realm, so compare fields rather than prototypes.
  for (const missing of [undefined, ""]) {
    const outcome = await navigator(missing);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "no-session");
  }
});

test("createNotificationClient receives payloads from EventSource", () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const { MockEventSource, instances: esList } = createMockEventSourceClass();
  const doc = createMockDocument("hidden", false);
  const win = createMockWindow();

  const client = api.createNotificationClient({
    url: "/dsh-notified/events",
    env: {
      Notification: MockNotification,
      EventSource: MockEventSource,
      document: doc,
      window: win,
    },
  });

  assert.equal(esList.length, 1);
  const es = esList[0];
  assert.equal(es.url, "/dsh-notified/events");

  // Send message
  es.send({ title: "ES Message", body: "Payload body", suppressWhenFocused: false });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].title, "ES Message");
  assert.equal(instances[0].options.body, "Payload body");

  client.dispose();
  assert.equal(es.closed, true);
});

test("a click on an SSE-delivered notification opens the announced session", async () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const { MockEventSource, instances: esList } = createMockEventSourceClass();
  const opened = [];

  const client = api.createNotificationClient({
    getService: (name) => (name === "uiWorkspace" ? { openSession: (id) => opened.push(id) } : undefined),
    wait: () => Promise.resolve(),
    env: {
      Notification: MockNotification,
      EventSource: MockEventSource,
      document: createMockDocument("hidden", false),
      window: createMockWindow(),
    },
  });

  esList[0].send({ title: "Turn done", body: "Body", sessionId: "sse-session", suppressWhenFocused: false });
  assert.equal(instances.length, 1);

  instances[0].onclick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(opened, ["sse-session"]);
  client.dispose();
});

test("an explicit navigate option overrides getService", async () => {
  const { api } = loadBundle();
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const { MockEventSource, instances: esList } = createMockEventSourceClass();
  const navigated = [];
  let lookedUp = false;

  api.createNotificationClient({
    navigate: (sessionId) => {
      navigated.push(sessionId);
      return Promise.resolve({ ok: true });
    },
    getService: () => {
      lookedUp = true;
      return undefined;
    },
    env: {
      Notification: MockNotification,
      EventSource: MockEventSource,
      document: createMockDocument("hidden", false),
      window: createMockWindow(),
    },
  });

  assert.equal(esList.length, 1);
  esList[0].send({ title: "T", sessionId: "explicit", suppressWhenFocused: false });
  instances[0].onclick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(navigated, ["explicit"]);
  assert.equal(lookedUp, false);
});

test("createNotificationClient attaches gesture listener when permission is default", () => {
  const { api } = loadBundle();
  const { MockNotification } = createMockNotificationClass("default");
  const win = createMockWindow();

  const client = api.createNotificationClient({
    env: {
      Notification: MockNotification,
      window: win,
    },
  });

  assert.equal(win.listenerCount("click"), 1);
  assert.equal(win.listenerCount("keydown"), 1);

  // User click triggers requestPermission
  win.emit("click");
  assert.equal(MockNotification.requests, 1);
  assert.equal(win.listenerCount("click"), 0);

  client.dispose();
});

test("apply registers disposal hook in Cordis context", () => {
  const { api } = loadBundle();
  let cleanup;
  const ctx = {
    effect: (fn) => {
      cleanup = fn();
    },
  };

  api.apply(ctx);
  assert.equal(typeof cleanup, "function");
  assert.doesNotThrow(() => cleanup());
});

test("apply resolves services lazily through ctx.get and never parks", () => {
  const { api } = loadBundle();
  const requested = [];
  let disposer;
  const ctx = {
    get: (svcName) => {
      requested.push(svcName);
      return undefined;
    },
    effect: (fn) => {
      disposer = fn();
    },
  };

  // inject stays empty so a page without the Workspace UI still activates.
  assert.deepEqual([...api.inject], []);
  assert.doesNotThrow(() => api.apply(ctx));
  assert.equal(typeof disposer, "function");
  assert.doesNotThrow(() => disposer());
  // The lookup is deferred to click time, so nothing is read during apply.
  assert.deepEqual(requested, []);
});

/**
 * A tiny EventSource good enough to drive the real client over real HTTP: the
 * Host half streams SSE, and this consumes it exactly as a browser would.
 */
class NodeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.buffer = "";
    this.controller = new AbortController();
    void this.#start();
  }

  async #start() {
    let response;
    try {
      response = await fetch(this.url, { signal: this.controller.signal });
    } catch {
      if (!this.closed) this.onerror?.(new Error("connect failed"));
      return;
    }
    if (!response.ok || response.body === null) {
      this.onerror?.(new Error(`bad response ${response.status}`));
      return;
    }
    this.onopen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
          const frame = this.buffer.slice(0, sep);
          this.buffer = this.buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            this.onmessage?.({ data: line.slice(6) });
          }
        }
      }
    } catch {
      if (!this.closed) this.onerror?.(new Error("stream ended"));
    }
  }

  close() {
    this.closed = true;
    this.controller.abort();
  }
}

test("end to end: a real HTTP SSE notification drives the shipped bundle to notify and jump", async () => {
  const { WebNotificationHub, EVENT_ROUTE_PATH } = await import("../lib/web.js");
  const { createServer } = await import("node:http");

  const hub = new WebNotificationHub();
  const server = createServer((req, res) => {
    if (req.url === EVENT_ROUTE_PATH) {
      hub.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Everything after listen() stays inside the try: a parse failure in the
  // bundle must still close the server, or the runner hangs on the open handle.
  let client;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const { api } = loadBundle();
    const { MockNotification, instances } = createMockNotificationClass("granted");
    const opened = [];

    client = api.createNotificationClient({
      url: `http://127.0.0.1:${port}${EVENT_ROUTE_PATH}`,
      getService: (svcName) => (svcName === "uiWorkspace" ? { openSession: (id) => opened.push(id) } : undefined),
      wait: () => Promise.resolve(),
      env: {
        Notification: MockNotification,
        EventSource: NodeEventSource,
        document: createMockDocument("hidden", false),
        window: createMockWindow(),
      },
    });

    // Wait for the browser-facing connection to actually register.
    for (let i = 0; i < 100 && hub.clientCount === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(hub.clientCount, 1, "the client must open a live SSE stream");

    await hub.broadcast({ title: "Real turn", body: "Over HTTP", sessionId: "live-session" });

    for (let i = 0; i < 100 && instances.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(instances.length, 1, "the notification must arrive over real SSE");

    instances[0].onclick();
    for (let i = 0; i < 100 && opened.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(opened, ["live-session"], "clicking must reopen the announced session");
  } finally {
    client?.dispose();
    hub.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
