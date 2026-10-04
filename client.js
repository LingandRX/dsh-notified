/**
 * dsh-notified client plugin for DSH Web.
 *
 * Runs inside the browser web client. It connects to the host's SSE route
 * (`/dsh-notified/events`) to receive turn-settlement notifications, evaluates
 * the browser's focus state, and triggers native HTML5 Web Notifications.
 *
 * @module dsh-notified/client
 */

/** Plugin identity for Cordis client loader. */
export const name = "dsh-notified";

/** Client services required by this plugin. */
export const inject = [];

/**
 * Handle one incoming notification payload inside a browser-like environment.
 * @param {object} payload - Notification payload from the host.
 * @param {object} [env] - Ambient browser globals (injectable for unit tests).
 * @returns {{ ok: boolean, suppressed: boolean, reason?: string }}
 */
export function handleNotification(payload, env = {}) {
  const NotificationApi = env.Notification ?? (typeof Notification !== "undefined" ? Notification : undefined);
  const doc = env.document ?? (typeof document !== "undefined" ? document : undefined);
  const win = env.window ?? (typeof window !== "undefined" ? window : undefined);

  if (!NotificationApi) {
    return { ok: false, suppressed: false, reason: "notifications-unsupported" };
  }

  if (NotificationApi.permission !== "granted") {
    return { ok: false, suppressed: false, reason: "permission-not-granted" };
  }

  // Check focus policy: if user is actively focused on the tab, suppress if requested
  if (payload.suppressWhenFocused && doc) {
    const isVisible = doc.visibilityState === "visible";
    const hasFocus = typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
    if (isVisible && hasFocus) {
      return { ok: true, suppressed: true, reason: "app-focused" };
    }
  }

  const title = payload.title || "DeepSeek Harness";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon.png",
    tag: payload.tag || "dsh-turn-end",
    silent: payload.silent ?? false,
  };

  try {
    const notification = new NotificationApi(title, options);
    if (win) {
      notification.onclick = () => {
        try {
          if (typeof win.focus === "function") win.focus();
        } catch {
          // Ignore focus failures
        }
        try {
          if (typeof notification.close === "function") notification.close();
        } catch {
          // Ignore close failures
        }
      };
    }
    return { ok: true, suppressed: false };
  } catch (err) {
    return { ok: false, suppressed: false, reason: String(err?.message ?? err) };
  }
}

/**
 * Create and manage an SSE connection to the notification hub.
 * @param {object} [options]
 * @param {string} [options.url] - SSE endpoint URL.
 * @param {object} [options.env] - Ambient browser globals seam.
 * @returns {{ dispose: () => void, reconnect: () => void }}
 */
export function createNotificationClient(options = {}) {
  const url = options.url ?? "/dsh-notified/events";
  const env = options.env ?? {};
  const EventSourceApi = env.EventSource ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
  const NotificationApi = env.Notification ?? (typeof Notification !== "undefined" ? Notification : undefined);
  const win = env.window ?? (typeof window !== "undefined" ? window : undefined);

  // Hook auto-request on user gesture if permission is default
  const removeGestureListeners = [];
  if (NotificationApi && NotificationApi.permission === "default" && win?.addEventListener) {
    const trigger = () => {
      try {
        if (typeof NotificationApi.requestPermission === "function") {
          void NotificationApi.requestPermission().catch(() => {});
        }
      } catch {
        // Ignore gesture errors
      }
      for (const remove of removeGestureListeners) remove();
      removeGestureListeners.length = 0;
    };

    win.addEventListener("click", trigger, true);
    win.addEventListener("keydown", trigger, true);
    removeGestureListeners.push(
      () => win.removeEventListener("click", trigger, true),
      () => win.removeEventListener("keydown", trigger, true),
    );
  }

  let es = null;
  let timer = null;
  let attempts = 0;
  let disposed = false;

  function connect() {
    if (disposed || !EventSourceApi) return;
    if (es) {
      try {
        es.close();
      } catch {
        // Ignore
      }
      es = null;
    }

    try {
      es = new EventSourceApi(url);
    } catch {
      scheduleReconnect();
      return;
    }

    es.onopen = () => {
      attempts = 0;
    };

    es.onmessage = (event) => {
      if (!event.data) return;
      try {
        const payload = JSON.parse(event.data);
        handleNotification(payload, env);
      } catch {
        // Ignore malformed event payloads
      }
    };

    es.onerror = () => {
      if (es) {
        try {
          es.close();
        } catch {
          // Ignore
        }
        es = null;
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    const delay = Math.min(1000 * Math.pow(1.5, attempts), 30000);
    attempts += 1;
    timer = setTimeout(connect, delay);
  }

  connect();

  return {
    reconnect: () => {
      attempts = 0;
      connect();
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (es) {
        try {
          es.close();
        } catch {
          // Ignore
        }
        es = null;
      }
      for (const remove of removeGestureListeners) remove();
      removeGestureListeners.length = 0;
    },
  };
}

/**
 * Client plugin apply lifecycle for Cordis.
 * @param {object} ctx - Client Cordis context.
 */
export function apply(ctx) {
  const client = createNotificationClient();
  if (typeof ctx?.effect === "function") {
    ctx.effect(() => () => client.dispose());
  }
}

// Register into DSH ModuleLoader if running in browser
if (typeof window !== "undefined" && window.__ModuleLoader__?.load) {
  window.__ModuleLoader__.load({
    id: "dsh-notified",
    factory: () => {
      const module = { exports: {} };
      module.exports.name = name;
      module.exports.inject = inject;
      module.exports.apply = apply;
      return module.exports;
    },
  });
}
