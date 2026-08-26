# 桌面是压在最底的普通窗口，启动台浮层取消

> 修订 ADR-0015。桌面表面仍是唯一主表面，但托管方式和窗口数量都变了。

deskmind 是**一个普通顶层窗口**，压在 z-order 最底、带 `WS_EX_NOACTIVATE` 与 `WS_EX_TOOLWINDOW`，不再 `SetParent` 到 Progman/WorkerW 之下。

热键唤出的 `launchpad` 窗口、`Alt+Space` 全局热键、以及托盘的「打开启动台」一并删除。deskmind 只有一个窗口。

## 为什么必须改：WebView2 挂到桌面层就收不到鼠标

ADR 0015 押在 S3 spike 上，而 S3 验的是**记事本**——一个普通 Win32 窗口。WebView2 不是。

实测对照，同一个构建、同一台机器、真实 `SendInput` 点击打在磁贴正中：

| 托管方式 | DOM 收到的事件 |
|---|---|
| `SetParent` 到 Progman 之下 | `[]` |
| 普通顶层窗口 + `HWND_BOTTOM` | `pointerdown` / `mousedown` / `click` → `tileico` |

**挂到桌面层之后，界面画得出来，但一个鼠标消息都进不去。** WebView2 的输入走它自己的跨进程 widget（`Chrome_RenderWidgetHostHWND` 属于 `msedgewebview2.exe`），`SetParent` 之后这条路断了。z-order 不是原因——实测我们排在 `SHELLDLL_DefView` 之上，图标层没挡住我们。

这个缺陷此前一直没暴露，是因为界面上大约九成面积是壁纸层，点下去本来就没有可点的东西；剩下一成的磁贴点不动，被误当成「桌面本来就这样」。用户按 `Alt+Space` 唤出浮层后一切正常，再按一次又不能点——两个窗口渲染同一份界面，肉眼分不出换了表面，症状因此长期被读成热键 bug。

## 新方案的构造与代价

`desktop::settle()` 做三件事：加 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`，`SetWindowPos(HWND_BOTTOM, …, SWP_NOACTIVATE)`，尺寸铺满主屏。

- **`WS_EX_NOACTIVATE`** 是关键。没有它，点一下磁贴就会把整个桌面表面提到最前、盖住用户正在用的窗口——真桌面从不这样。实测它只拒绝激活，不拦鼠标消息。
- **`WS_EX_TOOLWINDOW`** 把我们从 Alt+Tab 里拿掉。桌面不是一个可以 Tab 过去的东西。

代价有两条，都由 `desktop::hold()` 兜住，搭在已有的每秒遮挡轮询上：

- **Win+D / 显示桌面会最小化我们**。挂在 Progman 下的子窗口不会——这是旧方案唯一真正做得更好的地方。检测到最小化就 `ShowWindow(SW_SHOWNOACTIVATE)` 恢复。
- **别的窗口可能沉到我们下面**，因为「最底」只维持到有人来抢。每次轮询重新压回 `HWND_BOTTOM`。

一秒的粒度意味着这两种情况都会有一次可察觉的延迟。可以接受：多显示一秒的错误 z-order，代价远低于每帧查询窗口栈。

**前台状态下不压回。** `grab_focus` 会在搜索框需要键盘时主动把我们提到前台，此时再沉下去会把正在打字的界面丢到别的窗口后面。

## 键盘：仍然要显式争取，但触发点变了

`WS_EX_NOACTIVATE` 的代价是点击永远不带来键盘焦点。ADR 0015 里 `grab_focus` 挂在每一次 `mousedown` 上，那在新方案里是错的——每次点击都 `SetForegroundWindow` 等于自己撤销 `NOACTIVATE`。

现在只有两处真正需要键盘时才争取：打开搜索面板，以及首次运行流程。其余交互都是鼠标，不碰焦点。

## 为什么顺手把启动台删掉

ADR 0015 给浮层留的角色是「用户正在其他应用里工作、不想最小化一切时临时取用」。产品意图是**替代桌面本身**，而一个需要唤出的东西不是桌面，是启动器。桌面表面能点之后，浮层不再有存在理由。

删掉它同时消掉了几个自带的毛病：`fullscreen: true` 会让 Windows 隐藏任务栏；`Alt+Space` 抢占了窗口系统菜单；两个窗口渲染同一份界面，是上面那个误诊能成立的直接原因。

## Consequences

只剩一个窗口，`isDesktop` 分支、`dismiss()`、失焦隐藏（ADR 0014 的适用对象）全部消失，连同 `tauri-plugin-global-shortcut` 依赖。

**ADR 0014 现在没有适用对象了**：它约束的是全屏置顶浮层，而那个窗口已经不存在。

桌面图标仍被盖住，ADR 0015 的那条 Consequences 继续有效——原生桌面的用途要由 deskmind 自己补齐。空白处右键菜单是为此补的。

搜索只能点「搜索启动项」进入。没有全局热键意味着 deskmind 不在别的应用之上提供任何入口，这是「它是桌面，不是启动器」的直接推论。

`spikes/s3-workerw/FINDINGS.md` 的结论对记事本仍然成立，但**不能再当作 WebView2 的依据**。往后任何「某窗口手法可行」的 spike，都必须用真实的 WebView2 窗口验，而不是随手找个 Win32 窗口。
