# 不引入 agent 框架，AI 层是一次结构化调用

整理功能通过 Rust 侧直接调用模型 API 实现（`async-openai` 直连，DeepSeek 兼容 OpenAI 格式），约 100 行。不引入 DeepSeek Harness、pi 或任何其他 agent 框架。

## Considered Options

项目早期认真评估过把 DeepSeek Harness（`dsh`）或 pi（`@earendil-works/pi`）作为 AI 层的基础。

**DeepSeek Harness** 被否：它是一个需要整体接入的 harness，Web UI、CLI、沙箱捆在一起，而我们只会用到其中很小一部分；它处于 developer preview 且明确声明会有破坏性变更；接入它意味着必须分发 Node.js 运行时。

**pi** 是明显更好的候选，因为它是分层的库而非整块的 harness——可以只装 `pi-agent-core` 和 `pi-ai`，跳过 coding agent CLI。但它同样需要 Node.js 运行时（可用 bun 编译为单 exe 缓解，代价是安装包增加 60~90MB 和一个需要管理生命周期的 sidecar 进程）。

真正的决定性理由不是运行时，而是**功能形态不匹配**：v1 的整理不是 agent 行为，是一次调用。输入是桌面项的文件名列表，输出是分组结果的 JSON。没有多轮对话、没有工具调用、没有会话状态、没有任务规划。而 agent 框架的核心价值恰恰是 agent 循环、工具调用和会话管理——v1 一样都用不上。

## Consequences

这个决定绑定在 ADR 0001（美化为主线，AI 为差异化能力）之上。如果未来产品重心转向「桌面助手能自主执行多步操作」，AI 层就会需要真正的 agent 能力，届时引入 pi 是合理的，本 ADR 应当被重新审视。

在那之前，任何"要不要上 agent 框架"的提议，都应先回答：当前需求是否真的需要多轮工具调用？
