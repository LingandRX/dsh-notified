# dsh-notified

桌面通知插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。支持 **Windows** 与 **macOS**。

一轮对话结束时，弹出**系统原生通知**——标题是会话名、正文是回答摘要、图标是 DeepSeek Harness 自己的图标。点一下弹窗，DSH 窗口回到前台。

切到别的窗口去干别的事，不用再盯着屏幕等 Agent 跑完。

| 平台 | 通道 | 署名 | 点击聚焦 |
|---|---|---|---|
| Windows | PowerShell 5.1 → WinRT Toast | 注册 AUMID 后为 "DeepSeek Harness" | ✅ |
| macOS | 插件自带 Swift helper（UserNotifications） | "DeepSeek Harness" | ✅ |

---

## 效果

```
┌────────────────────────────────────────┐
│  DeepSeek Harness                      │
│  修复解析器边界条件                     │
│  已定位到 off-by-one，补了 3 个单测…（12s）│
└────────────────────────────────────────┘
```

- **标题** = 会话标题（没有则退回工作区目录名）
- **正文** = 本轮回答的纯文本摘要（自动剥掉 Markdown 语法）+ 耗时
- **图标** = DeepSeek Harness 自身图标
- **点击** = 通过 `dsh://open` 唤起并聚焦 DSH 窗口

> 耗时是**预留**的：截断前先从 `bodyMaxChars` 里扣掉 `(12s)` 这类尾串的宽度，正文在剩余预算里排布。所以正文再长，耗时也不会被切掉。

---

## 安装

### 方式一：插件管理器（推荐）

在侧边栏 **插件 → 安装** 中填入本目录的**绝对路径**：

```
C:\Users\YLL\Documents\ChatGPT\dsh-notified
/Users/YLL/Documents/ChatGPT/dsh-notified
```

> 路径必须是绝对路径。插件管理器会拒绝相对路径，因为浏览器里输入的相对路径没有明确的解析基准。

安装完成后 **重启 DeepSeek Harness**（原因见下文「关于安装后生效」）。

首次真正要发通知时，macOS 会弹出一次系统授权询问（署名 "DeepSeek Harness"），点「允许」即可。**这一步无法省略**：macOS 的通知权限只能由用户在系统弹窗里授予。

### 方式二：手工接入 profile

编辑 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-notified"]
    }
  },
  "dependencies": {
    "dsh-notified": "link:C:\\Users\\YLL\\Documents\\ChatGPT\\dsh-notified"
  }
}
```

macOS 上把 `link:` 后的路径换成 `/Users/YLL/Documents/ChatGPT/dsh-notified`。

然后在 profile 目录执行 `pnpm install`，重启 DSH。

### macOS 前置条件

| 依赖 | 说明 |
|---|---|
| Xcode 命令行工具 | 需要 `/usr/bin/swiftc` 编译 helper。`xcode-select --install` 即可；缺了只会在日志里记一条 `warn`，不影响对话 |
| macOS 13+ | helper 的 `LSMinimumSystemVersion` 与编译目标均为 13.0 |

helper 会在**首次投递时自动编译并安装**到 `~/Library/Application Support/dsh-notified/DSHNotify.app`（约 1.5 秒，且不阻塞对话）。不需要管理员权限，也不需要付费证书——签名是 ad-hoc 的。

---

## 配置

所有配置项都在 **插件页 → dsh-notified** 中，写入 `~/.dsh/profiles/desktop/cordis.patch.yml`。

| 配置 | 默认 | 平台 | 说明 |
|---|---|---|---|
| `enabled` | `true` | 全部 | 总开关 |
| `notifyOn` | `["completed"]` | 全部 | 触发结果：`completed` / `aborted` / `error` / `interrupted` |
| `suppressWhenFocused` | `true` | 全部 | DSH 窗口在前台时不打扰 |
| `foregroundProcessNames` | `["DeepSeek Harness"]` | 全部 | 视为"正在看应用"的前台进程名 / 应用名 |
| `coalesceMs` | `1500` | 全部 | 合并窗口（毫秒），窗口内的多次完成合成一条；`0` 关闭合并 |
| `minTurnDurationMs` | `0` | 全部 | 短于此时长的轮次不通知 |
| `includeSubagents` | `false` | 全部 | 是否也为子代理会话通知 |
| `bodyMaxChars` | `140` | 全部 | 正文最大字符数；耗时预留在此预算内 |
| `showDuration` | `true` | 全部 | 是否附上本轮耗时；耗时被预留，截断不会吞掉它 |
| `launch` | `dsh://open` | 全部 | 点击弹窗打开的 URI |
| `duration` | `short` | 全部 | 停留时长：`short` / `long`；macOS 上 `long` 映射为时效性通知 |
| `sound` | `false` | 全部 | 是否播放提示音 |
| `mergedTemplate` | `{count} conversations finished` | 全部 | 合并通知的正文模板 |
| `emptyBody` | `Turn finished` | 全部 | 无正文时的兜底文案 |
| `verbose` | `false` | 全部 | 打印投递细节与跳过原因 |
| `appId` | `DeepSeek.Harness.Notified` | 仅 Windows | Toast 归属的应用标识 |
| `registerAumid` | `true` | 仅 Windows | 自动注册该标识（免管理员），使弹窗带应用名与图标 |
| `iconPath` | `""` | 全部 | 覆盖图标；留空则自动探测 DSH 自带图标 |

