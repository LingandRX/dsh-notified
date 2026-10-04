(function () {
  "use strict";

  /**
   * dsh-notified client plugin for DSH Web.
   *
   * Connects to the host's SSE route (`/dsh-notified/events`) to receive
   * turn-settlement notifications, evaluates the browser's focus state, and
   * triggers native HTML5 Web Notifications whose click reopens the Session the
   * Host announced.
   *
   * ## Why this file is a classic script
   *
   * The Harness serves every `dsh.client` bundle as a **classic script** — its
   * transport appends `<script src=…>` with no `type="module"` — and the bundle
   * only has to call `window.__ModuleLoader__.load({ id, factory })`. A bundle
   * written with a top-level `export` (or `import.meta`) is therefore a parse
   * error in the browser and never activates, which is the failure this shape
   * exists to prevent. The implementation is inlined because a classic script
   * cannot `import`, and this package deliberately carries no bundler.
   *
   * `test/client.test.js` evaluates these exact bytes in a `node:vm` context
   * with a fake module loader, so the suite exercises the shipped artifact
   * rather than a parallel module copy.
   */

  /** Plugin identity for the Cordis client loader. */
  const name = "dsh-notified";

  /**
   * Client services required by this plugin.
   *
   * Deliberately empty: the notification channel must activate even on a page
   * where the Workspace UI never mounts. The Session opener resolves its
   * services lazily through `ctx.get()` at click time instead, so a missing
   * provider only costs the jump, never the notification.
   */
  const inject = [];

  /**
   * Build the click-through that reopens the Session a notification announced.
   *
   * Services are re-read on every attempt rather than captured once: the Client
   * `uiWorkspace` provider can activate after this plugin, and the Host catalog
   * may not list a Session created moments before the notification was sent.
   * Each attempt therefore resolves the services again, asks the catalog to
   * refresh, and retries until `attempts` is spent.
   *
   * `uiWorkspace.openSession(id)` is the shell's own navigation primitive: it
   * synchronously replaces the main view reference, returns the main area to the
   * Conversation, and loads the history inside the selected Session view.
   * @param {object} [env] - Seams: `getService`, `wait`, `attempts`, `refreshDelayMs`.
   * @returns {(sessionId: string) => Promise<{ ok: boolean, via?: string, reason?: string }>}
   */
  function createSessionNavigator(env) {
    const options = env || {};
    const getService = options.getService || function () { return undefined; };
    const wait = options.wait || function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };
    const attempts = options.attempts === undefined ? 25 : options.attempts;
    const refreshDelayMs = options.refreshDelayMs === undefined ? 120 : options.refreshDelayMs;

    return async function navigate(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, reason: "no-session" };
      }

      let lastError;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const workspace = getService("uiWorkspace");
        const sessions = getService("sessions");
        const via = workspace && typeof workspace.openSession === "function"
          ? "uiWorkspace"
          : sessions && typeof sessions.open === "function"
            ? "sessions"
            : undefined;

        if (via !== undefined) {
          try {
            if (via === "uiWorkspace") workspace.openSession(sessionId);
            else sessions.open(sessionId);
            return { ok: true, via: via };
          } catch (error) {
            // A cold catalog throws for a Session it has not listed yet.
            lastError = error;
          }
        }

        if (sessions && typeof sessions.refresh === "function") {
          try {
            await sessions.refresh();
          } catch (error) {
            if (lastError === undefined) lastError = error;
          }
        }
        if (attempt < attempts - 1) await wait(refreshDelayMs);
      }

      return {
        ok: false,
        reason: lastError === undefined ? "session-unavailable" : String(lastError.message || lastError),
      };
    };
  }

  /**
   * Handle one incoming notification payload inside a browser-like environment.
   * @param {object} payload - Notification payload from the host.
   * @param {object} [env] - Ambient browser globals (injectable for unit tests).
   * @returns {{ ok: boolean, suppressed: boolean, reason?: string }}
   */
  function handleNotification(payload, env) {
    const context = env || {};
    const NotificationApi = context.Notification
      || (typeof Notification !== "undefined" ? Notification : undefined);
    const doc = context.document || (typeof document !== "undefined" ? document : undefined);
    const win = context.window || (typeof window !== "undefined" ? window : undefined);

    if (!NotificationApi) {
      return { ok: false, suppressed: false, reason: "notifications-unsupported" };
    }

    if (NotificationApi.permission !== "granted") {
      return { ok: false, suppressed: false, reason: "permission-not-granted" };
    }

    // Focus policy: a user already looking at the tab needs no interruption.
    if (payload.suppressWhenFocused && doc) {
      const isVisible = doc.visibilityState === "visible";
      const hasFocus = typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
      if (isVisible && hasFocus) {
        return { ok: true, suppressed: true, reason: "app-focused" };
      }
    }

    const title = payload.title || "DeepSeek Harness";
    const notificationOptions = {
      body: payload.body || "",
      icon: payload.icon || "/icon.png",
      tag: payload.tag || "dsh-turn-end",
      silent: payload.silent === undefined ? false : payload.silent,
    };

    try {
      const notification = new NotificationApi(title, notificationOptions);
      if (win) {
        notification.onclick = function () {
          try {
            if (typeof win.focus === "function") win.focus();
          } catch {
            // Ignore focus failures
          }
          // Reopen the Session this notification announced. The payload carries
          // the id from the Host; without an opener a click can only focus the
          // tab, which is the tab the user is already looking at.
          const navigate = context.navigate;
          if (typeof navigate === "function") {
            try {
              Promise.resolve(navigate(payload.sessionId)).catch(function () {});
            } catch {
              // Ignore navigation failures: the notification already landed.
            }
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
      return { ok: false, suppressed: false, reason: String((err && err.message) || err) };
    }
  }

  /**
   * Create and manage an SSE connection to the notification hub.
   * @param {object} [options]
   * @param {string} [options.url] - SSE endpoint URL.
   * @param {object} [options.env] - Ambient browser globals seam.
   * @param {Function} [options.getService] - Lazy service lookup, called per click.
   * @param {Function} [options.navigate] - Explicit Session opener, overriding both.
   * @returns {{ dispose: () => void, reconnect: () => void }}
   */
  function createNotificationClient(options) {
    const settings = options || {};
    const url = settings.url || "/dsh-notified/events";
    const env = settings.env || {};
    const EventSourceApi = env.EventSource
      || (typeof EventSource !== "undefined" ? EventSource : undefined);
    const NotificationApi = env.Notification
      || (typeof Notification !== "undefined" ? Notification : undefined);
    const win = env.window || (typeof window !== "undefined" ? window : undefined);

    // A click reopens the notified Session. The lookup stays lazy because the
    // Client `uiWorkspace`/`sessions` providers may activate after this plugin.
    let navigate = settings.navigate || env.navigate;
    if (navigate === undefined && typeof settings.getService === "function") {
      navigate = createSessionNavigator({
        getService: settings.getService,
        wait: settings.wait,
      });
    }
    const clickEnv = navigate === undefined ? env : Object.assign({}, env, { navigate: navigate });

    // Ask for permission on the first real user gesture: browsers reject a
    // permission prompt that no interaction precedes.
    const removeGestureListeners = [];
    if (NotificationApi && NotificationApi.permission === "default" && win && win.addEventListener) {
      const trigger = function () {
        try {
          if (typeof NotificationApi.requestPermission === "function") {
            Promise.resolve(NotificationApi.requestPermission()).catch(function () {});
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
        function () { win.removeEventListener("click", trigger, true); },
        function () { win.removeEventListener("keydown", trigger, true); },
      );
    }

    let es = null;
    let timer = null;
    let attempts = 0;
    let disposed = false;

    function scheduleReconnect() {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      const delay = Math.min(1000 * Math.pow(1.5, attempts), 30000);
      attempts += 1;
      timer = setTimeout(connect, delay);
    }

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

      es.onopen = function () {
        attempts = 0;
      };

      es.onmessage = function (event) {
        if (!event.data) return;
        try {
          handleNotification(JSON.parse(event.data), clickEnv);
        } catch {
          // Ignore malformed event payloads
        }
      };

      es.onerror = function () {
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

    connect();

    return {
      reconnect: function () {
        attempts = 0;
        connect();
      },
      dispose: function () {
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
   * @param {object} ctx - Client Cordis context. Services are read through `get`
   *   at click time, so this plugin never parks waiting for a UI provider.
   */
  function apply(ctx) {
    const client = createNotificationClient({
      getService: function (svcName) {
        if (ctx && typeof ctx.get === "function") return ctx.get(svcName);
        return ctx ? ctx[svcName] : undefined;
      },
    });
    if (ctx && typeof ctx.effect === "function") {
      ctx.effect(function () { return function () { client.dispose(); }; });
    }
  }

  // The plugin surface. The helpers ride along so tests can drive the exact
  // shipped artifact; Cordis itself reads only `name`, `inject`, and `apply`.
  const api = {
    name: name,
    inject: inject,
    apply: apply,
    createSessionNavigator: createSessionNavigator,
    handleNotification: handleNotification,
    createNotificationClient: createNotificationClient,
  };

  const loader = typeof window !== "undefined" ? window.__ModuleLoader__ : undefined;
  if (loader && typeof loader.load === "function") {
    loader.load({ id: name, factory: function () { return api; } });
  }
})();
