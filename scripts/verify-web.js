/**
 * Local end-to-end verification server for the Web notification channel.
 *
 * Run:   node scripts/verify-web.js
 * Open:  http://127.0.0.1:3999
 *
 * It serves `client.js` the way the Harness does — as a classic script that
 * calls `window.__ModuleLoader__.load(...)` — so a bundle that would fail to
 * parse in the browser fails here too. A tiny fake Cordis context supplies the
 * `uiWorkspace` service so the notification click-through can be exercised
 * without a full DSH page.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebNotificationHub, EVENT_ROUTE_PATH } from "../lib/web.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientJs = readFileSync(join(__dirname, "../client.js"), "utf8");
const iconPng = (() => {
  try {
    return readFileSync(join(__dirname, "../icon.png"));
  } catch {
    return undefined;
  }
})();

const hub = new WebNotificationHub();
const PORT = Number(process.env.PORT ?? 3999);

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>dsh-notified Web 验证页面</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    button { padding: 10px 18px; font-size: 14px; margin-right: 10px; margin-bottom: 10px; cursor: pointer; border-radius: 6px; border: 1px solid #ccc; background: #0070f3; color: white; }
    button.secondary { background: #f5f5f5; color: #333; }
    .status { padding: 12px; border-radius: 6px; background: #eef7ff; margin: 15px 0; border: 1px solid #b8daff; }
    .log { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 12px; height: 200px; overflow-y: auto; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h2>🔔 dsh-notified Web 通知端到端验证</h2>
  <div class="status" id="perm-status">权限状态检测中...</div>
  <div>
    <button id="req-perm">1. 申请浏览器通知权限</button>
    <button class="secondary" id="send-test">2. 发送测试通知（含会话跳转）</button>
    <button class="secondary" id="send-suppress">3. 焦点抑制通知（3 秒倒计时）</button>
  </div>
  <p><small>💡 提示：通知在页面失去焦点时弹出。点击通知应唤起本标签页 <b>并</b> “跳转”到对应会话（本页用假的 uiWorkspace 记录该调用，日志可见）。</small></p>
  <h3>事件日志</h3>
  <div class="log" id="log"></div>

  <script>
    // ---- A minimal stand-in for the DSH shell -------------------------------
    // The real page provides this via the Cordis client runtime; here it only
    // needs to record openSession() so the click-through is observable.
    window.__navigated = [];
    var fakeContext = {
      get: function (name) {
        if (name === "uiWorkspace") {
          return {
            openSession: function (sessionId) { window.__navigated.push(sessionId); }
          };
        }
        return undefined;
      },
      effect: function (fn) { fn(); }
    };
  </script>

  <script>
    // Serve/execute the shipped bundle exactly as the Harness does.
    window.__ModuleLoader__ = { load: function (registration) { window.__dshPlugin = registration; } };
  </script>
  <script src="/client.js"></script>

  <script>
    const logBox = document.getElementById("log");
    function log(msg) {
      logBox.textContent += "[" + new Date().toLocaleTimeString() + "] " + msg + "\\n";
      logBox.scrollTop = logBox.scrollHeight;
    }

    const statusBox = document.getElementById("perm-status");
    function updateStatus() {
      const perm = window.Notification ? Notification.permission : "unsupported";
      statusBox.innerHTML = "<b>当前通知权限:</b> <code>" + perm + "</code>" +
        (perm === "granted" ? " ✅ 已就绪" : perm === "denied" ? " ❌ 已被禁用（请在地址栏左侧网站设置中开启）" : " ⚠️ 待申请");
    }
    updateStatus();

    // Prove the bundle registered and expose its surface for the page.
    const registration = window.__dshPlugin;
    if (!registration || registration.id !== "dsh-notified") {
      log("❌ client.js 未按预期注册（classic script 解析失败？）");
    } else {
      window.__api = registration.factory();
      log("✅ client.js 已作为 classic script 注册：id=" + registration.id);
      window.__api.apply(fakeContext);
      log("✅ apply() 已挂载，EventSource 正在订阅 " + "${EVENT_ROUTE_PATH}");
    }

    document.getElementById("req-perm").onclick = async () => {
      if (!window.Notification) return alert("浏览器不支持 Notification API");
      const res = await Notification.requestPermission();
      updateStatus();
      log("申请权限结果: " + res);
    };

    document.getElementById("send-test").onclick = () => {
      const sessionId = "demo-session-" + Date.now().toString(36);
      fetch("/api/test-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "DeepSeek Harness（测试）",
          body: "端到端测试通知：点击应唤回本页并跳转到会话。",
          sessionId: sessionId,
          suppressWhenFocused: false
        })
      });
      log("已触发测试通知，目标 sessionId=" + sessionId);
      log("（切换到其他窗口，再点击系统通知，观察下方是否记录跳转）");
    };

    document.getElementById("send-suppress").onclick = () => {
      log("3 秒后发送带焦点抑制的通知... 请立即切到其他标签页或最小化浏览器！");
      setTimeout(() => {
        fetch("/api/test-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "会话已完成（焦点抑制测试）",
            body: "代码生成结束，用时 4 秒。(4s)",
            sessionId: "demo-suppress",
            suppressWhenFocused: true
          })
        });
      }, 3000);
    };

    // Report the click-through outcome back into the page log.
    setInterval(() => {
      const seen = window.__navigated;
      if (seen.length > window.__reported) {
        for (const id of seen.slice(window.__reported)) log("🔗 已跳转到会话: " + id);
        window.__reported = seen.length;
      }
    }, 300);
    window.__reported = 0;
  </script>
</body>
</html>
`;

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (url === EVENT_ROUTE_PATH) {
    hub.handleRequest(req, res);
    return;
  }

  // The bundle is served verbatim, exactly like the client-modules route.
  if (url === "/client.js" || url.startsWith("/client.js?")) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(clientJs);
    return;
  }

  if (url === "/icon.png" && iconPng !== undefined) {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(iconPng);
    return;
  }

  if (url === "/api/test-notify" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
        return;
      }
      const outcome = await hub.broadcast(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...outcome, clientCount: hub.clientCount }));
    });
    return;
  }

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n🚀 dsh-notified 本地验证服务已启动:");
  console.log(`👉 请用浏览器打开: http://127.0.0.1:${PORT}`);
  console.log("按 Ctrl+C 可停止服务。\n");
});
