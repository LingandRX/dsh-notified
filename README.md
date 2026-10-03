# dsh-notified

Windows 桌面通知插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

一轮对话结束时，弹出 **Windows 原生 Toast** 通知——标题是会话名、正文是回答摘要、图标是 DeepSeek Harness 自己的图标。点一下弹窗，DSH 窗口回到前台。

切到别的窗口去干别的事，不用再盯着屏幕等 Agent 跑完。

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
```

> 路径必须是绝对路径。插件管理器会拒绝相对路径，因为浏览器里输入的相对路径没有明确的解析基准。

安装完成后 **重启 DeepSeek Harness**（原因见下文「关于安装后生效」）。

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

然后在 profile 目录执行 `pnpm install`，重启 DSH。

---

## 配置

所有配置项都在 **插件页 → dsh-notified** 中，写入 `~/.dsh/profiles/desktop/cordis.patch.yml`。

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifyOn` | `["completed"]` | 触发结果：`completed` / `aborted` / `error` / `interrupted` |
| `suppressWhenFocused` | `true` | DSH 窗口在前台时不打扰 |
| `foregroundProcessNames` | `["DeepSeek Harness"]` | 视为"正在看应用"的前台进程名 |
| `coalesceMs` | `1500` | 合并窗口（毫秒），窗口内的多次完成合成一条；`0` 关闭合并 |
| `minTurnDurationMs` | `0` | 短于此时长的轮次不通知 |
| `includeSubagents` | `false` | 是否也为子代理会话通知 |
| `bodyMaxChars` | `140` | 正文最大字符数；耗时预留在此预算内 |
| `showDuration` | `true` | 是否附上本轮耗时；耗时被预留，截断不会吞掉它 |
| `appId` | `DeepSeek.Harness.Notified` | Toast 归属的应用标识 |
| `registerAumid` | `true` | 自动注册该标识（免管理员），使弹窗带应用名与图标 |
| `iconPath` | `""` | 覆盖图标；留空则自动探测 DSH 自带图标 |
| `launch` | `dsh://open` | 点击弹窗打开的 URI |
| `duration` | `short` | 停留时长：`short` / `long` |
| `sound` | `false` | 是否播放提示音 |
| `mergedTemplate` | `{count} conversations finished` | 合并通知的正文模板 |
| `emptyBody` | `Turn finished` | 无正文时的兜底文案 |
| `verbose` | `false` | 打印投递细节与跳过原因 |

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

DSH 的 Host 进程以 `ELECTRON_RUN_AS_NODE=1` 启动，因此**插件空间里拿不到 Electron 的 `Notification` 类**（实测 `require("electron")` 直接失败）。唯一可用通道是拉起 Windows PowerShell 5.1 子进程调用 WinRT Toast API。

反射这次实现，有两个细节值得记下来：

**必须用 Windows PowerShell 5.1，不能用 PowerShell 7。** 后者的 WinRT 类型投影不完整。所以解释器走 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 的绝对路径，不受进程 PATH 影响。

**子进程不能 detach。** 这条是实测出来的，很反直觉：`detached: true` 创建的子进程没有控制台，Windows PowerShell 会**静默放弃** WinRT 脚本——进程仍然退出 0，但弹窗从未发出。判定依据是 Windows 通知历史（`ToastNotificationManager.History`）的真实条数，而不是退出码。所以 `showToast` 以非 detach 方式拉起子进程，并靠 timeout 兜底。

### 品牌化

Toast 归属的标识写在 `HKCU\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified`，只需 `DisplayName` 与 `IconUri` 两个值。用户级、免管理员、可幂等重写。没有它，弹窗会署名 "Windows PowerShell"。

### 数据注入

所有动态内容（标题、正文）以 **Base64 编码的 JSON** 传给子进程，由子进程解码。没有任何值被拼进脚本文本，因此引号、换行、emoji、非拉丁字符都不可能破坏命令或造成二次解析。XML 特殊字符另行转义，保证 Toast 文档始终合法。

### 不阻塞对话

投递是子进程，且事件监听器**不 await** 投递结果。通知永远不会给对话增加延迟，也不会因为自身失败而影响轮次。

---

## 边界情况

| 场景 | 行为 |
|---|---|
| 非 Windows | 插件空转，记一条 info，不报错 |
| PowerShell 被策略拦截 | 降级到 PowerShell 自身标识重试；仍失败则记 `warn`，对话不受影响 |
| 焦点助手 / 勿扰模式拦截 | 系统行为，无法绕过，记 `warn` |
| 会话标题尚未生成 | 回退到工作区目录名，再回退到 `DeepSeek Harness` |
| `turn/end` 但无回答文本 | 跳过 |
| 同一轮重复事件 | 按轮次号去重 |
| 插件重复加载 | 标识注册幂等；监听器随 `ctx` 生命周期自动释放 |
| 宿主热重载 | 内部状态随插件实例重建，无残留 |
| 正文过长被截断 | 耗时先预留，永不被切掉；正文预算不足下限时整段让位给耗时 |

