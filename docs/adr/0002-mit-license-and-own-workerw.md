# 采用 MIT 许可证，自行实现 WorkerW 桌面层

> **Status**: 由 ADR-0013 修订——MIT 不变；WorkerW 部分推迟至 v2。

deskmind 采用 MIT 许可证发布，并且不复用 Lively Wallpaper（GPL-3.0）的任何源码——把窗口挂到桌面层所需的 WorkerW 逻辑由我们自己实现。

## Considered Options

直接复用 Lively 的桌面层实现可以省下工作量，但 GPL-3.0 的传染性会要求 deskmind 整体以 GPL-3.0 发布，锁死未来转向闭源或商业授权的可能。

而 WorkerW 的挂载逻辑本身只有约 50 行：向 `Progman` 窗口发送未文档化消息 `0x052C` 使系统生成 `WorkerW` 窗口，枚举找出其中不含 `SHELLDLL_DefView` 子窗口的那一个，再对目标窗口调用 `SetParent`。代码量小到不值得为它接受 copyleft 传染。

## Consequences

许可证可以从宽松改为严格，反之几乎不可能。选择 MIT 保留了后续转向商业化的空间。

参考 Lively 的设计思路不受任何限制，受限制的只是复制它的代码。
