# dsh-notified

[![npm version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![node version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DSH Compatibility](https://img.shields.io/badge/DeepSeek%20Harness-v0.1.7%2B-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

桌面与浏览器通知插件，专为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 打造。全面支持 **Windows**、**macOS** 与 **Web 浏览器**。

在一轮对话结束时，自动发送**系统原生桌面通知**：通知标题为当前会话名称、正文为回答摘要与轮次耗时、图标为 DeepSeek Harness 官方图标。点击通知弹窗即可将 DSH 窗口或浏览器标签页激活并置于前台。

> 💡 切换到其他窗口处理其他事务，无需长时间紧盯屏幕等待 Agent 响应。

| 平台 | 投递通道 | 署名显示 | 点击聚焦 |
|---|---|---|---|
| **Windows** | PowerShell 5.1 → WinRT Toast | 注册 AUMID 后署名为 "DeepSeek Harness" | ✅ |
| **macOS** | 插件内置 Swift Helper（UserNotifications 框架） | 原生 App 署名 "DeepSeek Harness" | ✅ |
| **Web 浏览器** | Server-Sent Events (SSE) → HTML5 Web Notification | 浏览器原生通知，支持 Chrome / Edge / Safari / Firefox | ✅ 唤回激活标签页 |

---

## 目录

- [核心特性](#核心特性)
- [效果预览](#效果预览)
- [安装指南](#安装指南)
  - [方式一：通过插件管理器安装（推荐）](#方式一通过插件管理器安装推荐)
  - [方式二：手工配置 Profile](#方式二手工配置-profile)
  - [macOS 前置要求](#macos-前置要求)
  - [关于安装后生效](#关于安装后生效)
- [配置说明](#配置说明)
  - [完整配置项](#完整配置项)
  - [常见场景配置](#常见场景配置)
- [手动测试](#手动测试)
- [工作原理与架构设计](#工作原理与架构设计)
  - [触发时机与生命周期](#触发时机与生命周期)
  - [过滤判定链路](#过滤判定链路)
  - [底层投递通道](#底层投递通道)
  - [品牌化与图标呈现](#品牌化与图标呈现)
  - [数据安全与防注入](#数据安全与防注入)
  - [完全异步与零阻塞](#完全异步与零阻塞)
- [边界情况与容错机制](#边界情况与容错机制)
- [卸载指南](#卸载指南)
- [开发与测试](#开发与测试)
  - [环境准备与命令](#环境准备与命令)
  - [代码结构与分工](#代码结构与分工)
  - [架构设计原则](#架构设计原则)
  - [依赖与编译策略](#依赖与编译策略)
- [环境验证矩阵](#环境验证矩阵)
- [开源协议](#开源协议)

---

## 核心特性

- **原生系统级通知**：Windows 采用 WinRT Toast API，macOS 采用 UserNotifications 框架，完美融入系统通知中心。
- **官方品牌化呈现**：自动注册并关联 DeepSeek Harness 标识与官方图标，告别 PowerShell 或脚本编辑器的通用署名。
- **一键前台唤起**：点击弹窗通过系统协议 `dsh://open` 直接唤起并聚焦 DSH 主界面。
- **智能防打扰抑制**：
  - **前台焦点抑制**：用户正在查看 DSH 界面时不触发通知打扰；
  - **并发合并机制**：时间窗口内相近结束的多个会话自动折叠合并；
  - **精准过滤**：跳过纯工具调用（无文本回复）轮次、可选择性过滤子代理（Subagent）会话或极短轮次。
- **文本清洗与预算防截断**：自动剥离 Markdown 语法标记；耗时字符采用预留预算算法，正文截断时耗时尾串永不丢失。
- **非阻塞无感体验**：投递任务完全由后台子进程或常驻 Helper 异步承载，绝不阻塞对话主流程。
- **免管理员权限**：所有注册及 Helper 安装均在用户级目录完成，零系统级侵入。

---

## 效果预览

```text
┌────────────────────────────────────────┐
│  DeepSeek Harness                      │
│  修复解析器边界条件                     │
│  已定位到 off-by-one，补了 3 个单测…（12s）│
└────────────────────────────────────────┘
```

- **标题**：当前会话标题（若尚未生成会话名，则智能回退至工作区目录名或预设名称）。
- **正文**：本轮回答的纯文本摘要（自动剥除 Markdown 语法标记）+ 耗时标注。
- **图标**：DeepSeek Harness 自身官方图标。
- **点击交互**：触发 `dsh://open`，调用 DSH 桌面端内建逻辑拉起并聚焦窗口。

> 📌 **耗时预留机制**：正文截断前，系统会先在 `bodyMaxChars` 预算中扣除如 `(12s)` 等耗时尾串的长度，正文仅在剩余预算中排布截断。因此无论正文多长，耗时信息绝不会被切掉。

---

## 安装指南

### 方式一：通过插件管理器安装（推荐）

1. 打开 DeepSeek Harness 侧边栏，进入 **插件 → 安装**；
2. 在输入框中填入本插件目录在本地的**绝对路径**：

   **Windows 示例**：
   ```text
   C:\path\to\dsh-notified
   ```

   **macOS 示例**：
   ```text
   /path/to/dsh-notified
   ```

   *(请将上述路径替换为您本地存放 `dsh-notified` 的实际绝对路径)*

   > ⚠️ **注意**：必须使用**绝对路径**。插件管理器出于安全与解析确定性考虑，会拒绝相对路径。

3. 安装完成后，**重启 DeepSeek Harness**（原因参见下文 [关于安装后生效](#关于安装后生效)）。
4. **macOS 首次授权**：首次触发通知时，macOS 系统会弹出一次系统授权弹窗（署名为 "DeepSeek Harness"），点击「允许」即可。该授权仅需一次。

---

### 方式二：手工配置 Profile

编辑 Profile 配置文件 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-notified"
      ]
    }
  },
  "dependencies": {
    "dsh-notified": "link:/path/to/dsh-notified"
  }
}
```

*在 Windows 下将 `link:` 路径替换为类似 `link:C:\\path\\to\\dsh-notified` 的绝对路径。*

配置完成后，在 Profile 所在目录下执行安装并重启 DSH：

```bash
pnpm install
```

---

### macOS 前置要求

| 依赖项 | 最低版本要求 | 说明 |
|---|---|---|
| **macOS 系统版本** | macOS 13.0+ | 内置预编译 Universal Binary（Apple Silicon 与 Intel 架构），免装 Xcode / Command Line Tools 即可开箱即用 |
| **Xcode 命令行工具**（可选） | 任意有效版本 | 仅当开发者修改 `macos/main.swift` 源码时需要 `/usr/bin/swiftc` 触发增量编译；普通用户无需安装 |

> 💡 **免编译开箱即用**：macOS Helper 自带预编译 Universal Binary（`macos/bin/dsh-notified`），在首次使用时自动组装并安装到 `~/Library/Application Support/dsh-notified/DSHNotify.app`。无需安装 Xcode 或 Command Line Tools，亦无需管理员权限，签名采用 ad-hoc 本地自签名。

---

### 关于安装后生效

插件安装或更新后，**必须重启 DeepSeek Harness** 才能让新代码完全生效。

**原因**：DSH Host 进程中的模块代（Module Generation）会在安装时刻进行缓存。若直接修改源码，正在运行的 Host 进程不会自动重新读取，`apply()` 钩子仍按旧版本模块执行。这是 DSH 的既定设计（官方插件规范明确指明「替换已安装的包需要重启才能加载新的 JavaScript 模块代」）。

重启完成后，可通过后文的 `dsh_notify_test` 工具验证通道就绪状态。

---

## 配置说明

插件配置可在 DSH 界面中的 **插件页 → dsh-notified** 中可视化调整，配置会自动持久化至 `~/.dsh/profiles/desktop/cordis.patch.yml`。

### 完整配置项

| 配置项 | 类型 | 默认值 | 平台 | 详细说明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `true` | 全部 | 插件总开关 |
| `notifyOn` | `string[]` | `["completed"]` | 全部 | 允许触发通知的轮次结束原因：`completed` / `aborted` / `error` / `interrupted` |
| `suppressWhenFocused` | `boolean` | `true` | 全部 | 当 DSH 窗口处于前台活动状态时抑制通知 |
| `foregroundProcessNames` | `string[]` | `["DeepSeek Harness"]` | 全部 | 判定为"正在查看应用"的前台进程名 / 应用名列表 |
| `coalesceMs` | `number` | `1500` | 全部 | 通知合并时间窗口（毫秒）。窗口内多次完成合并为一条；设为 `0` 关闭合并 |
| `minTurnDurationMs` | `number` | `0` | 全部 | 轮次耗时阈值（毫秒）。短于此时长的轮次不发送通知 |
| `includeSubagents` | `boolean` | `false` | 全部 | 是否允许子代理（Subagent）会话触发通知 |
| `bodyMaxChars` | `number` | `140` | 全部 | 正文最大字符数。耗时尾串预留在此预算空间内 |
| `showDuration` | `boolean` | `true` | 全部 | 是否在通知末尾附加本轮耗时信息 |
| `launch` | `string` | `dsh://open` | 全部 | 点击通知弹窗时系统打开的深层链接 URI |
| `duration` | `string` | `short` | 全部 | 停留时长：`short` / `long`（macOS 上 `long` 映射为时效性通知 Time-Sensitive） |
| `sound` | `boolean` | `false` | 全部 | 是否播放系统提示音 |
| `mergedTemplate` | `string` | `"{count} conversations finished"` | 全部 | 多条会话合并通知时的正文模板（`{count}` 会被替换为数量） |
| `emptyBody` | `string` | `"Turn finished"` | 全部 | 当回答无文字内容时的兜底正文文案 |
| `verbose` | `boolean` | `false` | 全部 | 是否在控制台打印投递详情与跳过原因日志 |
| `appId` | `string` | `DeepSeek.Harness.Notified` | 仅 Windows | Windows Toast 归属的应用程序标识符（AUMID） |
| `registerAumid` | `boolean` | `true` | 仅 Windows | 自动在当前用户注册表注册 AUMID，呈现专属应用名与图标 |
| `iconPath` | `string` | `""` | 全部 | 自定义图标绝对路径；留空时自动探测 DSH 官方图标 |

> 📌 **跨平台配置细节**：
> 1. **macOS 忽略 `appId` 与 `registerAumid`**：macOS 系统的通知权限与应用程序的 Bundle Identifier 强绑定。若允许自定义 Bundle ID，用户修改配置会导致已获得的系统通知权限失效，因此 macOS Helper 的 Bundle ID 严格固定为 `com.deepseek.dsh-notified`。
> 2. **前台智能识别**：macOS 上的 `foregroundProcessNames` 同时匹配**应用名称**与 **Bundle Identifier**，且内置将 `com.deepseek.dsh` 判定为 DSH 前台。因此默认值 `["DeepSeek Harness"]` 在 Windows 和 macOS 上均可直接开箱即用。

---

### 常见场景配置

- **仅在执行出错或被中断时唤醒我**：
  将 `notifyOn` 设置为 `["error", "interrupted"]`。
- **自动连续跑任务时减少打扰**：
  将 `coalesceMs` 合并窗口调大至 `5000`（5 秒）。
- **佩戴耳机工作，需要提示音提醒**：
  将 `sound` 设置为 `true`。
- **临时静音插件，仅保留后台运行**：
  将 `enabled` 设置为 `false`。

---

## 手动测试

插件内置了测试工具 `dsh_notify_test`，模型或开发者可直接调用以验证系统通知链路是否畅通：

```bash
# 发送默认测试通知
dsh_notify_test

# 发送自定义标题与正文的测试通知
dsh_notify_test title="构建完成" body="单元测试 147 项全绿"
```

- 该测试工具**不受前台焦点抑制限制**：即使你当前正聚焦在 DSH 窗口中，也能即时收到弹窗。
- **注意**：测试工具依赖插件注册，首次安装后请确保已重启 DSH。

---

## 工作原理与架构设计

### 触发时机与生命周期

插件监听 Cordis 核心的 `session/event` 管道，按轮次（Turn）精确追踪会话状态：

| 捕获事件 | 处理逻辑 |
|---|---|
| `turn/start` | 记录轮次序列号与开始时间戳，初始化本轮「输出文本」标记 |
| `assistant/message` | 提取文本块；若包含有效文本则标记本轮存在实质性回复 |
| `turn/end` | 结算判定：提取 `reason.kind`，当且仅当满足所有过滤条件时触发投递 |

> **为什么必须等待 `assistant/message`？**
> 在 Agent 执行过程中，某一轮可能仅发起工具调用（Tool Call）而未输出最终文本，此时任务仍在演进中。只有包含实质性回复的轮次才会被纳入通知候选。

---

### 过滤判定链路

在结算阶段，系统按严格顺序执行快速短路过滤。首个未命中的规则将记录于日志（当 `verbose: true` 时输出）：

```text
[enabled 检查] ──► [notifyOn 匹配] ──► [实质文本输出检查] ──► [Subagent 策略] ──► [最低耗时阈值] ──► [触发投递]
```

1. **`enabled`**：确认总开关处于开启状态；
2. **`notifyOn`**：验证结算原因（如 `completed`、`error`）是否处于放行名单；
3. **文本产出**：确认模型在本轮确实输出了回复文本；
4. **`includeSubagents`**：子代理会话默认静音，除非显式开启；
5. **`minTurnDurationMs`**：过滤执行耗时低于设定阈值的瞬间轮次。

---

### 底层投递通道

DSH 的 Host 进程以环境变量 `ELECTRON_RUN_AS_NODE=1` 启动。在纯 Node 运行环境中，**无法加载 Electron 原生 `Notification` 模块**（直接 `require("electron")` 会抛出异常，而调用底层私有绑定会导致宿主崩溃）。因此，插件在双平台均独立构建了原生投递端。

统一调度模块通过 `resolveChannel()` 完成通道判定，上层共用同一套状态折叠、文案排版与防抖逻辑，仅在最后一跳（`showToast` / `showMacToast`）分流，返回相同结构的结果对象（`{ ok, suppressed, code, detail, reason }`）。

```text
                 ┌────────────────────────────────┐
                 │          session/event         │
                 └───────────────┬────────────────┘
                                 ▼
                 ┌────────────────────────────────┐
                 │ policy.js (状态追踪与过滤决策)  │
                 └───────────────┬────────────────┘
                                 ▼
                 ┌────────────────────────────────┐
                 │ text.js (Markdown 清洗与预算)  │
                 └───────────────┬────────────────┘
                                 ▼
                 ┌────────────────────────────────┐
                 │ resolveChannel() 跨平台通道派发 │
                 └───────┬────────────────┬───────┘
                         │                │
            (Windows)    ▼                ▼    (macOS)
      ┌──────────────────────┐        ┌──────────────────────┐
      │  lib/toast.js        │        │  lib/darwin.js       │
      │  PowerShell 5.1      │        │  DSHNotify.app       │
      │  WinRT Toast API     │        │  UserNotifications   │
      └──────────────────────┘        └──────────────────────┘
```

#### Windows 通道

- **调用链条**：拉起 Windows PowerShell 5.1 子进程调用底层 WinRT Toast 通知接口。
- **环境要求**：必须调用系统内置的 Windows PowerShell 5.1（固定使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`），不可使用 PowerShell Core / 7（后者的 WinRT 类型系统投影不完整）。
- **进程生命周期（非 Detached）**：经实测，若使用 `detached: true`，Windows PowerShell 将因缺少控制台而在后台**静默放弃** WinRT 脚本执行（虽然进程返回退出码 0，但 Toast 绝不会弹出）。因此，插件采用非 Detach 模式启动子进程，并通过超时间隔进行生命周期兜底。

#### macOS 通道

插件内置独立的 **Swift Helper** 源码（`macos/main.swift`，约 300 行）。首次使用时即时编译为系统标准 Bundle：

```text
~/Library/Application Support/dsh-notified/DSHNotify.app
├── Contents/Info.plist           # 配置 LSUIElement=true，不占 Dock 栏
├── Contents/MacOS/dsh-notified   # swiftc -O -target arm64-apple-macosx13.0
└── Contents/Resources/icon.icns  # 从 DSH 原生应用包提取复制
```

Helper 依托 Apple **UserNotifications** 框架，支持系统通知中心、历史归档与点击回调（回调直接通过 `NSWorkspace.open(dsh://open)` 聚焦窗口）。

**macOS 实测踩坑关键约束**：
1. **必须通过 LaunchServices 启动**：直接从 Node 进程 `spawn` 可执行文件会导致通知守护进程（`usernoted`）无法验证客户端 Identity，权限申请直接返回失败且**永不弹出授权提示**。改用 `open -a <bundle>` 启动后，系统方能建立合法上下文，授权弹窗正常展示。
2. **Bundle 物理路径约束**：Bundle 必须位于持久目录（如 `~/Library/Application Support/`）。若置于 `/tmp` 临时目录下，系统沙盒会拒绝扩展权限（报错 `sandbox_extension_issue_file_to_process failed: Operation not permitted`）。
3. **基于 Unix Domain Socket 通信**：`open` 启动无法继承父进程的 stdin/stdout。Helper 采用常驻并在 `~/Library/Application Support/dsh-notified/helper.sock` 监听 Unix Socket 的机制传递指令（Unix Socket 路径长度上限约 104 字节，路径过长时自动平滑回退至 `$TMPDIR` 下的短路径，仅 Socket 转移，Bundle 始终保留在原目录）。
4. **编译目标强制锁定**：`swiftc` 默认以本地最高 SDK 版本（如 macOS 28.0）为目标，会导致低版本系统（如 macOS 27.x）报 `kLSIncompatibleSystemVersionErr (-10825)` 拒绝启动。因此显式锁定参数 `-target arm64-apple-macosx13.0`。
5. **无焦点启动**：必须使用 `open -g` 参数后台启动 Helper。否则启动瞬间 Helper 会抢占全局焦点，破坏前台判断逻辑。
6. **主动查询授权状态**：在用户未授权时，`UNUserNotificationCenter.add` 仍会返回 `err=nil`。因此 Helper 内部通过 `getNotificationSettings()` 读取真实的 `authorizationStatus`，被拒时返回 `reason: "denied"` 与退出码 5。
7. **授权请求排队挂起**：首次请求权限期间不丢弃当前通知，待用户点击系统授权后继续派发。
8. **图标内嵌机制**：UserNotifications 框架不允许在运行时动态覆盖 Bundle 图标，必须在 Bundle 创建时将 DSH 的 `icon.icns` 拷入其 Resources 目录。

---

### 品牌化与图标呈现

- **Windows**：
  在注册表 `HKCU\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified` 中写入 `DisplayName`（"DeepSeek Harness"）与 `IconUri`（应用图标路径）。此操作运行于当前用户上下文，**免管理员权限**、支持幂等重写。若未配置该项，通知将显示为默认的 "Windows PowerShell"。
- **macOS**：
  应用名与署名直接由 Bundle 的 `CFBundleName` / `CFBundleDisplayName` 决定，系统通知中心显示为 "DeepSeek Harness"，图标展示原生高清应用图标。

> ❓ **为什么 macOS 不采用 `osascript -e 'display notification'`？**
> `osascript` 弹出的通知署名固定为 "Script Editor"（脚本编辑器），且**无法捕获点击回调**唤醒主程序。只有具备专属 Bundle Identifier 的独立应用 Bundle 才能被系统识别为正规来源。

---

### 数据安全与防注入

所有动态文本内容均严格杜绝拼入命令行或执行上下文：

- **Windows**：通知标题与正文经 **Base64 编码的 JSON 载荷** 传递给 PowerShell 进程，由脚本在内存中解码；XML 实体字符进行严格转义，杜绝畸形 XML 破坏 Toast 结构。
- **macOS**：投递请求封装为标准 JSON 对象，经由本地 Unix Socket 发送至 Helper；Helper 使用 Swift 内置的 `JSONDecoder` 解析，直接赋值给 `UNMutableNotificationContent` 对象。全程无任何 Shell 解释器介入。
- 支持 Emoji、换行符、HTML/XML 标签、多语言特殊符号安全传递。

---

### 完全异步与零阻塞

- 投递任务在子进程中拉起，插件事件监听器**不会 `await`** 投递结果；
- macOS Helper 的编译安装亦在后台静默预热；
- 无论网络状况、系统通知服务响应速度如何，通知逻辑均**绝不阻塞对话主流程**，亦不增加任何轮次延迟。

---

## 边界情况与容错机制

| 异常 / 边界场景 | 插件处理机制 |
|---|---|
| **非 Windows / 非 macOS 环境** | 插件自动静默空转，记录一条 Info 日志，不报错、不崩溃 |
| **Windows：PowerShell 运行策略受限** | 自动降级为使用 PowerShell 默认标识重试；若依然失败则记录 `warn`，不影响对话 |
| **Windows：系统处于专注助手 / 免打扰模式** | 遵从 Windows 系统级屏蔽策略，记录 `warn` 日志 |
| **macOS：未安装 Xcode 命令行工具** | 输出友好 `warn` 日志提示安装指南（`xcode-select --install`），对话正常继续 |
| **macOS：用户拒绝通知授权** | 记录 `warn` 日志并提示前往「系统设置 › 通知」手动放行；不会反复弹窗骚扰 |
| **macOS：Helper 编译失败 / Socket 超时** | 超时 15 秒后优雅降级标记为投递失败，防止链路无限挂起 |
| **macOS：DSH 安装于非标准路径** | 动态逆向推导当前运行进程路径定位 `icon.icns`；找不到时回退通用图标 |
| **会话尚未生成标题** | 自动平滑回退：会话标题 → 工作区目录名 → "DeepSeek Harness" |
| **`turn/end` 结算但无任何输出文本** | 判定为中间态轮次，自动静默跳过 |
| **同一轮次重复收到事件通知** | 基于轮次序号进行严格去重 |
| **插件被重复加载或热重载** | 标识注册完全幂等，所有监听器挂载于 Cordis 上下文生命周期，热重载时无内存泄漏 |
| **正文超出最大限制** | 耗时预留预算优先保护，截断仅作用于正文部分，末尾补齐省略号 `…` |

---

## 卸载指南

1. 在 DeepSeek Harness 侧边栏的 **插件** 页面中卸载 `dsh-notified`；
2. 清理系统级环境残留：

**Windows 环境**（清理当前用户的 AUMID 注册表项）：
```powershell
Remove-Item 'HKCU:\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified' -Force
```

**macOS 环境**（移除编译生成的 Helper Bundle 及 Socket 文件）：
```bash
rm -rf ~/Library/Application\ Support/dsh-notified
```
*卸载后，若在 macOS「系统设置 › 通知」列表中发现已停用的条目，可根据需要手动移除。*

---

## 开发与测试

### 环境准备与命令

本仓库使用 Node.js 原生测试运行器（Node Test Runner），包管理器推荐使用 **pnpm**：

```bash
# 安装开发依赖
pnpm install

# 运行全套单元测试（覆盖 toast、darwin、text、policy 与 plugin 五大模块）
pnpm test
```

### 代码结构与分工

| 源码路径 | 核心职责 |
|---|---|
| `lib/index.js` | Cordis 插件生命周期入口：通道派发、事件监听编排、测试工具注册与配置模式定义 |
| `lib/policy.js` | **纯函数层**：轮次状态聚合、判定是否满足通知策略、子代理会话识别 |
| `lib/text.js` | **纯函数层**：标题多级回退、Markdown 标签剔除、耗时预算预留与 UTF-8 安全字符截断 |
| `lib/toast.js` | **Windows 投递层**：AUMID 注册、PowerShell 脚本封装、子进程调用与退出码映射 |
| `lib/darwin.js` | **macOS 投递层**：Helper Bundle 构建与缓存、LaunchServices 启动、Socket 通信 |
| `macos/main.swift` | **macOS 原生代码**：基于 Swift / UserNotifications 构建的守护程序，负责原生弹窗与点击聚焦 |
| `cordis.patch.yml` | 插件 Patch 模板：注入插件定义与默认设置声明 |

---

### 架构设计原则

1. **纯函数优先，隔离 I/O**：
   `lib/policy.js` 与 `lib/text.js` 均为无副作用的纯函数模块，过滤逻辑与排版截断算法可脱离特定环境实现 100% 确定性单测。
2. **依赖注入便于测试**：
   两个平台投递模块对系统底层的依赖（如 `spawn`、`reg.exe`、`swiftc`、`open`、`net.connect`、文件系统与环境变量）均支持通过参数注入；`apply()` 支持注入 `overrides.showToast`，使核心逻辑在无 GUI、无真实通知的 CI/本地单测环境下也能全量覆盖验证。
3. **跨平台统一契约**：
   `toast.js` 与 `darwin.js` 对外导出相同结构的结果对象以及统一的退出状态码规范（`0` 成功 / `3` 焦点抑制 / `4` 通道不可用 / `5` 权限被拒），`index.js` 无需编写平台特化分支。

---

### 依赖与编译策略

- **自包含 Schema 依赖**：
  将 `@deepseek-ai/schemastery` 作为插件自身的直接依赖（`dependencies`），保证在 Profile 采用 `link:`（符号链接）方式安装时，ESM 寻址机制能正确解析依赖，不受 Host 外部目录隔离影响。
- **预编译分发与动态增量编译**：
  macOS Helper 内置预编译好的 Universal Binary（支持 Apple Silicon 与 Intel 架构），普通用户零依赖开箱即用；同时保留源码检测机制，在开发者修改 `main.swift` 且存在 `/usr/bin/swiftc` 时自动触发增量编译。

---

## 环境验证矩阵

本插件已在以下典型环境全量实测通过：

- **宿主环境**：DeepSeek Harness Desktop `0.1.7-rc.2`（运行时版本 `0.2.0-rc.2`）
- **引擎版本**：Electron 44 / Node 24
- **Windows 测试平台**：Windows 11 26H2（版本号 `10.0.26300`）
- **macOS 测试平台**：macOS 27.0.1 / Apple Silicon (arm64)

**Windows 实测结果确认**：
- 原生 WinRT Toast 正常投递，准确写入系统通知中心历史；
- AUMID 品牌化配置生效，通知面板显示专属名称与应用图标；
- 点击弹窗经由 `dsh://open` 正确唤醒并聚焦 DSH 主界面；
- 前台焦点检测准确，工作于前台时返回退出码 3 并抑制弹窗。

**macOS 实测结果确认**：
- Helper 在 1.5 秒内完成本地编译、安装并在 LaunchServices 登记注册；
- 投递正常返回 `{"ok":true,"code":0}`，系统 `usernoted` 日志确认 Banner 展示；
- 品牌化与图标映射正常，Bundle ID 绑定与通知权限持久有效；
- 前台为其他应用时正常响应，前台为 DSH 时准确抑制，无需复杂 TCC 额外授权；
- 特殊符号与复杂字符集无畸形解析，中文与代码片段展示完好。

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
