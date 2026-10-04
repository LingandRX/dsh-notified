/**
 * 本地 Web 通知快速端到端验证服务
 * 运行方式: node scripts/verify-web.js
 * 浏览器访问: http://127.0.0.1:3999
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebNotificationHub, EVENT_ROUTE_PATH } from "../lib/web.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientJs = readFileSync(join(__dirname, "../client.js"), "utf8");

const hub = new WebNotificationHub();
const PORT = 3999;

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>dsh-notified Web 验证页面</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    button { padding: 10px 18px; font-size: 14px; margin-right: 10px; margin-bottom: 10px; cursor: pointer; border-radius: 6px; border: 1px solid #ccc; background: #0070f3; color: white; }
    button.secondary { background: #f5f5f5; color: #333; }
    .status { padding: 12px; border-radius: 6px; background: #eef7ff; margin: 15px 0; border: 1px solid #b8daff; }
    .log { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 12px; height: 180px; overflow-y: auto; }
  </style>
</head>
<body>
  <h2>🔔 dsh-notified Web 通知端到端验证</h2>
  <div class="status" id="perm-status">权限状态检测中...</div>
  <div>
    <button id="req-perm">1. 申请浏览器通知权限</button>
    <button class="secondary" id="send-test">2. 发送即时测试通知</button>
    <button class="secondary" id="send-suppress">3. 发送带焦点抑制的通知 (3秒倒计时)</button>
  </div>
  <p><small>💡 提示：点击“发送带焦点抑制的通知”后，在 3 秒倒计时内切换到其他窗口或标签页，验证离开前台时是否成功弹出系统通知；点击通知将自动切回本页面。</small></p>
  <h3>事件日志</h3>
  <div class="log" id="log"></div>

  <script type="module">
    ${clientJs.replace('if (typeof window !== "undefined" && window.__ModuleLoader__?.load)', "if (false)")}

    const logBox = document.getElementById("log");
    function log(msg) {
      logBox.innerHTML += "[" + new Date().toLocaleTimeString() + "] " + msg + "<br>";
      logBox.scrollTop = logBox.scrollHeight;
    }

    const statusBox = document.getElementById("perm-status");
    function updateStatus() {
      const perm = window.Notification ? Notification.permission : "unsupported";
      statusBox.innerHTML = "<b>当前通知权限:</b> <code>" + perm + "</code>" +
        (perm === "granted" ? " ✅ 已就绪" : perm === "denied" ? " ❌ 已被禁用 (请在浏览器地址栏左侧网站设置中开启)" : " ⚠️ 待申请");
    }
    updateStatus();

    // 启动 Client 插件连接
    createNotificationClient({
      url: "/dsh-notified/events",
      env: { Notification, document, window, EventSource }
    });
    log("已通过 EventSource 订阅 /dsh-notified/events");

    document.getElementById("req-perm").onclick = async () => {
      if (!window.Notification) return alert("浏览器不支持 Notification API");
      const res = await Notification.requestPermission();
      updateStatus();
      log("申请权限结果: " + res);
    };

    document.getElementById("send-test").onclick = () => {
      fetch("/api/test-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "DeepSeek Harness (测试)",
          body: "这是一条端到端 Web 测试通知，点击可唤回本页面！",
          suppressWhenFocused: false
        })
      });
      log("已触发即时测试通知请求");
    };

    document.getElementById("send-suppress").onclick = () => {
      log("将在 3 秒后发送带焦点抑制的通知... 请立即切换到其他标签页或最小化浏览器！");
      setTimeout(() => {
        fetch("/api/test-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "会话已完成 (焦点抑制测试)",
            body: "代码生成结束，用时 4 秒。(4s)",
            suppressWhenFocused: true
          })
        });
      }, 3000);
    };
  </script>
</body>
</html>
`;

const server = http.createServer(async (req, res) => {
  if (req.url === EVENT_ROUTE_PATH) {
    hub.handleRequest(req, res);
    return;
  }
  if (req.url === "/api/test-notify" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const payload = JSON.parse(body || "{}");
      await hub.broadcast(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, clientCount: hub.clientCount }));
    });
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🚀 dsh-notified 本地验证服务已启动:`);
  console.log(`👉 请用浏览器打开: http://127.0.0.1:${PORT}`);
  console.log(`按 Ctrl+C 可停止服务。\n`);
});
