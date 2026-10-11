# pi-ttft-tps

> Pi extension that shows **TTFT** (time to first token), **TPS** (output tokens/sec) and **prompt cache hit rate** live in the footer while the model streams.

给 [pi](https://pi.dev) 用的 footer 指标扩展：**首字延迟（TTFT）**、**输出速度（TPS）**、**提示缓存命中率（Cache）**，边流式输出边实时更新。

```
TTFT 1.2s | TPS 42.3 | Cache 87%
```

## 特性

- **TTFT**：从「请求真正发出」到「第一个 token 到达」的耗时。锚点是 `before_provider_request`，因此提示词构建、压缩（compaction）等本地耗时不会被算进首字延迟；等待期显示 `TTFT 843ms…` 这样往上跳，token 到达后定格成最终值。
- **TPS**：输出速度，单位 token/秒。
- **Cache**：提示缓存命中率，`cacheRead / (input + cacheRead + cacheWrite)`，和各家 provider 区分「非缓存输入 / 缓存读取 / 缓存写入」的报法一致。
- **流式实时更新**：provider 只在响应结束时才给出真实 usage，所以流式期间 token 数按已收到的文本估算（CJK 按 1 字≈1 token，其余按 3.5 字符≈1 token），`message_end` 时用精确 usage 校正。
- **值不清零**：新一轮请求不会把指标打回 `--`，上一次测到的值会一直留在屏幕上，直到被新值替换。恢复会话时也会从历史里把缓存命中率读出来先显示。
- **零依赖**：只用 `ctx.ui.setStatus`，不需要任何第三方包。

## 安装

### 方式 1：本地目录（推荐）

```bash
git clone https://github.com/<你的用户名>/pi-ttft-tps.git
pi install ./pi-ttft-tps
```

pi 会把本地安装写成相对于 settings 文件的形式，例如 `"github-repos\\pi-ttft-tps"`，所以仓库可以随便挪，只要相对位置不变。

### 方式 2：git 源

```bash
pi install git:github.com/<你的用户名>/pi-ttft-tps
# 也可以锁定 tag/commit
pi install git:github.com/<你的用户名>/pi-ttft-tps@v0.1.0
```

### 方式 3：手动放单文件

不需要包管理器时，把 `extensions/response-metrics.ts` 复制到 `~/.pi/agent/extensions/`，然后把它加进 `~/.pi/agent/settings.json`：

```json
{
  "extensions": [
    "C:\\Users\\<你>\\.pi\\agent\\extensions\\response-metrics.ts"
  ]
}
```

### 方式 4：只试一次，不写入配置

```bash
pi -e ./pi-ttft-tps
```

装完 `pi list` 可以确认，`pi remove <source>` 卸载。

## 与 pi-powerline-footer 配合（可选）

**不装 powerline** 也能用：pi 内置 footer 会把扩展状态按 key 排序，单独显示一行。

**装了 [pi-powerline-footer](https://www.npmjs.com/package/pi-powerline-footer)** 时，扩展状态默认不会被自动收进状态栏，需要显式声明成一个 custom item。在 `~/.pi/agent/settings.json` 里加上（完整片段见 [`examples/powerline.settings.json`](examples/powerline.settings.json)）：

```json
{
  "powerline": {
    "customItems": [
      {
        "id": "response_metrics",
        "statusKey": "response-metrics",
        "position": "right",
        "color": "muted",
        "hideWhenMissing": false
      }
    ],
    "disabledSegments": ["cache_read"]
  }
}
```

- `statusKey` 必须和扩展里的 `response-metrics` 一致。
- `disabledSegments: ["cache_read"]` 是关掉 powerline 自带的缓存段，避免和本扩展的 Cache 重复显示；如果你更喜欢内置那个，去掉这一行即可。
- `position` / `color` 可自行调整。

改完 `settings.json` 后执行 `/reload`（或重启 pi）。

## 指标口径说明

| 指标 | 起点 | 终点 | 数据来源 |
| --- | --- | --- | --- |
| TTFT | `before_provider_request`（HTTP 调用前一刻） | 第一个 `text_delta` / `thinking_delta` / `toolcall_delta` | 本地计时 |
| TPS | 第一个 token | `message_end` | 优先 `message.usage.output`，流式中用文本估算 |
| Cache | — | — | `message.usage` 的 `cacheRead / (input + cacheRead + cacheWrite)` |

几个刻意的取舍：

- **为什么 TTFT 不锚在 `turn_start`**：`turn_start` 之后还有提示词构建、工具结果拼接、自动压缩等工作，这些都算进去会让首字延迟虚高。`turn_start` 只作为兜底锚点。
- **为什么空闲的模型调用不算进来**：prompt cache 预热、compaction 这类不挂在正常 turn 上的 provider 请求会被忽略，不会污染 TTFT。
- **为什么加载时能看到旧的 Cache**：`session_start` 时会回扫当前分支上最后一条带 usage 的 assistant 消息，把命中率先填上，免得刚打开会话时是 `--`。

## 已知限制

- TPS 在流式期间是**估算值**，`message_end` 后才是精确值；窗口短于 0.2 秒时视为无意义，不显示。
- 部分 provider（尤其是订阅制接入）不返回 `usage`，此时 Cache 会一直是 `--`，TPS 退化为文本估算。
- 只有「最近一次请求」的指标，不做跨请求聚合、历史曲线或落盘统计。
- 需要支持 `--experimental-strip-types` 的 Node（Node 22.6+，推荐 24+），因为扩展是直接以 TypeScript 加载的。

## 卸载

```bash
pi remove ./pi-ttft-tps      # 或 git:... / npm:...
```

手动安装的话，删除 `extensions/response-metrics.ts` 并从 `settings.json` 的 `extensions` 数组里移除对应项。

## 开发

```bash
npm test        # 离线冒烟测试：不需要模型、不需要网络
npm run try     # 用 pi -e 加载本扩展跑一次
```

测试通过一个假的 `pi` 事件总线驱动扩展，覆盖正常轮次、缓存命中率算法、中断/失败轮次不清零、会话恢复预填、流式 TPS 估算、空闲请求不污染 TTFT 等场景。

## License

MIT
