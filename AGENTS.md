# AGENTS.md — dsh-notified

## 项目定位

一个 DSH **Profile Bundle 插件**：一轮对话结束时进行桌面通知，点击通知可将
DSH 窗口唤回前台。

| 项目 | 说明 |
| --- | --- |
| 平台 | Windows（WinRT Toast）与 macOS（UserNotifications 横幅） |
| 运行宿主 | DSH Desktop `0.2.0-rc.2`，Electron + Node 24，`ELECTRON_RUN_AS_NODE=1` |
| Node 版本下限 | `>=20`（见 `package.json` 的 `engines`） |
| 模块体系 | 纯 ESM（`"type": "module"`）；使用 Node 内置测试运行器 |
| 依赖 | `@deepseek-ai/schemastery`（刻意作为直接依赖而非 peer） |
| 可选 peer | `@deepseek-ai/cordis` `^4.0.4` |

## 常用命令

```bash
npm test          # 唯一的脚本；206 项测试，约 120 毫秒
pnpm test         # 等价；推荐使用 pnpm

# 迭代时只跑单个文件
node --test test/policy.test.js
node --test --test-name-pattern="turn/end" test/plugin.test.js

# 端到端人工验证（需先重启 DSH）
# -> 在会话中调用 dsh_notify_test 工具
```

没有 linter、没有 formatter、没有 bundler、没有构建步骤、没有 TypeScript。未经明确要求
不要引入。格式由 `.editorconfig` 约束（2 空格缩进、LF、文件末尾换行、
`max_line_length = 100`、**去除行尾空白**，但 `*.md` 除外）。

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `lib/index.js` | Cordis 插件入口：通道判定、事件挂载、合并窗口、`dsh_notify_test` 工具、`Config` schema、`explainFailure` |
| `lib/policy.js` | **纯函数**：`shouldNotify`、`decideTurnEnd`、`foldTurnState`、`isSubagentSession`、`assistantTextOf` |
| `lib/text.js` | **纯函数**：`stripMarkdown`、`composeBody`、`composeTitle`、`truncateChars`、`formatDuration`、`assistantText`、`basenameOf`、`composeMergedSummary` |
| `lib/toast.js` | Windows 通道：AUMID 注册表写入、Base64 载荷、PowerShell 5.1 子进程、退出码映射 |
| `lib/darwin.js` | macOS 通道：Bundle 构建/安装决策、Universal Binary 支持、`swiftc` 增量构建、LaunchServices 启动、Unix Socket 协议 |
| `lib/web.js` | Web 通道：SSE 广播中心（`WebNotificationHub`）、连接池管理与心跳保活 |
| `client.js` | 浏览器 Client 插件（**classic script IIFE**，非 ESM）：Notification API 封装、焦点抑制、EventSource 订阅，以及点击通知后经 `uiWorkspace.openSession` 跳回会话 |
| `scripts/verify-web.js` | 本地端到端验证服务：按 Harness 方式以 classic script 提供 `client.js`，浏览器内可见跳转日志 |
| `macos/main.swift` | macOS Helper 源码（约 460 行），存在 `swiftc` 且有修改时编译为 `DSHNotify.app` |
| `macos/bin/dsh-notified` | macOS 预编译 Universal Binary Helper（支持 Apple Silicon & Intel），免装 Xcode/CLT 开箱即用 |
| `cordis.patch.yml` | Bundle Patch 模板：一条 `insert` 记录，内含默认配置 |
| `test/*.test.js` | `node:test` + `node:assert/strict`，`lib/` 每个模块及 `client.js` 对应一个文件 |

### 数据流

```
session/event ──► foldTurnState (policy.js)   按会话追踪轮次状态
turn/end     ──► decideTurnEnd (policy.js)    本轮是否应通知？
             ──► composeTitle/composeBody (text.js)
             ──► enqueue()  合并窗口（coalesceMs）
             ──► planDelivery (policy.js)     本条通知走哪个通道？（默认只走一个）
                   ├── native ──► resolveChannel().send ──► toast.js (Windows) | darwin.js (macOS)
                   └── web    ──► web.js (SSE 广播)  ──► client.js (浏览器 Web Notification)
```

## 不可破坏的契约

1. **双平台共用同一结果结构。** 两个通道均返回
   `{ ok, suppressed, code, reason, detail }`，退出码为 `0` 成功 / `3` 焦点抑制 /
   `4` 通道不可用 / `5` 被拒绝。`lib/index.js` 除 `resolveChannel` 外**不含任何平台分支**，
   请保持这一点。
2. **`lib/policy.js` 与 `lib/text.js` 必须保持纯函数** —— 不涉及 I/O、不使用 `process`、
   不拉起进程。所有环境交互归属于 `toast.js` / `darwin.js`，且必须可注入
   （`spawnImpl`、`runImpl`、`connectImpl`、`exists`、`statMtime`、`env` 等）。
3. **`apply(ctx, config, overrides)` 支持 `overrides.showToast`** —— 这是让整套插件在
   无投递通道的平台上也能完整运行的唯一测试缝。不可移除，也不可在导入期强依赖真实通道。
