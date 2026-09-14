# dsh-cooldown-retry

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)

> English docs → **[README.md](README.md)**

**给 DeepSeek Harness 的「耐心重试」插件。** 上游模型网关返回 `429 Too Many Requests` 并附带 `retry_after_seconds` 时——例如 *「All upstream providers are cooling down. Please retry after 28 seconds.」*——本插件按上游给出的延时等待后重试，而不是让内置 `llm-retry` 在 28 秒冷却窗口里用两次快速重试（500ms → ~1s）必然撞死、直接中断本轮对话。

它还额外吸收一类实测到的网关 bug：饱和期里，共享网关会给一个**完全普通**的请求回 `400`、正文写着 *「Audio modality is not supported」*（而请求里根本没有音频），把这个报文记进**客户端错误熔断器**，然后在熔断窗口内对后续每一个请求**重放同一条 400**，导致一轮接一轮地失败。只要同一 provider 刚刚出现过容量冷却，本插件就把这种报文当作熔断重放，用**独立的预算**把它等过去。

## 问题所在

共享 LLM 网关（校园网、自建代理、供应商池）高峰期返回的往往不是连通性错误，而是**容量**类 429：池子瞬时耗尽或熔断器打开，并且响应里明确告诉你要等多久。

DSH 其实**能**用上这个提示，但只有一条很窄的路径：

- 当 `failure.providerRetryAfterMs` 字段存在时，`llm-retry` **确实会**采用它（`packages/llm/llm-retry/src/index.ts`）：原样等待该时长，上限是 `policy.maxDelayMs`，超过上限则交给下一个监听者。
- 该字段由解析 HTTP `Retry-After` 响应头的适配器填充，`llm-deepseek` 是其中之一。
- **`llm-pi-ai` 完全不解析它**——在整个包内搜索，除了一处测试夹具外找不到任何 `retry-after` 处理。走该适配器时这个字段**永远不会**被设置。
- 于是当唯一的提示是**报文正文里的那串散文**时，DSH 里没有任何东西会去读它：`llm-retry` 退回本地退避（~500ms → ~1s，2 次），本轮对话就在 28 秒冷却窗口里报废——尽管「等 28 秒」本来能成功。

本插件补的就是这个缺口：从报文里读出提示，然后按上游要求的时长耐心等待。

## 它做了什么

|  | 内置 `llm-retry`（无可用提示时） | `dsh-cooldown-retry` |
|---|---|---|
| 每个 (turn, provider) 尝试次数 | 2 | 5 |
| 退避策略 | 固定 ~500ms → 1s | 直接采用上游给的 `retry_after_seconds` |
| 延时区间 | — | 钳制在 1s … 300s |
| 响应中断 | — | 是——本轮被取消时立刻结束等待 |
| 识别的提示字段 | — | `providerRetryAfterMs`、`retryAfter`、`retry_after_seconds`、`retry_after_ms`、散文式 `retry after N` |

它**只**接管两类失败：带有重试提示的容量冷却；以及——在 `mislabeledClientError` 打开时（默认开）——一个声称某模态「is not supported」的 `400`，**且**它出现在同一 provider 上一次容量冷却的 `mislabeledEvidenceMs` 窗口之内。其余情况一律通过 `next()` 交给下一个监听者，所以鉴权错误、网络错误、不带提示的 429、以及真正的客户端错误都保持内置行为不变。

预算是按 **turn + provider** 计的，而不是按 step：一个多步的 turn 里每一步都撞同一个冷却时，它们共享一份预算，而不是每步各拿一份新的 5 次。进入新 turn 时预算重置。

## 配置

默认值 `maxRetries: 5`、`minDelayMs: 1000`、`maxDelayMs: 300000`、`acrossSteps: true`、`hintlessBackoff: false`、`hintlessBaseDelayMs: 5000`、`mislabeledClientError: true`、`mislabeledMaxRetries: 3`、`mislabeledBaseDelayMs: 15000`、`mislabeledEvidenceMs: 600000`。在你自己的 patch 层里覆盖：

```yaml
- id: cooldown-retry
  config:
    maxRetries: 10
    maxDelayMs: 600000
```

非 `insert` 的 patch 会替换目标行的**整个** `config`，所以没改的键也要重述。不可用的值会被忽略并退回默认值，区间写反了会被修正而不是照单全收；`maxRetries` 与 `mislabeledMaxRetries` 上限均为 100。

