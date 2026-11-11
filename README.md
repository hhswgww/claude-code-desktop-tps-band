# tps-band

在输入框上方的状态条里显示模型输出的速度（token/s），桌面版 Code 标签页和终端都支持。

```
● 63.4 tok/s · 1.8k tok · 12.3s · opus-5-5                       ← 流式中（估算，带 ~）
○ 68.1 tok/s · 2.1k tok · 14.6s · TTFT 0.9s · avg 61.3 · ▃▅▆▇█ · opus-5-5
○ 58.2 tok/s · 3 steps · 5.2k tok · 17.8s · ▂▄▅▆ · opus-5-5       ← 一轮多次调用时按轮汇总
```

- **`●` 亮色**：当前响应还在流式输出，数字按已到达的字符估算，前面带 `~`。
- **`○` 暗色**：最近一次已结束的响应；token 数和速度来自 API 的 `usage.output_tokens`，是精确值。
- **TTFT**：从请求发出到第一个内容块到达的时间；生成口径的 tok/s 不含它。
- **avg / 迷你折线**：最近 12 次响应的速度。
- **一轮里有多步**（例如中间夹了工具调用）时，空闲态显示整轮汇总：步数、总 token、总生成时间。
- 按 Esc 中断时也会留下一条 `~` 读数，不会白跑。
- 宽度自适应：窄窗口先丢掉模型名和 TTFT，再丢掉 token 数，只留速度和时间。
- 默认在一轮结束后保留 60 秒，可在配置里改或设为 0（留到下一轮）；有 survey 占用该区域时让位。

## 配置项

插件清单里声明了三个 `userConfig`，可以在插件的配置菜单里改（改完重载生效）：

| 选项 | 默认 | 说明 |
|---|---|---|
| `speedMode` | `generation` | `generation`：首个内容块 → 结束（纯吐字速度）；`end-to-end`：请求发出 → 结束（含 TTFT）；`both`：生成口径为主，细节里附带 e2e |
| `retainSeconds` | `60` | 一轮结束后读数保留的秒数；`0` 表示保留到下一轮 |
| `showSparkline` | `true` | 是否显示最近速度的迷你折线 |
| `modelLabels` | 空 | 给模型 id 起显示名，逗号分隔的 `id=名字`；末尾带 `*` 表示前缀匹配 |

代理环境下 API 返回的往往是内部别名（比如 `mythos-magpie-1855118842`），用 `modelLabels` 映射一下即可：

```json
"modelLabels": "mythos-magpie-1855118842=Opus 5.5,mythos-magpie-4931619015=Sonnet 5.5,deepseek-*=DeepSeek"
```

## 它怎么算

`turn.step` 是流式事件：请求发出时 hook 开始运行，之后每一块文本、思考、工具参数陆续到达。
第一个非 engine 块的到达时间记为 TTFT 的终点；从它到 `stop` 块之间的时间就是生成窗口。
响应结束时读取 `usage.output_tokens`，除以生成窗口得到精确速度。

流式显示做了两道闸：窗口满 700ms 才出现第一帧，之后每约 16 个块、且距上一帧至少 250ms 才刷新一次，
所以快模型不会逐 token 重绘，刚开始的几毫秒也不会闪出一个离谱的数字。

只统计主循环的 `turn.step`，子代理的步骤不显示（它们并行，放在一条状态条里没有意义）。

## 安装

```bash
git clone https://github.com/hhswgww/claude-code-desktop-tps-band.git ~/.claude/local-plugins/tps-band
```

然后在 `~/.claude/settings.json` 的 `env` 里加：

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/local-plugins/tps-band" } }
```

重启桌面版即可。命令行里也可以临时用 `claude --plugin-dir <folder>`。

开发时把插件放进 `~/.claude/dev-mods/<session-id>/`，在会话里启用热重载，保存即重载。

## 限制

- 流式中的 token 数是按字符估算的（CJK 约 0.7 token/字，拉丁文约 0.26 token/字符），结束时才替换为精确值。
- `generation` 口径不含 TTFT，也不含工具执行时间；它衡量的是模型吐字速度。想要端到端口径就用 `speedMode: "end-to-end"`。
- 第三方 mod 以你的权限运行，不在沙箱内。