> macOS 的 `appId` 与 `registerAumid` 不生效，这是刻意的：macOS 把用户的通知授权**绑定在 bundle identifier 上**，如果 bundle id 可配置，用户改一下这个字段就会静默丢掉已经授予的权限。所以 helper 的 bundle id 固定为 `com.deepseek.dsh-notified`。
>
> macOS 上 `foregroundProcessNames` 同时匹配**应用名**与 **bundle id**，并且 `com.deepseek.dsh` 始终视为"DSH 在前台"——所以默认值 `["DeepSeek Harness"]` 在两个平台上都直接可用，不必分平台改配置。

### 常见调整

**只想在出错时被叫醒**，把 `notifyOn` 改成 `["error", "interrupted"]`。

**自动续跑太吵**，把 `coalesceMs` 调大到 `5000`。

**戴耳机时切窗口也要提示**，把 `sound` 设为 `true`。

**不想要任何打扰，只留个记录**，把 `enabled` 设为 `false`。

---

## 手动测试

模型可调用 `dsh_notify_test` 工具直接打一条测试弹窗：

```
dsh_notify_test
dsh_notify_test title="构建完成" body="单元测试 93 项全绿"
```

不依赖真实对话，用于确认通道是否打通。该工具**不受前台抑制影响**，所以即使你正看着 DSH 也能用它验证弹窗。

> 注意：`dsh_notify_test` 只在重启后可用——见下文。

---

## 它是怎么工作的

### 触发时机

监听 `session/event`，按轮次跟踪状态：

| 事件 | 处理 |
|---|---|
| `turn/start` | 记下轮次编号与起始时间，重置"有无输出"标记 |
| `assistant/message` | 若含文本则标记本轮**确有产出** |
| `turn/end` | 结算：全部过滤条件通过才通知 |

用 `turn/end`（post-commit，且带 `reason.kind`）而不是更早的信号，因为它明确区分了"正常答完"、"被中断"、"报错"。

**为什么要求 `assistant/message`**：一轮里模型可能只调工具、没写任何话，对话其实还没结束。这种情况不通知。

### 过滤链

依次判定，第一个不通过的原因会记入日志（`verbose: true` 时可见）：

1. `enabled` —— 总开关
2. `notifyOn` —— 结果是否在允许集合内
3. 有产出 —— 本轮是否说过话
4. `includeSubagents` —— 子代理会话是否放行
5. `minTurnDurationMs` —— 是否短于时长下限

### 投递通道

