# cef_cx_copy_tool

[![Windows x86 build](https://github.com/tangqingfeng7/cef_ex_copy_tool/actions/workflows/build.yml/badge.svg)](https://github.com/tangqingfeng7/cef_ex_copy_tool/actions/workflows/build.yml)

基于 CEF Hook 的 Windows 客户端扩展，用于恢复页面文字选择、复制粘贴，并提供内置用户脚本加载能力。本项目基于 [SJYssr/CxExam_automatic_answering](https://github.com/SJYssr/CxExam_automatic_answering) 修改。


## 功能

- 恢复页面文字选择、复制、剪切和粘贴，支持 `Ctrl+V`、`Shift+Insert`。
- 处理普通输入框、富文本编辑区和 iframe；页面重建后重新安装事件监听器。
- 鼠标操作时隐藏焦点 outline，避免题目或控件出现额外蓝框；按 `Tab` 导航时恢复焦点提示。保留正常输入框边框和文字选中高亮。
- 保留只读、禁用字段状态，以及按钮、复选框等控件的正常交互。
- 提供截图、窗口置顶和窗口切换相关的 Hook。
- 内置用户脚本加载器，支持 `GM_xmlhttpRequest`、`GM_setValue`、`GM_getValue`、`GM_deleteValue`、`GM_listValues` 等 API。
- 内置DeepSeekAI
- 使用 `Ctrl+Shift+P` 打开开发者工具。

## 客户端需要哪些文件

将文件放在 **`CXExam.exe` 所在目录**，更新前完全退出客户端，保留旧文件备份，更新后重新启动。

| 使用方式 | 需要的文件 |
| --- | --- |
| 使用内置功能及用户脚本 | `winmm.dll` |
| 持久化 DeepSeek 设置 | 面板保存后自动生成的 `config.json`（可选） |

完整部署后的目录示例：

```text
客户端目录/
├── CXExam.exe
├── winmm.dll        # 已包含 gm_shim.js 和 dat.js
└── config.json      # 面板保存时生成；包含明文 API Key，请勿上传或分享
```

## 构建环境

| 依赖 | 用途与要求 |
| --- | --- |
| Visual Studio 2022 Build Tools | 安装 C++ 编译工具、Windows SDK 和 CMake；安装路径不限，构建脚本会自动查找，也可通过 `-BuildToolsPath` 指定 |
| Detours | 使用 `x86-windows` 版本，必须包含头文件及 `lib/detours.lib` |
| Node.js / npm | DLL 构建时生成版本与源码指纹，以及转译内嵌脚本、执行测试和打包；需可从终端调用 |
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

构建脚本会依次检查显式参数 `-BuildToolsPath`、环境变量 `VSINSTALLDIR` 和 Visual Studio Installer 提供的 `vswhere.exe` 检测结果，无需安装到固定目录。无法自动发现时，传入本机的实际安装路径（下面的路径仅为示例）：

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-dll.ps1 -BuildToolsPath 'D:\YourTools\VSBuildTools'
```

构建脚本只生成项目内的产物。项目不提供一键部署或自动复制到客户端的功能。


## 手动安装

1. 完全退出客户端。
2. 手动备份客户端目录中原有的同名文件，并记录哪些文件原来不存在。
3. 复制编译生成的 `winmm.dll` 到 `CXExam.exe` 所在目录。
4. 无需复制 `gm_shim.js`、`dat.js`；本 DLL 不读取这些外置文件。
5. 重新启动客户端。


## 修改后需要重新生成什么

| 修改内容 | 操作 | 更新客户端文件 |
| --- | --- | --- |
| `src/` 下的 DLL 源码 | 重新编译 DLL | `winmm.dll` |
| `scripts/clipboard_fix.js` | 重新编译 DLL，脚本内置于二进制 | `winmm.dll` |
| `scripts/userscript_boot.js` | 重新编译 DLL，脚本内置于二进制 | `winmm.dll` |
| `scripts/diagnostics.js` 或 `VERSION` | 重新编译 DLL | `winmm.dll` |
| `scripts/dat.js` 或 `scripts/gm_shim.js` | 重新编译 DLL（自动转译并内嵌） | `winmm.dll` |

内置主脚本的构建入口是 `scripts/dat.js`。当前脚本中的 jQuery 使用局部 `$` / `jQuery`，通过 `noConflict(true)` 保留宿主页面的库和插件。更新上游脚本时应保留这项适配并运行回归测试，否则可能出现“进入考试”按钮无响应等问题。

更新脚本后执行 DLL 构建命令，再手动替换 DLL。构建将一对具有相同标识的脚本一起内嵌；打包会逐字节核对 DLL 资源与转译产物，不匹配时拒绝打包。

编译期开关位于 `src/thread.cpp`，修改后需要重新编译：

| 开关 | 默认值 | 作用 |
| --- | --- | --- |
| `ENABLE_UNBLOCK_SWITCH` | `1` | 窗口切换与置顶相关处理 |
| `ENABLE_USERSCRIPT` | `1` | 从本 DLL 资源加载内置用户脚本 |
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
| `native.host` | 宿主进程名、PID 与 DLL 架构 |
| `native.lifecycle` | 工作线程的 `starting/running/stopping/stopped/failed` 状态、停止请求和 Win32 错误码 |
| `native.hooks` | Detours 事务状态、失败阶段及错误码 |
| `native.crashDump` | 崩溃转储处理器状态、保存目录及最近错误码 |
| `clipboard` | 当前文档的粘贴补丁安装状态 |
| `userscript` | 脚本版本、配套构建标识、加载状态、阶段、尝试次数、原因和 `failedFile`（失败文件） |

脚本状态包括 `idle`、`loading`、`ready`、`failed`、`skipped` 和 `disabled`。读取、解码、解析失败分别显示 `read`、`decode`、`eval` 阶段，并保留失败文件；初始化和入口执行分别使用 `boot`、`run` 阶段。子框架跳过、编译时禁用也会给出原因。`ready` 仅表示脚本入口完成，不表示所有后续网络请求成功。普通主页面尚未执行加载回调时可显示 `idle`。

同一次注入保留第一个读取/解析失败，不会被后续初始化或旧的异步任务覆盖；运行时脚本解析失败时不执行主脚本。页面后续发起新的加载尝试后才清除该次错误。已经处于 `loading` 或 `ready` 的脚本不会重复执行。

内置脚本从当前模块的 RCDATA 资源读取，校验 16 MiB 解压上限、实际长度及 SHA-256，解压后严格按 UTF-8 解码，缓存编码和包装结果，仍使用原有分片注入。资源缺失或编码非法时报告 `embedded-resource-missing-or-invalid`。不写出临时 JS 文件、不检查外置脚本，也不支持磁盘热更新。

DLL 版本由根目录 `VERSION` 管理，文件属性的“详细信息”中也可查看。原生调试输出使用 `[CefHook]` 前缀，包含构建记录和运行时版本；诊断快照不包含页面 URL、答题内容或剪贴板正文。未提交源码通过指纹区分，不能只凭 Git 提交号判断两个 DLL 完全相同。

## 崩溃转储

工作线程启动时安装未处理异常过滤器，并保留、调用客户端当时已有的过滤器。发生未处理异常时最多写入一份带 DLL 版本、进程号和时间的 MiniDump：

```text
%LOCALAPPDATA%\cef_ex_copy_tool\crash-dumps\cef_ex_copy_tool-v1.1.0-pid<进程号>-<时间>.dmp
```

可在启动客户端前通过环境变量 `CEF_CX_DUMP_DIR` 指定其他本地目录。转储不会自动上传，也不会写入客户端安装目录。MiniDump 可能包含线程栈和部分进程内存；提供给他人分析前应按本地数据处理，并同时保留同次构建的符号 ZIP。

## 常见问题

**替换脚本后，粘贴或蓝框行为没有改变？**

这两部分由 DLL 内置的 `scripts/clipboard_fix.js` 控制。需要重新编译并替换 `winmm.dll`，仅更新 `dat.js` 不会生效。鼠标焦点 outline、输入框本身的边框和文字选中高亮是不同的样式，当前修复只隐藏鼠标操作产生的焦点 outline。

**内置用户脚本无法初始化或请求失败？**

先确认已替换为本次构建的 DLL，并查看内置脚本的诊断状态。固定 Table 字典和图片已内置，无需 CDN；题库/API 仍需要网络；当前 `GM_xmlhttpRequest` 使用 fetch 直连，受目标服务的 CORS 限制。它不是完整的浏览器扩展环境。

**进入页面后出现异常或客户端崩溃？**

退出客户端后恢复备份。排查用户脚本时，将 `ENABLE_USERSCRIPT` 改为 `0` 后重新编译验证；移走外置 JS 不会影响此版本。到 `%LOCALAPPDATA%\cef_ex_copy_tool\crash-dumps` 查找对应 `.dmp`，并保留发生问题的 DLL、同次构建的符号 ZIP，避免混用不同构建的符号文件。当前不支持运行期间强制卸载 DLL。

**为什么某些输入框仍不能粘贴？**

只读和禁用字段保持原状。普通输入框、富文本编辑器及不同版本 CEF 的行为也可能不同。诊断输出使用 `[CefHook]` 前缀，记录安装状态、目标类型及插入结果，不记录剪贴板正文。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/` | DLL 源码、CEF 回调与 Hook |
| `scripts/` | 内置补丁和用户脚本源码 |
| `tools/` | 构建、测试与打包工具 |
| `tests/` | 原生与 JavaScript 回归测试 |
| `cef/`、`chromium/` | 编译使用的第三方源码与头文件 |
| `out/` | DLL、转译脚本及发布产物 |


## 致谢与许可证

原始项目：[kazutoiris/cef-hook](https://github.com/kazutoiris/cef-hook)。

项目许可证见 [LICENSE](LICENSE)（GPL-3.0）；第三方代码遵循各自许可证。
