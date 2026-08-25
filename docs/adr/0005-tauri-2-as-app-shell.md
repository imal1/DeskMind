# 采用 Tauri 2 作为应用外壳

deskmind 使用 Tauri 2（Rust + 系统自带的 WebView2）构建：Rust 侧负责全部 Win32 工作（WorkerW 挂载、图标提取、窗口枚举、全局热键、托盘），前端用 Web 技术做界面。

## Considered Options

**Electron** 被否，因为它在这个项目里两头不占：Win32 调用要靠 node-ffi 之类的胶水层，包体又比 Tauri 大一个数量级。

**C# + WinUI 3** 是很强的候选。Win32 的 P/Invoke 在 C# 里是母语级体验，示例和资料最多（Lively 走的正是这条路）。它输在 UI 迭代速度——对一款美化软件来说，界面表现力和改版速度是命根子，Web 技术在这一点上优势明显。

需要说明的是，这个项目大约 60% 的工作量是枯燥的 Win32 调试。**开发者对语言的熟练度，比语言本身的优劣更能决定成败。** 如果实际开发中发现 Rust 的学习成本吃掉了 Tauri 带来的收益，改用 C# + WinUI 3 是完全合理的翻案，本 ADR 应当被取代。

## Consequences

Rust 侧通过 `windows` crate 直接访问 Win32 API，不需要任何 FFI 胶水。安装包体积在几 MB 量级，WebView2 由系统提供。
