/**
 * Web notification channel for DSH Web: Server-Sent Events (SSE) broadcaster.
 *
 * In DSH Web mode (`dsh web`), the agent runs on a host process (which may be a
 * remote Linux server or local background daemon) while the user interacts
 * through a browser. The browser client connects to `/dsh-notified/events` over
 * SSE. When a conversation turn settles, this module broadcasts the composed
 * notification payload so the browser can trigger a native Web Notification.
 *
 * @module dsh-notified/web
 */

/** Route path registered on the DSH webServer. */
export const EVENT_ROUTE_PATH = "/dsh-notified/events";

/** Default heartbeat ping interval in milliseconds. */
export const DEFAULT_HEARTBEAT_MS = 25000;

/**
 * Hub managing active browser SSE connections and broadcasting notifications.
 */
export class WebNotificationHub {
  /**
   * @param {object} [options]
   * @param {number} [options.heartbeatMs] - Heartbeat interval in ms.
   * @param {Function} [options.now] - Clock seam for tests.
   */
  constructor(options = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.now = options.now ?? Date.now;
    this.clients = new Set();
    this.heartbeatTimer = undefined;
  }

  /** Current number of connected web clients. */
  get clientCount() {
    return this.clients.size;
  }

  /** Whether any web client is connected. */
  get hasClients() {
    return this.clients.size > 0;
  }

  /**
   * Start the periodic heartbeat timer if not already running.
   */
  startHeartbeat() {
    if (this.heartbeatTimer !== undefined || this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.ping();
    }, this.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Stop the periodic heartbeat timer.
   */
  stopHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Send a keepalive comment line to all connected clients.
   */
  ping() {
    const comment = `:keepalive ${this.now()}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(comment);
      } catch {
        this.clients.delete(res);
      }
    }
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }

  /**
   * Handle an incoming HTTP request for the SSE stream.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  handleRequest(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    try {
      res.write(":connected\n\n");
    } catch {
      cleanup();
      return;
    }
    this.clients.add(res);
    this.startHeartbeat();

    const cleanup = () => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this.stopHeartbeat();
      }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  /**
   * Broadcast a notification payload to all connected clients.
   * @param {object} payload - Notification data.
   * @returns {Promise<{ ok: boolean, suppressed: boolean, code: number, detail: string }>}
   */
  async broadcast(payload) {
    if (this.clients.size === 0) {
      return {
        ok: true,
        suppressed: false,
        code: 0,
        detail: "no web clients connected",
      };
    }

    const data = `data: ${JSON.stringify(payload)}\n\n`;
    let delivered = 0;

    for (const res of Array.from(this.clients)) {
      try {
        res.write(data);
        delivered += 1;
      } catch {
        this.clients.delete(res);
      }
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }

    return {
      ok: true,
      suppressed: false,
      code: 0,
      detail: `broadcast to ${delivered} web client(s)`,
    };
  }

  /**
   * Register the SSE route with the provided DSH webServer service.
   * @param {object} webServer - DSH webServer service instance.
   * @returns {() => void} Disposer unregistering the route and cleaning up.
   */
  attach(webServer) {
    if (!webServer || typeof webServer.register !== "function") {
      return () => {};
    }

    const unregister = webServer.register({
      kind: "exact",
      path: EVENT_ROUTE_PATH,
      handler: (req, res) => this.handleRequest(req, res),
    });

    return () => {
      if (typeof unregister === "function") unregister();
      this.dispose();
    };
  }

  /**
   * Dispose all active client connections and stop timers.
   */
  dispose() {
    this.stopHeartbeat();
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // Ignore errors during tear-down
      }
    }
    this.clients.clear();
  }
}
