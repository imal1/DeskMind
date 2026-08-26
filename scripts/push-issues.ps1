# 把 deskmind 的待办工作推成 GitHub issue。
#
# 需要先装 gh 并登录：winget install GitHub.cli; gh auth login
# 在仓库根目录运行：powershell -ExecutionPolicy Bypass -File scripts\push-issues.ps1
#
# 按标题去重，重复运行不会建出重复 issue。

$ErrorActionPreference = 'Stop'

$issues = @(

@{ Title = 'WebGL 在桌面层能否拿到硬件加速上下文'; Body = @'
ADR 0016 把「下一步」定在这里，而它至今没被验证。

窗口通过 `SetParent` 挂到 WorkerW/Progman 之下后，WebGL 是否还能拿到硬件加速上下文？整套渲染方案压在这个假设上。若掉进软件渲染，功耗会直接击穿 ADR 0016 定的硬线，玻璃的参数怎么调都是空谈。

**验收**：在桌面层窗口里读 `WEBGL_debug_renderer_info` 的 `UNMASKED_RENDERER_WEBGL`，确认不是 SwiftShader / 软件渲染器。

参考：`docs/adr/0016-rendering-foundation-webgl-and-html-in-canvas.md`
'@ }

@{ Title = '功耗验收：空闲可见 1-2%，被遮挡 0%'; Body = @'
ADR 0016 在写效果之前就定了这条硬线，正是为了做完之后舍不得砍时还能拿出来对。

**验收标准**
- 空闲且可见时 GPU 占用不超过 1-2%
- 被其他窗口完全遮挡时为 0%，一帧都不画

遮挡检测已经实现（`src-tauri/src/desktop.rs`，用 `SPI_GETWORKAREA` 而不是屏幕尺寸），但从未拿真实数字量过。

阻塞于「WebGL 在桌面层能否拿到硬件加速上下文」——软件渲染下这条线必然不达标，先验那个。
'@ }

@{ Title = '生产包白屏：确认 base 修复后重新打包可用'; Body = @'
安装后的生产包报「localhost 拒绝连接」。

诊断：装的安装包是 8 月 19 日的，而源码已到 8 月 24 日，中间整个桌面层、keyring、着色器的工作都不在里面。已在 `vite.config.ts` 加上 `base: "./"` 作为加固——生产环境下资源必须走相对路径，不能指向 dev server。

**验收**：`npm run tauri build` 之后装出来的包能正常起界面。

在这条确认之前不要对外分发。
'@ }

@{ Title = '玻璃效果人工验收'; Body = @'
玻璃已改成用 `drawElementImage` 捕获界面纹理后折射，不再只扭曲壁纸。代码侧的自检都过了（类型检查、面板确实在捕获源之外、降级路径归零），但**渲染出来好不好看只能靠人看**。

**可调的旋钮**（都在 `src/background.ts`）
| 参数 | 当前值 | 管什么 |
|---|---|---|
| `bend` | 46 | 位移量 |
| `RIM` | 34 | 过渡带宽度 |
| `darkness` | 0.16 → 0.54 | 压暗程度 |
| `lod` | 1.2 → 5.0 | 磨砂程度 |

三种特效都要看：高亮（默认）、雾影、纯净。

已知约束（用户已明确，不要回退）：高亮下按钮不能是暗色；高亮不给整个背景加变暗蒙层，提亮只加在面板和导航条上；纯净没有玻璃边框也没有背景遮罩。
'@ }

@{ Title = '删除未引用的 src/probe.ts 与 src/s4.ts'; Body = @'
两个文件都是 spike 期间的产物，现在没有任何地方 import 它们（grep 到的 `probe` 是 `desktop_occluded` 的返回值变量名，不是这个模块）。

留着会让人误以为是活代码。删掉即可，spike 的结论已经落在 `spikes/*/FINDINGS.md` 里了。
'@ }

@{ Title = 'HANDOFF.md 关于 backdrop-filter 的描述已过时'; Body = @'
`docs/design/HANDOFF.md` 第 19 行还写着面板上的 `backdrop-filter` 是开着的，并据此描述了「模糊管可读性、折射管材质感」的分工。

这已经不成立——面板表面整个交给着色器画了（`.panel.glassed` 把 `backdrop-filter` 关掉）。交接文档写错比不写更坏，会让下一个人按错的模型调参。

顺带把那两条「咬人」的规则留着，它们仍然有效：玻璃面板不能做 transform 入场动画（着色器矩形跟不上 CSS transform）；ID 选择器压过属性+类选择器（这条已经咬过两次）。
'@ }

@{ Title = 'ADR 0012 补记：色相取自壁纸，明度由设计固定'; Body = @'
ADR 0012 说配色跟随壁纸。实际实现比这句话精确一层，而那层差别是踩坑踩出来的：

从一张深色竹林壁纸里提出来的强调色被当作填充色垫在近黑文字底下，按钮和标签页糊成一团。修法是 `src-tauri/src/theme.rs` 里的 `brighten()`，把明度强行拉到 0.72 同时保持色相——按通道向白色缩放而不是直接乘，后者会把最亮的通道打爆并偏色。

**取自壁纸的是色相，明度是设计定的常量。** 这条要写进 ADR，否则下一个人会「修好」这个看起来多余的函数。
'@ }

@{ Title = '决定文件拖入桌面的语义'; Body = @'
`src/main.ts:266` 有一条 `ponytail:` 注释挂着这件事：磁贴可以拖到分区标签上，但从资源管理器**拖进来**的文件该怎么处理还没定。

难点不在实现，在语义，而且撞着 ADR 0004（deskmind 从不移动、重命名或删除用户的任何文件）：

- 拖进来是**新增一个启动项**（只记路径，不碰文件）——和 ADR 0004 相容
- 还是**把文件收进某个分区**（听起来像移动文件）——和 ADR 0004 冲突

先把语义定下来再写代码。定完更新 CONTEXT.md 里「分区」的词条。
'@ }

@{ Title = '效果 A：转场与微交互'; Body = @'
ADR 0016 的四类效果里记录、暂缓的一类。

惯性重排、弹性回弹这类。**不需要动架构**——CSS 加动画库就够，不涉及着色器和纹理管线。

优先级低于 B（折射玻璃）和 D（生成式背景），那两个已经在做了。

注意一条既有约束：玻璃面板不能做 transform 入场动画，着色器矩形跟不上 CSS transform，只能淡入（`dmfade`）。做这条时别把它撞掉了。
'@ }

@{ Title = '效果 C：真 3D'; Body = @'
ADR 0016 的四类效果里记录、暂缓的一类，也是四个里最贵的。

磁贴有远近、分区切换是镜头移动、拖动有物理。

**代价**：需要整个 UI 进 canvas。ADR 0016 已经评估过并否决了这条路，决定性的一条是**中文输入法**——canvas 里没有 DOM 输入框，IME 的候选窗定位、组合中文本、预编辑渲染全部要自己实现，而搜索框是 deskmind 的核心交互，它必须能打中文。

所以这个 issue 存在的意义是**记录已经想过**，不是待办。真要做，得先解决 IME，而不是先写 3D。

若确实要推进：ADR 0016 给了迁移路径，多 pass 合成写起来费劲时引 OGL（零依赖、自带 render-to-texture、API 刻意做成 three.js 的样子），换的是库不是脑子里的模型。
'@ }

)

# gh 没装或没登录的话，先在这里失败，比建到一半失败干净
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'gh 未登录。先跑 gh auth login' }

$existing = @((gh issue list --state all --limit 200 --json title | ConvertFrom-Json).title)

foreach ($issue in $issues) {
    if ($existing -contains $issue.Title) {
        Write-Host "跳过（已存在）: $($issue.Title)"
        continue
    }
    $url = gh issue create --title $issue.Title --body $issue.Body
    Write-Host "已创建: $($issue.Title)"
    Write-Host "  $url"
}
