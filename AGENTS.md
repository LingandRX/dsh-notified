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
npm test          # 唯一的脚本；147 项测试，约 80 毫秒
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
| `lib/darwin.js` | macOS 通道：Bundle 构建决策、`swiftc` 调用、LaunchServices 启动、Unix Socket 协议 |
| `macos/main.swift` | macOS Helper 源码（约 460 行），首次使用时编译为 `DSHNotify.app` |
| `cordis.patch.yml` | Bundle Patch 模板：一条 `insert` 记录，内含默认配置 |
| `test/*.test.js` | `node:test` + `node:assert/strict`，`lib/` 每个模块对应一个文件 |

### 数据流

```
session/event ──► foldTurnState (policy.js)   按会话追踪轮次状态
turn/end     ──► decideTurnEnd (policy.js)    本轮是否应通知？
             ──► composeTitle/composeBody (text.js)
             ──► enqueue()  合并窗口（coalesceMs）
             ──► resolveChannel().send  ──► toast.js (Windows) | darwin.js (macOS)
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

## 测试

- 框架：`node:test` + `node:assert/strict`。不用 Jest、Vitest 或任何 mock 库。
- 覆盖率来自**依赖注入**，而非模块打桩。断言针对纯函数的返回数据。
- 文件系统触点必须通过注入的探针来验证。`mtimeOf` 与 `resolution` 有刻意读取真实磁盘的
  测试 —— 否则"源码比二进制新"这条分支根本无法触达。
- 新增行为时，测试放进对应的文件：判定逻辑 → `policy.test.js`，排版 → `text.test.js`，
  单平台通道 → `toast.test.js` / `darwin.test.js`，端到端串接（经注入的 `showToast`）
  → `plugin.test.js`。