| 键 | 含义 |
|---|---|
| `maxRetries` | 每个 turn/provider 耐心重试多少次后把失败交还给下游。 |
| `minDelayMs` / `maxDelayMs` | 所有等待都会被钳进这个区间。 |
| `acrossSteps` | `true`（默认）让一个 turn 的各 step 共享一份预算；`false` 恢复「每个 turn/step 各一份」。 |
| `hintlessBackoff` | 连**没有**提示的容量冷却也接管，退避用 `hintlessBaseDelayMs * 2^(attempt-1)`。默认关闭：无提示的限流与「容量永久不足」在观感上无法区分，接管它是策略变更而不是修 bug。 |
| `hintlessBaseDelayMs` | 无提示退避的第一步延时。 |
| `mislabeledClientError` | `true`（默认）也把「声称某模态 is not supported、而请求里并没有该模态」的 `400` 等过去——那是饱和网关建立的客户端错误熔断器在重放。设 `false` 则让所有 `400` 原样到达调用方。 |
| `mislabeledMaxRetries` | 上述重放的独立重试预算，**与 `maxRetries` 分开计**：等熔断不该和 429 预算互相挤占。 |
| `mislabeledBaseDelayMs` | 重放报文自身没有提示时的基础延时（熔断报文里的 `retry_after_sec` 若存在则原样采用）。按次数翻倍。 |
| `mislabeledEvidenceMs` | 一次容量冷却在多长时间内仍算「证据」。超出该窗口后，同样的 `400` 会被当作真实客户端错误交还下游。 |

## 可观测性

每次等待与放弃都走 `ctx.logger`、名为 `cooldown-retry`，与其它应用日志并列，而不是裸 `console.log`：

```
[cooldown-retry] upstream cooling down for nuaa (turn 3 step 2): retrying in 28000ms (1/5)
```

在输入框里执行 `/cooldown-retry` 会打印计数器：

```
cooldown-retry — budget per turn, max 5 retries, window 1000–300000ms, mislabeled-400 takeover on (max 3)
this turn: retries 3 | waited 84s | gave up 1 | no-hint capacity failures 2 | mislabeled 400 retries 1 | nuaa×4 | last: nuaa 15.0s (1/3) — mislabeled 400
lifetime:  retries 11 | waited 4m 12s | gave up 2 | no-hint capacity failures 7 | mislabeled 400 retries 3 | nuaa×10 deepseek×2
```

该命令只在 `commands` 服务存在时注册。没有它的上下文——headless、ACP、不完整的 profile——照样挂载、照样重试，只是没有这条命令。这是刻意的：把 `commands` 写成硬 `inject` 依赖，会因为一条装饰性命令而让整个插件卡在 `waiting`。

## 安装

### 作为 DSH 组合包（推荐）

```sh
dsh plugin --profile web add github:dboycht/dsh-cooldown-retry
```

`dsh plugin add` 会把包装进 profile、登记 `dsh.bundle.patch` 声明的组合包层，该行在下一次配置重载时挂载——**无需重启**。设计上就是永久的，升级也不会丢。（它底层是把参数转发给 profile 目录里的 pnpm，所以 `github:` 写法需要 `PATH` 上有 `git`——DSH 本身本来也依赖这一点。）

**验证**是否挂上——让 DSH 打印组合后的配置树，看有没有这一行：

```sh
dsh --profile web --dump-config | grep -A2 'cooldown-retry'
```

```yaml
# == dsh-cooldown-retry
- id: cooldown-retry
  name: dsh-cooldown-retry
```

**位置很重要**：这一行必须出现在内置 `llm-retry` 行的**后面**。`agent/request-error` 是 waterfall，后注册的监听者绑定为内层监听者，因此本插件才能对每次失败拥有优先接管权，而不是被内置快速重试短路。

### 不安装包，直接挂文件

