# deskmind

deskmind 就是你的 Windows 桌面。用 AI 把已安装程序和桌面文件分好组，点一下就整齐。

它不是一个需要唤出的启动器——它一直在那儿，你看向桌面看到的就是它。

## 它做什么

- **整理** —— 把启动项归入分区。分区是你的：AI 首次运行时提一套建议，之后只能往已有分区里放东西，不会自己新建或改名
- **搜索启动** —— 点「搜索启动项」，模糊匹配，`vsc` 能找到 Visual Studio Code
- **跟着壁纸走** —— 界面配色从当前壁纸取，换壁纸自动跟着变
- **固定** —— 常用的排在分区最前面

## 它不做什么

- **不碰你的文件。** 整理只改变分组归属，从不移动、重命名或删除磁盘上的任何东西
- **不替换 explorer.exe。** 它是一个挂在桌面层的普通窗口，其他应用正常盖在它上面
- **没有服务端。** 你填自己的 API key，请求从这台电脑直连模型厂商，我们不是数据的接收方也不是中转方

## 装

到 [Releases](../../releases) 下载安装包。装到当前用户目录，不需要管理员权限。

首次运行会引导你填一次 API key。默认用 DeepSeek，任何 OpenAI 兼容的服务都可以，在设置里改模型和接口地址即可。

**key 存在 Windows 凭据管理器**，不写进配置文件、不随配置同步。整理时只把启动项的**名字**发给模型，不发路径、不发文件内容。

## 从源码跑

需要 Rust、Node.js，以及 MSVC 生成工具（Rust 在 Windows 上链接要用）。

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
```

然后：

```powershell
npm install
npm run tauri dev          # 开发
npm run tauri build        # 出安装包
bun test                   # 前端测试
cd src-tauri; cargo test   # 后端测试
```

## 数据存在哪

| 内容 | 位置 |
|---|---|
| 模型、接口地址、引导状态 | `%APPDATA%\deskmind\config.json` |
| 分区、固定与隐藏 | `%APPDATA%\deskmind\zones.json` |
| API key | Windows 凭据管理器，名为 `deskmind` |

两个 JSON 都是给人读的，可以手改、可以分享。

## 想了解为什么这么做

`docs/adr/` 里是一路上的架构决策，每份都写了当时的权衡和被否掉的选项。`spikes/` 里是动手前做的验证，包括 AI 分组质量的实测数据，和桌面层能不能接收键盘输入的结论。

## 已知缺口

- 桌面层盖住了原生桌面图标，因此**从资源管理器拖文件到桌面不再有效**
- 少数商店应用的图标仍会是通用图标
- 自定义热键还没做，固定为 `Alt` + `Space`

## License

MIT
