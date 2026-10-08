# dsh-fullscreen

给 DSH Desktop 补上「全屏」这个缺失的开关。

## 为什么需要它

DSH Desktop 的主窗口本身**支持**全屏，但没有任何入口：

- 主窗口的 `BrowserWindow` 选项里没有 `fullscreenable: false`（只有对话框等辅助窗口有），所以窗口可以被切到操作系统级全屏；
- 但 Windows 上 `WindowsPlatformStrategy.configureWindow()` 调用了 `window.removeMenu()`，Electron 默认菜单随之消失，默认的 `F11 = togglefullscreen` 加速键也就没有了；
- macOS 的 `platformMenus()` 只有 fileMenu / editMenu / windowMenu，没有带 `accelerator` 的全屏菜单项（见上游讨论 [#7717](https://github.com/deepseek-ai/deepseek-harness/discussions/7717)）；
- 渲染进程与宿主之间的通道是封闭的白名单动作集（`terminal | developer | diagnostics | check-for-updates | restart | restart-recovery | reload`），没有窗口控制；preload 只暴露 `dshDesktopActions.invoke`。

页面唯一能用的通道是 **DOM Fullscreen API**——Electron 会把它翻译成 `BrowserWindow.setFullScreen(true)`。本插件的浏览器半区就是这个开关。

## 用法

| 操作 | 结果 |
| --- | --- |
| `F11` 或 `Ctrl`+`Cmd`+`F` | 进入全屏；再按一次退出 |
| `Esc` | 退出全屏（浏览器/系统行为） |

**状态记忆**：只要窗口处于全屏，插件就记下这个状态（`localStorage['dsh-fullscreen:on:v1'] = '1'`）。之后页面刷新、渲染进程恢复、窗口从托盘重新显示时，它会自动把窗口重新切回全屏。手动退出全屏（再按一次 F11 或 Esc）会清掉这条记忆，不会「按不住」。

恢复时如果浏览器要求用户手势（Chromium 对 `requestFullscreen` 的瞬态激活要求），插件不会造假，而是安静地等你的**下一次点击或按键**再恢复；那次点击/按键本身的功能不受影响（监听器不调用 `preventDefault`，且生效后立即摘除）。

## 自检

在页面控制台（开发者工具）里：

```js
window.__DSH_FULLSCREEN__.state()
// { supported, attached, entrance, preference, fullscreen, fullscreenElement, restoreRun, lastAction, lastError, lastChangeAt }

window.__DSH_FULLSCREEN__.toggle()            // 立刻切换
window.__DSH_FULLSCREEN__.setPreference(false) // 只清记忆，不动窗口
```

`<html data-dsh-fullscreen="1">` 表示浏览器半区已挂载（是挂载标记，不是全屏状态）。

## 安装

插件包本体：`E:\dsh\dsh-plugins\dsh-fullscreen`。

两条安装路线，任选一条：

1. **目录副本**（本机当前采用）。把包内容放进 `<profile>\node_modules\dsh-fullscreen\`，并在 `<profile>\cordis.patch.yml` 的 `- insert:` 列表里加一行：

   ```yaml
       - id: dsh-fullscreen
         name: dsh-fullscreen
   ```

   注意：`- insert:` 在同一个文件里只能出现一次（重复的顶层 YAML 键会让整个 patch 失效），所以新行要追加到已有的那个 insert 列表里。

2. **Junction（单一来源，推荐长期使用）**：

   ```powershell
   pwsh -File E:\dsh\dsh-plugins\dsh-fullscreen\install.ps1
   ```

   `install.ps1` 在 `<profile>\node_modules` 下建 junction 指向本包，并把上面两行补进已有的 `- insert:` 列表（幂等，不重写其它行）。`uninstall.ps1` 只删 junction 与那两行。
   两个脚本都用 `[System.IO.File]::WriteAllLines` + 无 BOM UTF-8 写文件——因为 `cordis.patch.yml` 里有中文注释，PowerShell 5.1 处理 BOM-less UTF-8 会乱码。

**生效条件：需要重启 DSH Desktop。** 桌面端不支持运行时热加载新的 loader 行；重启后宿主按 patch 加载 `dsh-fullscreen` 这一行，读到包里的 `dsh.client` 声明，才会把 `lib/client.js` 送进页面。

## 卸载

```powershell
pwsh -File E:\dsh\dsh-plugins\dsh-fullscreen\uninstall.ps1
```

或手动：删掉 `<profile>\node_modules\dsh-fullscreen`，并从 `cordis.patch.yml` 的 insert 列表里删掉 `- id: dsh-fullscreen` / `name: dsh-fullscreen` 两行。

## 结构

```
src/client.js     浏览器半区源码（脚本体，不能写 export）
build-client.mjs  把 src/client.js 包进 __ModuleLoader__.load({id, factory}) → lib/client.js
lib/client.js     产物，被 DSH 页面按 /plugins/<id>/client.js 加载
lib/index.js      宿主半区空壳（存在的唯一理由是让 loader 条目出现，
                  ClientModuleRegistry 只扫描已加载条目去发现 dsh.client）
verify/           三套验证脚本（见下）
```

`package.json` 的清单与同样在本机可用的 `dsh-boot-animation` 保持一致：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
```

`client` 里**故意不写 `inject`**：浏览器半区不需要任何服务。写了一个本机不存在的必需服务，fiber 会一直 PENDING，`apply` 永远不会被调用——这正是 `dsh-boot-animation` 的做法。

## 验证

```powershell
node build-client.mjs              # 重新生成 lib/client.js
node verify\verify-client.mjs      # 38 项：用桩文档跑全部按键/记忆/恢复/降级分支
node verify\verify-real-page.mjs   # 12 项：真实 Edge + CDP + 受信任按键，真的进全屏
node verify\verify-install-scripts.mjs  # 安装器演练：install→install→uninstall→install，逐行比对 patch
```

`verify-real-page.mjs` 需要 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（或改脚本里的路径），并以 `--no-sandbox` 启动 headless Edge；结果写入 `verify\last-real-page-probe.json`。

## 边界

- 只在 Electron 桌面端（`dsh desktop`）有意义；在普通浏览器里 F11 是浏览器自己的全屏键。
- 不注册工具、不改提示词、不开路由、不碰宿主状态：宿主半区只有一行日志。
- 不做「启动时强制全屏」的独立开关——那需要窗口级控制（主进程），而本插件的通道在页面里。首次手动按一次 F11 之后，记忆会让后续启动/刷新自动回到全屏。