---

## 卸载

1. 插件管理器中移除 `dsh-notified`；
2. 删掉注册表项（唯一的系统级副作用）：

```powershell
Remove-Item 'HKCU:\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified' -Force
```

---

## 开发

```powershell
node --test "test/*.test.js"   # 100 项单测
```

代码结构：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Cordis 插件主体：监听轮次、编排、注册测试工具 |
| `lib/policy.js` | 纯函数：轮次状态折叠、该不该通知、是不是子代理会话 |
| `lib/text.js` | 纯函数：标题回退、Markdown 剥离、尾串预留与 UTF-8 安全截断 |
| `lib/toast.js` | 投递层：标识注册、脚本生成、子进程拉起、退出码映射 |
| `cordis.patch.yml` | bundle patch：插入插件行与默认配置 |

分层原则：**能做成纯函数的都做成纯函数**。`policy.js` 与 `text.js` 不碰 I/O，所以过滤规则与通知文案可以脱离运行时直接测；`toast.js` 的每个外部依赖（`spawn`、`reg.exe`、文件探测、环境变量）都可注入，所以投递逻辑无需真弹窗便能验证。`apply()` 还接受一个 `overrides.showToast` 注入点，使整条「事件 → 决策 → 投递」链路可以在测试里跑通而完全不产生真实弹窗。

### 依赖说明

本插件把 `@deepseek-ai/schemastery` 声明为**自身依赖**（而不是依赖 Host 提供）。原因是插件常以 `link:`（符号链接）方式安装：ESM 会把符号链接解析到真实路径，而真实路径在 profile 之外，因此 Host 安装域提供的包无法被解析。自带依赖后，`link:` 与 `file:` 两种安装方式都能正常工作。

测试工具的定义是手工构造的（没有用 `@deepseek-ai/dsh-tools` 的 `defineTool`），出于同样原因：该包由运行安装提供，`link:` 安装下无法导入。注册表只要求定义满足既定形状，手工构造可以让测试工具在任何安装方式下都可用。

---

## 环境验证

本插件在以下环境实测通过：

- DeepSeek Harness Desktop `0.1.7-rc.2`（运行时 `0.2.0-rc.2`）
- Electron 44 / Node 24
- Windows 11 26H2（`10.0.26300`）

**已实测确认的行为**

- 原生 Toast 投递成功，并出现在 Windows 通知中心（以通知历史的真实条数判定，而非进程退出码）。
- 品牌化生效：`HKCU\SOFTWARE\Classes\AppUserModelId\DeepSeek.Harness.Notified` 写入后，弹窗显示 "DeepSeek Harness" 与自带图标（免管理员）。
- 点击弹窗可通过 `dsh://open` 唤起应用（该协议已由桌面端注册，`main.js` 中已实现窗口聚焦）。
- 焦点抑制生效：前台进程命中时子进程返回退出码 3 且不弹窗。
- 端到端链路：`turn/start` → `assistant/message` → `turn/end` 后产出 `title=demo`、`body=完成 已修复 边界条件，补了 3 个测试。 a b (9s)`。

**关于安装后生效**

插件安装完成后，需要**重启 DeepSeek Harness** 才会加载当前代码。原因是已安装的包在 Host 进程中的模块代（module generation）是安装那一刻缓存的：安装后继续修改源码，运行中的进程不会重新读取，`apply()` 也仍按旧代码执行。这是 DSH 的既定行为——官方插件开发文档明确写着「替换已安装的包需要重启才能加载新的 JavaScript 模块代」。

重启后可用 `dsh_notify_test` 工具确认通道已就绪。

---

## 开发

```powershell
# 依赖（本仓库用 pnpm，lockfile 为 v9）
pnpm install

# 单测：node 内置 test runner，覆盖 toast / text / policy / plugin 四条链路
pnpm test        # 等价于 node --test "test/*.test.js"
```

约定：

- 纯 ESM（`"type": "module"`），入口 `lib/index.js`，Node >= 20。
- 文本文件一律 LF；`.gitattributes` 已锁定，避免 Windows 上提交出 CRLF 噪音。
- `node_modules/` 不入库，靠 `pnpm-lock.yaml` 复现依赖。
- 改完源码必须**重启 DSH** 才加载新代码（见上文「关于安装后生效」），随后用 `dsh_notify_test` 复核通道。

---

## License

MIT，见 [LICENSE](LICENSE)