DSH 的 Host 进程以 `ELECTRON_RUN_AS_NODE=1` 启动，因此**插件空间里拿不到 Electron 的 `Notification` 类**（实测 `require("electron")` 直接失败，`process._linkedBinding("electron_browser_notification")` 会让进程直接崩掉）。所以两个平台都自己拉起投递端。

平台选择在 `resolveChannel()` 里做一次，之后整条链路共用：同一套过滤规则、同一套文案排版、同一套合并逻辑。**只有最后一跳分叉**（`showToast` / `showMacToast`），两者返回相同形状的结果。

#### Windows

拉起 Windows PowerShell 5.1 子进程调用 WinRT Toast API。

**必须用 Windows PowerShell 5.1，不能用 PowerShell 7。** 后者的 WinRT 类型投影不完整。所以解释器走 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 的绝对路径，不受进程 PATH 影响。

**子进程不能 detach。** 这条是实测出来的，很反直觉：`detached: true` 创建的子进程没有控制台，Windows PowerShell 会**静默放弃** WinRT 脚本——进程仍然退出 0，但弹窗从未发出。判定依据是 Windows 通知历史（`ToastNotificationManager.History`）的真实条数，而不是退出码。所以 `showToast` 以非 detach 方式拉起子进程，并靠 timeout 兜底。

#### macOS

插件自带一个 **Swift helper**（`macos/main.swift`，约 300 行，随插件源码分发），首次投递时编译成一个真正的 `.app`：

```
~/Library/Application Support/dsh-notified/DSHNotify.app
├── Contents/Info.plist           # LSUIElement + NSPrincipalClass=NSApplication，不出现在 Dock
├── Contents/MacOS/dsh-notified   # swiftc -O -target arm64-apple-macosx13.0
└── Contents/Resources/icon.icns  # 从 DSH 自己的 bundle 拷来
```

这个 helper 走 Apple 的 **UserNotifications** 框架，因此是真正的系统级通知：有自己的署名、能进通知中心、支持点击回调。它的点击回调直接 `NSWorkspace.open(dsh://open)`，复用桌面端 `main.js` 里已经写好的窗口聚焦逻辑。

以下是实测踩出来、且都必须遵守的约束：

**1. 必须由 LaunchServices 启动，不能直接 spawn。** 直接从 Node `spawn` bundle 里的可执行文件，通知守护进程认不出调用者：日志里只有 `Failed to find or validate client of identifier <id> with audit token <...>`，`requestAuthorization` 返回 "Notifications are not allowed for this application" 且**从不弹授权框**。改用 `open -a <bundle>` 启动同一个 bundle，日志立刻变成 `Connection <id> with path: ...` → `Sending request for permission ...`，授权框正常出现。结论：`open` 在这里不是便利工具，它就是 API。

**2. bundle 的**位置**和启动方式一样重要。** 放在 `/tmp` 下的 bundle 会报 `sandbox_extension_issue_file_to_process failed for <path>: 1 (Operation not permitted)`，并且永远停在 `Failed to find`，从来不会 `Connection`。这正是 `terminal-notifier` 在临时目录里跑时的失败形态。所以 helper 固定装在 `~/Library/Application Support/` 下。

**3. `open` 拿不到父进程的管道**，所以 stdin 不能当请求通道。helper 改为监听一个 **Unix domain socket**（`~/Library/Application Support/dsh-notified/helper.sock`，Unix socket 路径上限约 104 字节，路径过长时回退到 `$TMPDIR` 下的短路径——只有 socket 会去临时目录，bundle 永远不去）。helper 常驻等待请求，点击事件则由 UserNotifications 的 delegate 送到同一个进程。

**4. 编译必须显式指定 `-target`。** `swiftc` 默认目标跟随已安装 SDK（这里是 `arm64-apple-macosx28.0`），比运行的系统（27.0.1）高，LaunchServices 会直接拒绝启动，报 `kLSIncompatibleSystemVersionErr` / `-10825`，`open` 只回一句 `_LSOpenURLsWithCompletionHandler() failed with error -10825`。固定成 `-target arm64-apple-macosx13.0` 即可。

