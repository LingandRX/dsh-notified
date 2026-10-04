import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { apply, createNotificationClient, handleNotification, inject, name } from "../client.js";

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

test("client exports cordis contract", () => {
  assert.equal(name, "dsh-notified");
  assert.deepEqual(inject, []);
  assert.equal(typeof apply, "function");
});

test("handleNotification reports unsupported when Notification is missing", () => {
  const outcome = handleNotification({ title: "T", body: "B" }, {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "notifications-unsupported");
});

test("handleNotification reports permission-not-granted when permission is default or denied", () => {
  const { MockNotification } = createMockNotificationClass("denied");
  const outcome = handleNotification({ title: "T" }, { Notification: MockNotification });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "permission-not-granted");
});

test("handleNotification suppresses notification when window is focused and policy requests it", () => {
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const doc = createMockDocument("visible", true);

  const outcome = handleNotification({ title: "T", suppressWhenFocused: true }, {
    Notification: MockNotification,
    document: doc,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.suppressed, true);
  assert.equal(outcome.reason, "app-focused");
  assert.equal(instances.length, 0);
});

test("handleNotification creates Notification when document is in background", () => {
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const doc = createMockDocument("hidden", false);
  const win = createMockWindow();

  const outcome = handleNotification({
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

test("createNotificationClient receives payloads from EventSource", () => {
  const { MockNotification, instances } = createMockNotificationClass("granted");
  const { MockEventSource, instances: esList } = createMockEventSourceClass();
  const doc = createMockDocument("hidden", false);
  const win = createMockWindow();

  const client = createNotificationClient({
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

test("createNotificationClient attaches gesture listener when permission is default", () => {
  const { MockNotification } = createMockNotificationClass("default");
  const win = createMockWindow();

  const client = createNotificationClient({
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
  let cleanedUp = false;
  const ctx = {
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === "function") {
        cleanedUp = true;
      }
    },
  };

  apply(ctx);
  assert.equal(cleanedUp, true);
});
