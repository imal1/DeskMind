# S5 结论：drawElementImage 可用，但完全依赖 flag

在 WebView2（Chromium **151**）中实测：

| 配置 | 结果 |
|---|---|
| 传 `--enable-blink-features=CanvasDrawElement` | **✓ `drawElementImage()` 存在** |
| 不传任何 flag | ✗ 两个候选方法名都不存在 |

**结论：HTML-in-Canvas 可用，但唯一的开关是 flag。API 尚未正式发布。**

## 方法名是 `drawElementImage`，不是 `drawElement`

探测时同时试了两个候选名，命中的是 `drawElementImage`。提案在演进中改过名——只查 `drawElement` 会把一个可用的环境误判成不可用。

特性检测必须同时接受这两个名字，将来可能还要再加。

## flag 不受 origin trial 期限约束

这是个对我们有利的发现。origin trial 的窗口是 Chrome 148–150，而实测机器是 **151**，已经过期，`--enable-blink-features` 照样把特性打开了。

**flag 比 trial 活得久。** 因此 ADR 0016 初稿里担心的「某个周二 trial 到期，效果在所有用户机器上同时失效」这个风险被高估了。

真正的风险因此收窄成一条：**这个 flag 本身哪天被 Chromium 移除**。它会在两种情况下发生——特性正式发布并换成别的名字，或者提案被放弃。两种都不是无声的，前者还是好消息。

## 对分发决定的影响

ADR 0016 定的「Evergreen + 硬性版本下限 + 生产版携带 flag」**继续成立**，但风险描述要按上面修正。

微软文档警告不要在生产版携带浏览器 flag，我们知情接受，缓解手段是运行时特性检测——检测不到就把玻璃退回 `backdrop-filter`，安静降级而不是白屏。

## 一个操作上的坑

Tauri 的 `additionalBrowserArgs` 是**替换**而非追加。设置它会顶掉 Tauri 默认传的
`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，导致 Edge 的 PDF 查看器和 SmartScreen 界面冒出来。必须把默认值一起写回去。

## 另一个操作上的坑

诊断信息最初用 toast 显示，4 秒后消失，在启动扫描的忙乱中被错过，一度以为探测代码没跑。**spike 的结论必须常驻到被主动关掉为止**——一分钟后还能看到，才算把答案交付了。