**5. 启动 helper 要用 `open -g`。** 少了 `-g`，`open` 会把 helper 拉到前台：既抢用户焦点，又让 helper 自己成了最前台的应用——于是焦点抑制会看到一个"不是 DSH 的前台应用"，反而在用户正盯着 DSH 时弹窗。

**6. 授权状态要读 `getNotificationSettings()`，不能信 `center.add` 的回调。** 被拒绝时 `add` 依然返回 `err=nil`。所以 helper 回复的是 `authorizationStatus` 的实测值，被拒时映射为 `reason:"denied"` + 退出码 5。

**7. 授权是**懒请求**的，且请求期间不丢通知。** 第一次真要发通知时才弹授权框，并把那条通知**挂住**，等用户点完再发——而不是先丢掉再等下一次。授权状态可能瞬间读到 `notDetermined`（`ready` 那行）而随后变 `authorized`（`reply` 那行），所以上层不会把单个 `notDetermined` 当成失败。

**8. 图标只能来自 bundle。** macOS 没有覆盖通知图标的 API（`terminal-notifier` 明确移除了 `-appIcon`，因为"UserNotifications 框架不允许覆盖 bundle identifier"）。要显示 DSH 的图标，唯一的办法就是把 DSH 的 `icon.icns` 拷进自己的 bundle。

### 品牌化

**Windows**：Toast 归属的标识写在 `HKCU\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified`，只需 `DisplayName` 与 `IconUri` 两个值。用户级、免管理员、可幂等重写。没有它，弹窗会署名 "Windows PowerShell"。

**macOS**：署名来自 bundle 自己——`CFBundleName` / `CFBundleDisplayName` 都是 `DeepSeek Harness`，图标是拷进来的 `icon.icns`。系统日志里的归属记录是 `app:"com.deepseek.dsh-notified"`。

> 为什么不用 `osascript -e 'display notification'`：它能弹，但署名是 **Script Editor**（`app:"com.apple.ScriptEditor2"`），而且**没有点击动作**。也试过用 `osacompile` 打包成 applet 来改署名——applet 的 Info.plist 默认没有 `CFBundleIdentifier` 这个键，手工 `Add` 上去再签名，系统仍然把它算作 Script Editor。只有自带 bundle id 的 `.app` 才会被登记为独立通知来源。

### 数据注入

所有动态内容都不进入可执行文本：

- **Windows**：标题、正文以 **Base64 编码的 JSON** 传给子进程，由子进程解码。没有任何值被拼进脚本文本。XML 特殊字符另行转义，保证 Toast 文档始终合法。
- **macOS**：请求是一个 JSON 对象，经 socket 传给 helper；helper 用 Swift 的 `JSONDecoder` 解码后交给 `UNMutableNotificationContent`。**没有任何 shell、没有字符串插值、没有脚本解析层**——连 plist 里的值都经过 `escapePlistText()`。

引号、换行、emoji、`<xml>`、非拉丁字符都不可能破坏命令或造成二次解析（已用 `中文 & "quotes" <xml>` 实测）。

### 不阻塞对话

投递是子进程，且事件监听器**不 await** 投递结果（helper 的编译也是后台预热，不 await）。通知永远不会给对话增加延迟，也不会因为自身失败而影响轮次。

---

## 边界情况

