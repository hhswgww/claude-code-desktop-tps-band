# tps-band

在输入框上方的状态条里显示模型输出的速度（token/s），桌面版 Code 标签页和终端都支持。

```
● 63.4 tok/s · 1.8k tok · 12.3s · TTFT 0.9s · opus-5-5
○ 68.1 tok/s · 2.1k tok · 14.6s · avg 61.3 · opus-5-5
```

- **`●` 亮色**：当前响应还在流式输出，数字按已到达的字符估算，前面带 `~`。
- **`○` 暗色**：最近一次已结束的响应，token 数和速度来自 API 的 `usage.output_tokens`，是精确值。
- **TTFT**：从请求发出到第一个内容块到达的时间，不计入 tok/s 的生成窗口。
- **avg**：最近 12 次响应的平均速度。
- 一轮结束后状态条保留 60 秒，然后自动消失；有 survey 占用该区域时让位。

## 它怎么算

`turn.step` 是流式事件：请求发出时 hook 开始运行，之后每一块文本、思考、工具参数陆续到达。
第一个非 engine 块的到达时间记为 TTFT 的终点；从它到 `stop` 块之间的时间就是生成窗口。
响应结束时读取 `usage.output_tokens`，除以生成窗口得到精确速度。
流式过程中每约 8 个块刷新一次状态，避免逐 token 重绘。

只统计主循环的 `turn.step`，子代理的步骤不显示（它们并行，放在一条状态条里没有意义）。

## 安装

开发目录里启用过热重载后，本 session 会自动加载。要让桌面版每次启动都加载：

```bash
git clone https://github.com/hhswgww/tps-band.git ~/.claude/local-plugins/tps-band
```

然后在 `~/.claude/settings.json` 的 `env` 里加：

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/local-plugins/tps-band" } }
```

重启桌面版即可。命令行里也可以临时用 `claude --plugin-dir <folder>`。

## 限制

- 流式中的 token 数是按字符估算的（CJK 约 0.7 token/字，拉丁文约 0.26 token/字符），结束时才替换为精确值。
- 速度的"生成窗口"不含 TTFT，也不含工具执行时间；它衡量的是模型吐字速度。
- 第三方 mod 以你的权限运行，不在沙箱内。