让某一行直接指向文件即可。**新增行必须用 `insert`**，且 `name` 必须是 `file:///` URL——见下方[踩坑](#踩坑)。

```yaml
- insert:
    - id: cooldown-retry
      name: "file:///绝对路径/dsh-cooldown-retry/index.js"
```

写进机器级 `$DSH_HOME/cordis.patch.yml`（所有 profile 生效）或某个 profile 自己的 `cordis.patch.yml`（仅该 profile）。两层都被监视，保存即热生效。

## 卸载

```sh
dsh plugin --profile web remove dsh-cooldown-retry
```

如果之前加过 `- id: cooldown-retry` 覆盖行，记得从 patch 层里删掉。

## 可选：浮动倒计时徽标

[`dynamic/`](dynamic/) 里是给 DSH **动态 Cordis 插件**路径用的两半版本，会在窗口底部显示一个小徽标——*「上游冷却中，约 23 秒后自动重试（第 1/5 次）」*。

它依赖 `harness.handle` / `host.call`，这两个内建**仅**动态插件才有，所以它无法作为组合包行发布，且进程重启后即被抹除。请把它当作永久行旁边的装饰件，而不要当作替代品。

## 踩坑

下面两条都会**静默失效**。在用文件路径挂任何 DSH 插件行之前，建议先读一遍。

### 1. 新增行必须用 `insert`

非 `insert` 的 patch 条目语义是「覆盖这个 id 的已有行」。所以写 `- id: cooldown-retry` 再加 `name:`，会被理解为「覆盖一个不存在的行」：DSH 往 stderr 打一句 `patch: entry "cooldown-retry" not found` 然后**跳过它**。你的配置看起来完全正确，界面上不会冒出任何错误，而实际上什么都没挂载。

```yaml
# ✗ 静默失效
- id: cooldown-retry
  name: "file:///路径/index.js"

# ✓
- insert:
    - id: cooldown-retry
      name: dsh-cooldown-retry
```

### 2. 文件型行的 `name` 必须是 `file:///` URL

| `name` 写法 | 结果 |
|---|---|
| `D:/路径/index.js` | ✗ `ERR_UNSUPPORTED_ESM_URL_SCHEME`——Node 把 `D:` 当成 URL 协议 |
| `./路径/index.js` | ✗ 按 **profile 目录**解析，而不是 patch 文件所在目录 |
| `file:///D:/路径/index.js` | ✓ |

原因：加载器只把以 `.` 开头的名字当相对路径（相对它的 `baseUrl`，而 `baseUrl` 是 profile 目录），其余一律走裸 `import()`；裸 `import()` 在 Windows 上只接受合法的 `file://` URL。

## 工作原理

`agent/request-error` 是 **waterfall** 事件：监听者按注册顺序由外到内执行，第一个返回 `{ kind: 'retry' }` 且**不**调用 `next()` 的会否决整条链的后续部分（包括内置行为）。

所以同时跑两份——比如组合包行 + 一个动态插件——**不会**让重试翻倍。每次失败只由其中一个接管，另一个被短路。先注册的那份胜出。

## 开发

```sh
git clone https://github.com/dboycht/dsh-cooldown-retry && cd dsh-cooldown-retry
npm test        # node --test —— 零依赖、无需构建
```

测试在 `test/` 目录，它**不属于**发布/安装包（`files` 白名单只装运行 DSH 所需的文件），所以请克隆仓库后再跑，不要在 `node_modules` 里跑。

重试决策相关的纯函数——`extractDelayMs`、`isCapacityFailure`、`clampDelay`、`planDelay`、`counterKey`、`resolveOptions`、`createStats`、`formatStats`——都已导出并有单元测试；`apply()` 只是包在它们外面的薄薄一层 Cordis 接线，测试用桩上下文驱动它，因此「接管什么、委托什么、怎么计数」都在覆盖范围内。

桩上下文只是替身，不算证明：`npm test` 走 `node --test`，它为每个测试文件 **spawn 一个子进程**，因此在受限机器（或禁止管道 stdio 的沙箱）里即使用例全绿也可能报 `spawn EPERM`。`node test/retry.test.js` 是同一套用例的进程内跑法，作为兜底。

`inject` 里刻意只有 `timer`：`commands` 与 `logger` 都通过 `ctx.get` / `ctx.logger` 读取并优雅降级；`ctx.logger` 用的是**可调用形式**——`ctx.logger('cooldown-retry')`——并保留普通对象兜底，因为 Cordis 的 logger 服务既可调用、又直接挂着 `.info`/`.warn`。

### 为什么提示正则长这样

最直觉的写法 `/retry-?after/` 只能匹配 `retry-after`，**匹配不了** `retry_after`（下划线），也**匹配不了** `retry after`（空格）。基于它写出的实现会拒绝掉它本来要处理的那个错误，而且是**静默**拒绝：匹配不到提示不算错误，插件只是调用 `next()`，内置重试照旧放弃。

所以这里所有分隔符都是 `[_\s-]*`，带单位限定的散文模式**先于**裸模式执行（否则 `after 1500 ms` 会被读成 1500 **秒**），并且每种情况都有一个基于真实网关报文的回归测试。

## 许可证

[MIT](LICENSE) © 2026 dboycht