| 场景 | 行为 |
|---|---|
| 非 Windows / 非 macOS | 插件空转，记一条 info，不报错 |
| Windows：PowerShell 被策略拦截 | 降级到 PowerShell 自身标识重试；仍失败则记 `warn`，对话不受影响 |
| Windows：焦点助手 / 勿扰模式拦截 | 系统行为，无法绕过，记 `warn` |
| macOS：未装 Xcode 命令行工具 | 记 `warn` 并附上补救提示（`install the Xcode command-line tools`），对话不受影响 |
| macOS：用户点了"不允许" | 记 `warn` 并提示去「系统设置 › 通知」里放行；不会反复弹授权框 |
| macOS：helper 编译失败 / 启动超时 / socket 无响应 | 逐项映射到可读原因与补救建议；15s 超时后降级为"投递失败"，不会把通知链路永久挂住 |
| macOS：DSH 不在 `/Applications` | 从运行进程自身的路径回推 `Resources/icon.icns`；找不到图标只是退回通用图标，不影响投递 |
| 会话标题尚未生成 | 回退到工作区目录名，再回退到 `DeepSeek Harness` |
| `turn/end` 但无回答文本 | 跳过 |
| 同一轮重复事件 | 按轮次号去重 |
| 插件重复加载 | 标识注册幂等；监听器随 `ctx` 生命周期自动释放；helper 安装按进程只做一次 |
| 宿主热重载 | 内部状态随插件实例重建，无残留 |
| 正文过长被截断 | 耗时先预留，永不被切掉；正文预算不足下限时整段让位给耗时 |

---

## 卸载

1. 插件管理器中移除 `dsh-notified`；
2. 清掉系统级副作用：

**Windows** —— 删掉注册表项：

```powershell
Remove-Item 'HKCU:\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified' -Force
```

**macOS** —— 删掉 helper（把 `.app` 与 socket 一起带走）：

```bash
rm -rf ~/Library/Application\ Support/dsh-notified
```

之后可在「系统设置 › 通知」里看到残留的 "DeepSeek Harness" 条目，手动移除即可。

---

## 开发

```bash
node --test "test/*.test.js"
```

代码结构：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Cordis 插件主体：选通道、监听轮次、编排、注册测试工具 |
| `lib/policy.js` | 纯函数：轮次状态折叠、该不该通知、是不是子代理会话 |
| `lib/text.js` | 纯函数：标题回退、Markdown 剥离、尾串预留与 UTF-8 安全截断 |
| `lib/toast.js` | Windows 投递层：标识注册、脚本生成、子进程拉起、退出码映射 |
| `lib/darwin.js` | macOS 投递层：helper 编译安装、bundle 校验、socket 请求、退出码映射 |
| `macos/main.swift` | macOS helper 源码：UserNotifications 投递、点击回调、焦点检测 |
| `cordis.patch.yml` | bundle patch：插入插件行与默认配置 |

分层原则：**能做成纯函数的都做成纯函数**。`policy.js` 与 `text.js` 不碰 I/O，所以过滤规则与通知文案可以脱离运行时直接测；两个投递层的每个外部依赖（`spawn`、`reg.exe`、`swiftc`、`open`、`net.connect`、文件探测、环境变量）都可注入，所以投递逻辑无需真弹窗便能验证。`apply()` 还接受一个 `overrides.showToast` 注入点，使整条「事件 → 决策 → 投递」链路可以在测试里跑通而完全不产生真实通知。

平台差异只存在于两个投递模块里（`toast.js` 与 `darwin.js`），两者导出**相同形状**的结果对象与相同的退出码约定（`0` 成功 / `3` 抑制 / `4` 不可用 / `5` 被拒），所以 `index.js` 里除了 `resolveChannel()` 的一次选择之外没有任何平台分支。

### 依赖说明

本插件把 `@deepseek-ai/schemastery` 声明为**自身依赖**（而不是依赖 Host 提供）。原因是插件常以 `link:`（符号链接）方式安装：ESM 会把符号链接解析到真实路径，而真实路径在 profile 之外，因此 Host 安装域提供的包无法被解析。自带依赖后，`link:` 与 `file:` 两种安装方式都能正常工作。

测试工具的定义是手工构造的（没有用 `@deepseek-ai/dsh-tools` 的 `defineTool`），出于同样原因：该包由运行安装提供，`link:` 安装下无法导入。注册表只要求定义满足既定形状，手工构造可以让测试工具在任何安装方式下都可用。

