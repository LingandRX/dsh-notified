import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { DEFAULT_HEARTBEAT_MS, EVENT_ROUTE_PATH, WebNotificationHub } from "../lib/web.js";

/** Create a fake ServerResponse with mock writeHead, write, end, and event emitter. */
function mockResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 0;
  res.written = [];
  res.ended = false;

  res.writeHead = (code, headers = {}) => {
    res.statusCode = code;
    res.headers = { ...res.headers, ...headers };
    return res;
  };

  res.write = (chunk) => {
    res.written.push(String(chunk));
    return true;
  };

  res.end = (chunk) => {
    if (chunk) res.written.push(String(chunk));
    res.ended = true;
    res.emit("close");
    return res;
  };

  return res;
}

/** Create a fake IncomingMessage. */
function mockRequest(method = "GET", headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  return req;
}

test("WebNotificationHub initializes with defaults", () => {
  const hub = new WebNotificationHub();
  assert.equal(hub.clientCount, 0);
  assert.equal(hub.hasClients, false);
  assert.equal(hub.heartbeatMs, DEFAULT_HEARTBEAT_MS);
});

test("handleRequest rejects non-GET/HEAD methods with 405", () => {
  const hub = new WebNotificationHub();
  const req = mockRequest("POST");
  const res = mockResponse();

  hub.handleRequest(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.ended, true);
  assert.ok(res.written.some((w) => w.includes("Method Not Allowed")));
  assert.equal(hub.clientCount, 0);
});

test("handleRequest responds to HEAD without registering a client", () => {
  const hub = new WebNotificationHub();
  const req = mockRequest("HEAD");
  const res = mockResponse();

  hub.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.ended, true);
  assert.equal(hub.clientCount, 0);
});

test("handleRequest establishes SSE stream and registers client", () => {
  const hub = new WebNotificationHub({ heartbeatMs: 0 });
  const req = mockRequest("GET");
  const res = mockResponse();

  hub.handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res.headers.Connection, "keep-alive");
  assert.ok(res.written.includes(":connected\n\n"));
  assert.equal(hub.clientCount, 1);
  assert.equal(hub.hasClients, true);

  // Client disconnects
  req.emit("close");
  assert.equal(hub.clientCount, 0);
  assert.equal(hub.hasClients, false);
});

test("broadcast formats SSE data and writes to all connected clients", async () => {
  const hub = new WebNotificationHub({ heartbeatMs: 0 });
  const req1 = mockRequest("GET");
  const res1 = mockResponse();
  const req2 = mockRequest("GET");
  const res2 = mockResponse();

  hub.handleRequest(req1, res1);
  hub.handleRequest(req2, res2);
  assert.equal(hub.clientCount, 2);

  const payload = { title: "Turn Finished", body: "Task completed successfully." };
  const outcome = await hub.broadcast(payload);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 0);
  assert.ok(outcome.detail.includes("2"));

  const expectedData = `data: ${JSON.stringify(payload)}\n\n`;
  assert.ok(res1.written.includes(expectedData));
  assert.ok(res2.written.includes(expectedData));
});

test("broadcast gracefully succeeds when no clients are connected", async () => {
  const hub = new WebNotificationHub();
  const outcome = await hub.broadcast({ title: "T", body: "B" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 0);
  assert.ok(outcome.detail.includes("no web clients"));
});

test("broadcast removes clients whose write fails", async () => {
  const hub = new WebNotificationHub({ heartbeatMs: 0 });
  const req = mockRequest("GET");
  const res = mockResponse();

  hub.handleRequest(req, res);
  assert.equal(hub.clientCount, 1);

  res.write = () => {
    throw new Error("Broken pipe");
  };

  const outcome = await hub.broadcast({ title: "Fail" });
  assert.equal(outcome.ok, true);
  assert.equal(hub.clientCount, 0);
});

test("ping writes keepalive comment to connected clients", () => {
  const hub = new WebNotificationHub({ now: () => 123456789 });
  const req = mockRequest("GET");
  const res = mockResponse();

  hub.handleRequest(req, res);
  hub.ping();

  assert.ok(res.written.includes(":keepalive 123456789\n\n"));
  hub.dispose();
});

test("attach registers the route on webServer and dispose unregisters it", () => {
  const hub = new WebNotificationHub({ heartbeatMs: 0 });
  const registered = [];
  let unregistered = false;

  const mockWebServer = {
    register: (route) => {
      registered.push(route);
      return () => {
        unregistered = true;
      };
    },
  };

  const detach = hub.attach(mockWebServer);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "exact");
  assert.equal(registered[0].path, EVENT_ROUTE_PATH);
  assert.equal(typeof registered[0].handler, "function");

  // Call handler to verify registration
  const req = mockRequest("GET");
  const res = mockResponse();
  registered[0].handler(req, res);
  assert.equal(hub.clientCount, 1);

  detach();
  assert.equal(unregistered, true);
  assert.equal(hub.clientCount, 0);
  assert.equal(res.ended, true);
});

test("attach tolerates null or invalid webServer", () => {
  const hub = new WebNotificationHub();
  const detach = hub.attach(null);
  assert.equal(typeof detach, "function");
  detach();
});
