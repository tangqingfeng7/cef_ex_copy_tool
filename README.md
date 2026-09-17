# cef_cx_copy_tool

基于 CEF Hook 的 Windows 客户端扩展，用于恢复页面文字选择、复制粘贴，并提供可选的外部用户脚本加载能力。项目修改自 [kazutoiris/cef-hook](https://github.com/kazutoiris/cef-hook)。

当前构建目标为 **Windows x86（32 位）**，输出文件为 `winmm.dll`。仅支持与当前 Hook 接口兼容的 CEF 客户端，不保证适用于所有客户端版本。

## 功能

- 恢复页面文字选择、复制、剪切和粘贴，支持 `Ctrl+V`、`Shift+Insert`。
- 处理普通输入框、富文本编辑区和 iframe；页面重建后重新安装事件监听器。
- 鼠标操作时隐藏焦点 outline，避免题目或控件出现额外蓝框；按 `Tab` 导航时恢复焦点提示。保留正常输入框边框和文字选中高亮。
- 保留只读、禁用字段状态，以及按钮、复选框等控件的正常交互。
- 提供截图、窗口置顶和窗口切换相关的 Hook。
- 使用 `Ctrl+Shift+P` 打开开发者工具。
- 可选加载 `gm_shim.js` 和 `dat.js`，更新外部脚本无需重新编译 DLL。

## 客户端需要哪些文件

将文件放在 **`CXExam.exe` 所在目录**，更新前完全退出客户端，保留旧文件备份，更新后重新启动。

| 使用方式 | 需要的文件 |
| --- | --- |
| 只使用 DLL 内置功能，包括复制粘贴修复 | `winmm.dll` |
| 同时加载外部用户脚本 | `winmm.dll`、`gm_shim.js`、`dat.js` |

完整部署后的目录示例：

```text
客户端目录/
├── CXExam.exe
├── winmm.dll
├── gm_shim.js       # 可选，与 dat.js 配套
└── dat.js           # 可选，与 gm_shim.js 配套
```

外部脚本请使用构建生成的 `out/js/gm_shim.js` 和 `out/js/dat.js`，不要直接复制 `scripts/` 下的源码，也不要混用不同次构建的两个文件。

`manifest.json` 是发布包的校验清单，记录 DLL 版本、源码指纹、Git 提交号、未提交修改标记、脚本构建标识和三个文件的 SHA-256。可用它核对发布文件的完整性，客户端运行不需要读取它。`winmm.pdb` 是调试符号，留在开发机并与对应 DLL 一起归档即可。

## 构建环境

| 依赖 | 用途与要求 |
| --- | --- |
| Visual Studio 2022 Build Tools | 安装 C++ 编译工具、Windows SDK 和 CMake；构建脚本默认路径为 `D:\Admin\VSBuildTools` |
| Detours | 使用 `x86-windows` 版本，必须包含头文件及 `lib/detours.lib` |
| Node.js / npm | DLL 构建时生成版本与源码指纹，以及构建外部脚本、执行测试和打包；需可从终端调用 |
| Microsoft Edge | 浏览器回归测试使用本机 Edge，无需另行下载 Playwright 浏览器 |

DLL 构建脚本依次在以下位置查找 Detours，不会自动安装依赖：

```text
vcpkg_installed/x86-windows/
out/build/x86-Release/vcpkg_installed/x86-windows/
```

项目通过 [vcpkg.json](vcpkg.json) 声明 Detours 依赖。新环境应先准备 x86 依赖，不能仅复制源码后直接假定可以编译。

以下命令均在项目根目录执行。

### 安装 JavaScript 依赖

```powershell
npm ci --prefix tools/transpile
```

### 编译 DLL

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-dll.ps1
```

输出文件：

```text
out/build/x86-integrated/src/Release/winmm.dll
out/build/x86-integrated/src/Release/winmm.pdb
```

工具链安装在其他位置时，传入实际路径：

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-dll.ps1 -BuildToolsPath 'D:\YourTools\VSBuildTools'
```

构建脚本只生成项目内的产物。项目不提供一键部署或自动复制到客户端的功能。

### 构建外部脚本

```powershell
npm run build --prefix tools/transpile
```

构建器从 `scripts/dat.js` 提取用户脚本元数据，将代码转译后生成：

```text
out/js/dat.js
out/js/gm_shim.js
out/js/metadata.json
```

`metadata.json` 供打包工具读取，不需要放进客户端。

## 测试与打包

推荐在发布前执行统一验证：

```powershell
powershell -ExecutionPolicy Bypass -File tools/test.ps1
npm run package --prefix tools/transpile
```

统一验证会重新编译 DLL、运行原生回调测试、构建 JavaScript，并检查源码指纹、诊断状态、脚本配对与初始化、jQuery 隔离、页面重建、控件交互和浏览器粘贴行为。浏览器测试还会从 DLL 中提取内置脚本，确认其与源码一致。测试使用本地页面与临时目录，不操作考试页面或客户端安装目录。

测试脚本同样支持 `-BuildToolsPath` 参数。若 DLL 已经编译且只需检查 JavaScript，可运行 `npm test --prefix tools/transpile`；该命令不会重新编译 DLL。

打包输出到 `out/release/<时间与随机后缀>/`：

```text
发布目录/
├── winmm.dll
├── gm_shim.js
├── dat.js
└── manifest.json
```

**打包会重新构建 JavaScript，但使用现有 DLL，不会编译 DLL、生成 ZIP 或部署到客户端。** 修改 DLL 源码或内置脚本后，必须先重新编译或运行统一验证。

打包前会读取 DLL 内嵌的构建记录，与当前源码指纹、`VERSION`、Git 提交号及 `x86/Release` 配置比较。不匹配、缺少构建记录时会报错并停止，不会生成发布目录。源码指纹覆盖 `src/`、`cef/`、`chromium/`、内置脚本和相关构建文件，包含尚未提交的源码内容，不依赖文件修改时间。

只更新外部脚本不需要重新编译 DLL；提交产生新的 Git 提交号后，需要重新编译再打包。未提交修改允许打包，但会明确记录 `dirty: true`。源码压缩包没有 Git 信息时，提交号显示为 `null`，仍检查源码指纹。该检查用于识别版本混用，不是数字签名。

## 手动安装与回退

1. 完全退出客户端。
2. 手动备份客户端目录中原有的同名文件，并记录哪些文件原来不存在。
3. 仅使用内置功能时，复制编译生成的 `winmm.dll` 到 `CXExam.exe` 所在目录。
4. 需要外部用户脚本时，再复制同次构建的 `out/js/gm_shim.js` 和 `out/js/dat.js`，也可以直接从发布目录取这三个文件。
5. 重新启动客户端。

回退时先退出客户端，再手动恢复备份；本次新增、原来不存在的文件应移出客户端目录。构建、测试和打包均不会替你修改客户端文件。

## 修改后需要重新生成什么

| 修改内容 | 操作 | 更新客户端文件 |
| --- | --- | --- |
| `src/` 下的 DLL 源码 | 重新编译 DLL | `winmm.dll` |
| `scripts/clipboard_fix.js` | 重新编译 DLL，脚本内置于二进制 | `winmm.dll` |
| `scripts/userscript_boot.js` | 重新编译 DLL，脚本内置于二进制 | `winmm.dll` |
| `scripts/diagnostics.js` 或 `VERSION` | 重新编译 DLL | `winmm.dll` |
| `scripts/dat.js` 或 `scripts/gm_shim.js` | 重新构建 JavaScript | 配套的 `dat.js`、`gm_shim.js` |

外部主脚本的构建入口是 `scripts/dat.js`。当前脚本中的 jQuery 使用局部 `$` / `jQuery`，通过 `noConflict(true)` 保留宿主页面的库和插件。更新上游脚本时应保留这项适配并运行回归测试，否则可能出现“进入考试”按钮无响应等问题。

旧本地热更新服务和加载器已移除。更新外部脚本统一使用构建命令，再手动复制配套文件；新生成的两个文件具有相同构建标识，主脚本发现标识不匹配时会停止执行并报告 `script-pair-mismatch`。

编译期开关位于 `src/thread.cpp`，修改后需要重新编译：

| 开关 | 默认值 | 作用 |
| --- | --- | --- |
| `ENABLE_UNBLOCK_SWITCH` | `1` | 窗口切换与置顶相关处理 |
| `ENABLE_USERSCRIPT` | `1` | 加载客户端目录中的外部脚本 |
| `ENABLE_MEMORY_PATCH` | `0` | 针对特定版本的固定地址补丁，默认关闭 |

## 查看版本与诊断信息

在客户端按 `Ctrl+Shift+P` 打开开发者工具，进入 Console，输入：

```javascript
__cefGetDiagnostics()
```

返回当前页面的诊断快照，不在页面上添加浮窗：

| 字段 | 含义 |
| --- | --- |
| `dll` | DLL 版本、Git 提交号、构建时的 `dirty` 标记、源码指纹和构建配置 |
| `runtime` | 实际加载的 CEF 三段版本和 Chromium 四段版本；版本接口不可用时显示 `unknown` |
| `clipboard` | 当前文档的粘贴补丁安装状态 |
| `userscript` | 脚本版本、配套构建标识、加载状态、阶段、尝试次数和失败/跳过原因 |

脚本状态包括 `idle`、`loading`、`ready`、`failed`、`skipped` 和 `disabled`。缺失文件、子框架跳过、编译时禁用会分别给出原因；`ready` 仅表示脚本入口完成，不表示所有后续网络请求成功。普通主页面尚未执行加载回调时可显示 `idle`。

DLL 版本由根目录 `VERSION` 管理，文件属性的“详细信息”中也可查看。原生调试输出使用 `[CefHook]` 前缀，包含构建记录和运行时版本；诊断快照不包含页面 URL、答题内容或剪贴板正文。未提交源码通过指纹区分，不能只凭 Git 提交号判断两个 DLL 完全相同。

## 常见问题

**替换脚本后，粘贴或蓝框行为没有改变？**

这两部分由 DLL 内置的 `scripts/clipboard_fix.js` 控制。需要重新编译并替换 `winmm.dll`，仅更新 `dat.js` 不会生效。鼠标焦点 outline、输入框本身的边框和文字选中高亮是不同的样式，当前修复只隐藏鼠标操作产生的焦点 outline。

**外部脚本无法初始化或请求失败？**

先确认使用同次构建的 `gm_shim.js` 和 `dat.js`。外部资源与接口仍可能需要网络；当前 `GM_xmlhttpRequest` 使用 fetch 直连，受目标服务的 CORS 限制。它不是完整的浏览器扩展环境。

**进入页面后出现异常或客户端崩溃？**

退出客户端后恢复备份。排查外部脚本时，可以暂时移出客户端目录中的两个 JS 文件，再启动验证。保留发生问题的 DLL、对应 PDB 和崩溃报告，避免混用不同构建的符号文件。当前不支持运行期间强制卸载 DLL。

**为什么某些输入框仍不能粘贴？**

只读和禁用字段保持原状。普通输入框、富文本编辑器及不同版本 CEF 的行为也可能不同。诊断输出使用 `[CefHook]` 前缀，记录安装状态、目标类型及插入结果，不记录剪贴板正文。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/` | DLL 源码、CEF 回调与 Hook |
| `scripts/` | 内置补丁和外部脚本源码 |
| `tools/` | 构建、测试与打包工具 |
| `tests/` | 原生与 JavaScript 回归测试 |
| `cef/`、`chromium/` | 编译使用的第三方源码与头文件 |
| `out/` | DLL、转译脚本及发布产物 |


## 致谢与许可证

原始项目：[kazutoiris/cef-hook](https://github.com/kazutoiris/cef-hook)。

项目许可证见 [LICENSE](LICENSE)（GPL-3.0）；第三方代码遵循各自许可证。
