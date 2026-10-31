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

## 功能开关

按 `Ctrl+G` 打开面板，切换到“设置”：

- **DeepSeek**：自动保存并立即生效；关闭时取消当前 AI 请求，保留 Key 和对话。
- **万能答题脚本**：自动保存，重启客户端后生效；关闭后不执行万能脚本入口。设置面板和复制粘贴增强仍可使用。
- 底部显示“未保存”时，点击该状态重试；确认保存成功后再重启。


## 本地 SQLite 题库

按 `Ctrl+G` → **题库**：

1. 启动客户端后自动在 `winmm.dll` 同目录生成并连接 `question-bank.db`，与保存 Key 的 `config.json` 放在一起。固定使用此文件，无需手动连接。
2. 点击“导入题库”，选择 Word（`.docx`）或 UTF-8 JSON；JSON 可直接导入 [五种题型示例](examples/question-bank.json)。每次最多 8 MiB、10000 道题。
3. 输入题干关键词后点击“查询题库”；留空显示最近导入的题目。每次最多显示 50 条，展开可查看选项、答案和解析。

如果旧版本的 `%LOCALAPPDATA%\cef_ex_copy_tool\question-bank.db` 已有数据，且 DLL 目录尚无默认题库，首次启动会通过 SQLite 备份接口迁移一份到新位置；旧文件保留，不覆盖已有的新默认题库。不再读取或写入旧的题库连接配置；以前选择的其他数据库不会自动打开，原文件保持不变。DLL 目录不可写时，题库页显示创建失败原因。

SQLite 静态内嵌在 DLL 中，不需要安装数据库服务或额外分发 sqlite3.dll。题库操作独立于 DeepSeek 和万能脚本开关，不会调用 AI API；已接入现有逐题答题流程，支持题库匹配与填写。原生入口沿用客户端 HTTPS 超星及 `.edu.cn` 页面范围，仅主框架可访问。

JSON 顶层包含 `schemaVersion: 1`、`name` 和 `questions`。每题的 `type` 支持 `single`、`multiple`、`boolean`、`blank`、`text`；题干用 `stem`，答案用 `answer`。选择题 `options` 为 `{id,text}` 数组，答案为选项 ID 数组；判断题答案为布尔值；填空题为每空可接受答案的二维数组；简答题为文本。可附加 `id`、`explanation`、`source` 和字符串数组 `tags`。Word 支持“题号.【题型】题干、A.选项、答案：、答案解析：”格式，可解析重复题型标签、多段答案与编号填空答案，题库名采用文件名。文档里的嵌入 PNG/JPEG/GIF/WebP 会保存到 SQLite，并在查询结果中显示；带图题先按题干获取候选；页面只有图片、没有文字题干时按题型查找候选，再用图片和完整选项确认，再结合完整选项、图片数量、宽高比与归一化像素比对；相同图片的等比缩放和轻微压缩可匹配，裁剪、水印或内容变化可能导致跳过。不会仅凭文字相同就填写图片题；答案本身为图片时暂不自动填入。填空的空数与答案组数不一致时保留原答案并显示核对提示，自动填写仍检查空数。不支持旧版 `.doc` 或 Excel；其他 SQLite 表结构需先转换为 JSON。

同题库名和同题目 ID 的相同内容跳过；ID 缺省时按题型、题干和选项的完整内容匹配。遇到不同内容保留原题，并将新内容存入数据库 `conflicts` 表，面板显示冲突数量；暂未提供冲突编辑界面。任一题格式错误或操作取消会回滚整批导入。数据库文件使用 `application_id=0x43585142`、`user_version=1` 识别，拒绝不兼容结构，防止误改其他数据库。

### 题库答题

导入题库后，在“题库答题”中选择模式，再点击“开始题库答题”。超星答题页面沿用现有逐题流程，进度显示在“答题”页：

- **仅本地题库**：不需要 API Key，不调用 AI；题库未命中或题图不一致时跳过。
- **题库优先，未命中再用 DeepSeek**：本地命中直接填写；未命中或题图未匹配时，仅在 DeepSeek 已开启且配置 Key 时调用 AI，可能产生 API 费用。数据库故障、答案冲突不会自动回退。
- **关闭题库答题**：恢复原先的 AI / 万能脚本行为。该开关与 DeepSeek 开关独立。

匹配要求题型与题干一致，仅归一化空白；页面带有明确题型标题时会去掉该标题后再匹配。选择题还要求完整选项集合一致，按选项内容映射当前页面的字母；重复选项、冲突记录和多个不同答案不会自动填写。填空题要求空数相同，每空使用题库中第一个可接受答案。查询目录中默认题库的所有题库分类。

沿用现有暂停/继续、逐题间隔、覆盖策略和失败题重试；“仅本地题库”未命中的题目也可在补充导入后重试。进度会标记“本地题库 · 题库名”或“题库未命中 → DeepSeek”。配置字段 `bankAnswerMode` 可为 `off`（默认）、`only`、`first`。开启模式后会启动当前页面的自动处理，导入新数据会清除旧查询状态。题库匹配不会自动提交整份试卷。

备份题库前退出客户端，再复制 `.db` 文件。题库数据与 API Key 配置分开保存。

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
├── config.json      # 面板保存时生成；包含明文 API Key，请勿上传或分享
└── question-bank.db # 启动时自动生成的默认 SQLite 题库
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

判断题匹配忽略末尾括号中明确标注的“对/错”等答案或空括号，不改变数据库中的原始题干。空字符串可用于纯图片题的题干与候选查询，不视为编码错误。
