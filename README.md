# cef_cx_copy_tool

[![Windows x86 build](https://github.com/tangqingfeng7/cef_ex_copy_tool/actions/workflows/build.yml/badge.svg)](https://github.com/tangqingfeng7/cef_ex_copy_tool/actions/workflows/build.yml)

基于 CEF Hook 的 Windows 客户端扩展，用于恢复页面文字选择、复制粘贴，并提供内置用户脚本加载能力。本项目基于 [SJYssr/CxExam_automatic_answering](https://github.com/SJYssr/CxExam_automatic_answering) 修改。

当前构建目标为 **Windows 8 及以上 / x86（32 位）**，输出文件为 `winmm.dll`。仅支持与当前 Hook 接口兼容的 CEF 客户端，不保证适用于所有客户端版本。

## 功能

- 恢复页面文字选择、复制、剪切和粘贴，支持 `Ctrl+V`、`Shift+Insert`。
- 处理普通输入框、富文本编辑区和 iframe；页面重建后重新安装事件监听器。
- 鼠标操作时隐藏焦点 outline，避免题目或控件出现额外蓝框；按 `Tab` 导航时恢复焦点提示。保留正常输入框边框和文字选中高亮。
- 保留只读、禁用字段状态，以及按钮、复选框等控件的正常交互。
- 提供截图、窗口置顶和窗口切换相关的 Hook。
- 使用 `Ctrl+Shift+P` 打开开发者工具。
- `gm_shim.js` 与转译后的 `dat.js` 以 LZMS 压缩的 RCDATA 资源内置于 DLL；不读取客户端目录中的外置 JS，更新脚本必须重新编译。
- `Ctrl+G` 打开 DeepSeek 面板；自动答题严格按“请求一题、立即填一题、再处理下一题”的顺序运行。
- 面板包含带上下文的 AI 对话；在对话输入框按 `Ctrl+V` 可直接粘贴剪贴板图片。题目附图由页面自动采集，不再提供单独的“附图”按钮。
- 面板“保存”会把 AI 设置写入 `winmm.dll` 同目录的 `config.json`，客户端重启后继续加载，无需重复输入 Key。

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

CMake 会先检查内容缓存，必要时执行 Babel，生成配套的 `out/js/gm_shim.js` 和 `out/js/dat.js`，再编入 DLL。两者只是构建中间产物，无需部署；旧外置 JS 不会被此版本读取。

`manifest.json` 是发布包的校验清单，记录 DLL 版本、源码指纹、Git 提交号、未提交修改标记、脚本构建标识、内嵌资源及 DLL 的 SHA-256。可用它核对发布文件的完整性，客户端运行不需要读取它。`winmm.pdb` 是调试符号，留在开发机并与对应 DLL 一起归档即可。

## DeepSeek 设置与对话

按 `Ctrl+G` 打开面板，填写 Key 后点击“保存”。DLL 通过受限的本地资源通道原子写入同目录 `config.json`；配置不会写入网页 `localStorage`。Key 在文件中为明文，部署和备份时自行保护，不要提交到 Git。

自动答题不会一次性并发整页请求：上一题取得答案并写入页面后，才会请求下一题。若题库用“简答题”容器包装正文中的 `[填空题]`，正文标记优先按填空题解析。

切换到“对话”页可连续追问，最近上下文会随下一次请求发送。把截图复制到剪贴板后，直接在对话输入框按 `Ctrl+V` 即可加入图片；图片可在发送前移除。“清空对话”只清理当前页面的对话上下文，不删除已保存的 Key。

## 构建环境

| 依赖 | 用途与要求 |
| --- | --- |
| Visual Studio 2022 Build Tools | 安装 C++ 编译工具、Windows SDK 和 CMake；构建脚本默认路径为 `D:\Admin\VSBuildTools` |
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

构建脚本会依次检查显式参数、`VSINSTALLDIR`、`D:\Admin\VSBuildTools` 和 Visual Studio Installer。工具链安装在其他位置且无法自动发现时，传入实际路径：

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-dll.ps1 -BuildToolsPath 'D:\YourTools\VSBuildTools'
```

构建脚本只生成项目内的产物。项目不提供一键部署或自动复制到客户端的功能。

### 单独检查脚本转译（不会更新 DLL）

```powershell
npm run build --prefix tools/transpile
```

构建器从 `scripts/dat.js` 提取用户脚本元数据，将代码转译后生成：

```text
out/js/dat.js
out/js/gm_shim.js
out/js/metadata.json
```

这些文件供资源编译器和打包校验读取，不需要放进客户端。正式构建 DLL 时会自动执行此转译步骤。

## 测试与打包

推荐在发布前执行统一验证：

```powershell
powershell -ExecutionPolicy Bypass -File tools/test.ps1
npm run package --prefix tools/transpile
```

统一验证会重新编译 DLL、运行原生回调与隔离崩溃转储测试、构建 JavaScript，并检查源码指纹、诊断状态、脚本配对与初始化、jQuery 隔离、页面重建、控件交互和浏览器粘贴行为。浏览器测试还会从 DLL 中提取内置脚本，确认其与源码一致。测试使用本地页面与临时目录，不操作考试页面或客户端安装目录。

测试脚本同样支持 `-BuildToolsPath` 参数。若 DLL 已经编译且只需检查 JavaScript，可运行 `npm test --prefix tools/transpile`；该命令不会重新编译 DLL。

打包输出到 `out/release/<时间与随机后缀>/`：

```text
发布目录/
├── winmm.dll
├── config.example.json
├── README.txt
├── LICENSE
├── manifest.json
├── archives.json
├── cef_ex_copy_tool-v<版本>-x86-<提交号>[-dirty].zip
├── cef_ex_copy_tool-v<版本>-x86-<提交号>[-dirty]-symbols.zip
└── symbols/
    ├── winmm.pdb
    ├── symbols.json
    └── README.txt
```

**打包会重新构建 JavaScript，并生成运行 ZIP 与独立的调试符号 ZIP；使用现有 DLL，不会编译 DLL 或部署到客户端。** 修改 DLL 源码或内置脚本后，必须先重新编译或运行统一验证。

运行 ZIP 包含运行文件 `winmm.dll`、可选配置模板 `config.example.json`、使用说明、许可证与校验清单；符号 ZIP 包含 `winmm.pdb`、符号清单和调试说明。打包会校验 PDB 的 GUID、age 与 DLL 是否匹配，缺少或不匹配时停止。`archives.json` 记录两个 ZIP 的 SHA-256；生成后还会解压读取各条目，核对文件哈希。全部检查成功才生成正式发布目录，失败中间产物保留在 `.partial-*` 目录。

统一测试也包含实际打包与 ZIP 内容校验，因此测试通过后会留下一个可用发布目录。

### GitHub Actions 自动构建

`.github/workflows/build.yml` 在每次 push、Pull Request、版本标签和手动触发时运行。Windows Runner 会按照 `vcpkg-configuration.json` 的 baseline 安装 x86 Detours，使用锁文件执行 `npm ci`，然后运行与本地相同的 `tools/test.ps1` 完整验证。

验证通过后，Actions 分别上传运行 ZIP 和与其匹配的符号 ZIP，并附带 `archives.json`。版本标签必须与 `VERSION` 完全一致，例如 `VERSION` 为 `1.0.0` 时只能使用 `v1.0.0`；不匹配会在编译前停止。自动构建只生成 GitHub Actions 工件，不创建 GitHub Release，也不会部署到客户端。工件默认保留 30 天，失败日志保留 7 天。

vcpkg 二进制缓存与 npm 缓存会在后续运行复用。Dependabot 每周检查 GitHub Actions 主版本更新。

打包前会读取 DLL 内嵌的构建记录，与当前源码指纹、`VERSION`、Git 提交号及 `x86/Release` 配置比较。不匹配、缺少构建记录时会报错并停止，不会生成发布目录。源码指纹覆盖 `src/`、`cef/`、`chromium/`、内置脚本和相关构建文件，包含尚未提交的源码内容，不依赖文件修改时间。

更新 `dat.js` 或 `gm_shim.js` 也需要重新编译 DLL；提交产生新的 Git 提交号后，需要重新编译再打包。未提交修改允许打包，但会明确记录 `dirty: true`。源码压缩包没有 Git 信息时，提交号显示为 `null`，仍检查源码指纹。该检查用于识别版本混用，不是数字签名。

## 手动安装与回滚

1. 完全退出客户端。
2. 手动备份客户端目录中原有的同名文件，并记录哪些文件原来不存在。
3. 复制编译生成的 `winmm.dll` 到 `CXExam.exe` 所在目录。
4. 无需复制 `gm_shim.js`、`dat.js`；本 DLL 不读取这些外置文件。
5. 重新启动客户端。

回退时先退出客户端，再手动恢复备份；本次新增、原来不存在的文件应移出客户端目录。构建、测试和打包均不会替你修改客户端文件。

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