4. **`dsh_notify_test` 的工具定义是手工拼装的**，未走 `@deepseek-ai/dsh-tools` 的
   `defineTool`。原因：以 `link:` 方式安装的插件会解析到 profile 之外的真实路径，
   那里无法导入该 helper。其 `parameters` 为对象根、`additionalProperties: false`，
   属性为 `title` / `body`；`output.schema.required` 为 `["delivered", "detail"]`。
   `test/plugin.test.js` 断言了这个确切形状。
5. **`Config` 默认值是已发布契约。** `test/plugin.test.js` 对其做了断言
   （`notifyOn: ["completed"]`、`bodyMaxChars: 140`、`suppressWhenFocused: true`、
   `launch: "dsh://open"` 等），`cordis.patch.yml` 与之保持一致。改默认值必须同时改
   schema、patch 文件、README 配置表与测试。
6. **`appId` 与 `registerAumid` 按设计仅对 Windows 生效。** macOS 将通知权限与
   Bundle Identifier 强绑定，因此 Helper 的 ID 硬钉为 `com.deepseek.dsh-notified`
   （`DEFAULT_BUNDLE_ID`）。不要把它做成可配置 —— 那会在用户修改该字段的瞬间静默
   吊销既有授权。配置项的 description 写作 `Windows only:` 正是为此。
7. **`client.js` 必须是 classic script，绝不能出现顶层 `export` / `import.meta`。**
   DSH 的 bundle 通道 (`defaultLoadBundle`) 直接向 `document.head` 追加
   `<script src=…>`（**没有** `type="module"`），bundle 只需调用
   `window.__ModuleLoader__.load({ id, factory })`。顶层 `export` 会让浏览器抛出
   `SyntaxError`，插件**静默不激活**且通知永久失效 —— 这正是本项目踩过的坑。
   因此 `client.js` 整体包在 IIFE 中，且 `test/client.test.js` 用 `node:vm` 以 classic
   script 方式求值**真实字节**（而不是 `import` 一份 ESM 副本），从而让这个解析错误在
   单测中立刻暴露。Cordis 只读 `name` / `inject` / `apply`。
8. **Host 载荷必须携带 `sessionId`。** Web 端点击通知依赖它调用
   `uiWorkspace.openSession(id)` 跳回对应会话；合并批次（`coalesceMs`）跨会话时必须把
   `sessionId` 清空，否则会错误地指向其中一轮。`client.js` 通过 `ctx.get()` **在点击时**
   惰性解析 `uiWorkspace` / `sessions`，故 `inject` 保持为空数组 —— 不要为了拿服务而
   在 `inject` 里声明它们，那会让插件在无 Workspace UI 的页面上被 CORDIS 永久挂起。
9. **默认每条通知只走一个通道（`webNotification: "auto"`）。** 之前的实现无条件
   「发原生 + 广播浏览器」，当 `dsh web` 跑在有原生通道的机器上时，同一个人会收到
   **两条一模一样的横幅**。通道选择收敛到纯函数 `planDelivery`（`lib/policy.js`）：
   - `auto`：有人在**非桌面壳**的浏览器里查看时只发浏览器（其点击能跳回具体会话，
     原生横幅做不到），否则只发原生；
   - `always`：两个真实受众（如共享服务器 + 运维自己的桌面）才两条都发；
   - `off`：从不发浏览器通知。
   判定「桌面壳」必须用 `isDesktopShell()`（即 `process.versions.electron`）：DSH
   Desktop **自带 `dsh-web-app`**，它的渲染进程同样是 SSE 客户端，因此
   「存在 `webServer`」不能区分「真人开着浏览器」与「桌面壳自己的窗口」—— 只有
   Electron 标记能。原生投递失败且浏览器在线时仍回退到浏览器，避免拒权/Helper
   起不来时通知被静默吞掉。

## 测试

- 框架：`node:test` + `node:assert/strict`。不用 Jest、Vitest 或任何 mock 库。
- 覆盖率来自**依赖注入**，而非模块打桩。断言针对纯函数的返回数据。
- 文件系统触点必须通过注入的探针来验证。`mtimeOf` 与 `resolution` 有刻意读取真实磁盘的
  测试 —— 否则"源码比二进制新"这条分支根本无法触达。
- `test/client.test.js` 不 `import` `client.js`，而是在 `node:vm` 中求值真实文件：契约 7
  要求如此（ESM 读取会掩盖浏览器必然命中的解析错误）。跨 realm 的返回值用字段断言，
  不要用 `assert.deepEqual`（原型不同会误报）。
- 端到端验证可用 `node scripts/verify-web.js`（起本地服务，浏览器打开后点通知，页面日志
  会记录跳转到的 sessionId）。
- 新增行为时，测试放进对应的文件：判定逻辑 → `policy.test.js`，排版 → `text.test.js`，
  单平台通道 → `toast.test.js` / `darwin.test.js`，端到端串接（经注入的 `showToast`）
  → `plugin.test.js`。
