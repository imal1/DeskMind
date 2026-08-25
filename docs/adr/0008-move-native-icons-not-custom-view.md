# v1 通过移动原生图标坐标实现分区，不自绘图标视图

> **Status**: 由 ADR-0013 修订——决策有效，但推迟至 v2 执行。v1 的启动台磁贴由 deskmind 自绘，不受本文约束。

分区是绘制在桌面层的容器框。整理的实际动作，是调用 `IFolderView::SelectAndPositionItems` 把 explorer 的原生桌面图标移动到对应分区的坐标范围内。deskmind 不隐藏、不接管、也不重绘桌面图标。

## Considered Options

**自绘**（隐藏 `SHELLDLL_DefView`，自己实现整套图标视图）是 Fences 采用的方案，功能上限最高。但它需要重新实现渲染、拖拽、框选、右键菜单、双击打开、重命名、跨程序拖放——本质上是重写一个文件管理器视图，会吃掉整个 v1。

**用 `IExplorerBrowser` 托管真实文件夹视图**（分区文件夹内放置指向桌面项的快捷方式，同时隐藏原生桌面图标）是很强的中间方案：分区成为真正的容器，可折叠、可嵌套，而图标行为仍由 Explorer 提供。代价是引入了快捷方式这层间接、需要监视 Desktop 文件夹做同步、以及「在分区里删除」的语义容易让用户困惑。

选择移动坐标，是因为它呈现给用户的核心体验——桌面项自己跑进了正确的分区——与上述两者完全一致，而实现成本低一个数量级。图标始终是 explorer 的原生图标，因此拖拽、右键菜单、双击打开、重命名、缩略图全部免费继承。

需要记录一处早期误判：最初评估认为跨进程设置图标位置必须使用 `LVM_SETITEMPOSITION` 配合 `VirtualAllocEx` / `WriteProcessMemory` 向 explorer 进程写内存，并因此担心杀毒软件误报。实际上 `IFolderView::SelectAndPositionItems` 是文档化的 COM 接口（已取代废弃的 `IShellFolderView::SetItemPos`），不需要任何内存注入，该风险不存在。

## Consequences

分区折叠功能在 v1 无法实现——没有办法隐藏单个原生图标。折叠推迟到 v2。

必须关闭 Windows 的「自动排列图标」，否则图标坐标会被系统重置。

v1 到 v2 的升级路径是切换到 `IExplorerBrowser` 方案。届时分区的数据模型、AI 整理层和界面均可保留，不需要推翻重来——这是选择先做移动坐标、而非一步到位的主要理由。