macOS helper 用的是**系统自带的 Swift 编译器**，不引入任何 npm 依赖，也不打包预编译二进制——源码随插件走，首次使用时在本机编译，这样既有原生通知能力，又不必为不同架构分发产物。

---

## 环境验证

本插件在以下环境实测通过：

- DeepSeek Harness Desktop `0.1.7-rc.2`（运行时 `0.2.0-rc.2`）
- Electron 44 / Node 24
- Windows 11 26H2（`10.0.26300`）
- macOS 27.0.1 / arm64

**Windows 已实测确认的行为**

- 原生 Toast 投递成功，并出现在 Windows 通知中心（以通知历史的真实条数判定，而非进程退出码）。
- 品牌化生效：`HKCU\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified` 写入后，弹窗显示 "DeepSeek Harness" 与自带图标（免管理员）。
- 点击弹窗可通过 `dsh://open` 唤起应用（该协议已由桌面端注册，`main.js` 中已实现窗口聚焦）。
- 焦点抑制生效：前台进程命中时子进程返回退出码 3 且不弹窗。
- 端到端链路：`turn/start` → `assistant/message` → `turn/end` 后产出 `title=demo`、`body=完成 已修复 边界条件，补了 3 个测试。 a b (9s)`。

**macOS 已实测确认的行为**

- helper 从零编译安装成功（清空 `~/Library/Application Support/dsh-notified/` → 1.5 秒建好 bundle 并注册进 LaunchServices）。
- 投递回复 `{"ok":true,"suppressed":false,"code":0}`；系统日志（`process == "usernoted"`）确认 `Presenting <NotificationRecord app:"com.deepseek.dsh-notified" ...> as banner`。
- 品牌化生效：bundle 的 `CFBundleName`/`CFBundleDisplayName` 均为 `DeepSeek Harness`，图标为拷入的 DSH `icon.icns`，bundle id `com.deepseek.dsh-notified`。
- 焦点抑制生效：前台为 Chrome 时，带 `suppressWhenFocused` 的请求返回 `{"ok":true,"suppressed":true,"code":3,"detail":"frontmost=com.google.Chrome"}`，且不需要任何 TCC 授权（走 `lsappinfo`，不走 System Events）。
- 注入安全：正文含 `中文 & "quotes" <xml>` 正常投递，全程无 shell 参与。
- 时序：授权状态先读到 `notDetermined`、随后变 `authorized`，上层不误判为失败。

**关于安装后生效**

插件安装完成后，需要**重启 DeepSeek Harness** 才会加载当前代码。原因是已安装的包在 Host 进程中的模块代（module generation）是安装那一刻缓存的：安装后继续修改源码，运行中的进程不会重新读取，`apply()` 也仍按旧代码执行。这是 DSH 的既定行为——官方插件开发文档明确写着「替换已安装的包需要重启才能加载新的 JavaScript 模块代」。

重启后可用 `dsh_notify_test` 工具确认通道已就绪。

---

## 开发

```bash
# 依赖（本仓库用 pnpm，lockfile 为 v9）
pnpm install

# 单测：node 内置 test runner，覆盖 toast / darwin / text / policy / plugin 五条链路
pnpm test        # 等价于 node --test "test/*.test.js"
```

约定：

- 纯 ESM（`"type": "module"`），入口 `lib/index.js`，Node >= 20。
- 文本文件一律 LF；`.gitattributes` 已锁定，避免 Windows 上提交出 CRLF 噪音。
- `node_modules/` 不入库，靠 `pnpm-lock.yaml` 复现依赖。
- 改完源码必须**重启 DSH** 才加载新代码（见上文「关于安装后生效」），随后用 `dsh_notify_test` 复核通道。

> 单测本身与平台无关：Windows 路径逻辑通过 `platform` / `env` / `exists` 注入来断言，因此在 macOS 上跑全套也是全绿。

---

## License

MIT，见 [LICENSE](LICENSE)
