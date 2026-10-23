const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildInfo, verifyDll } = require('../build-info.cjs');
const { readResource } = require('../embedded-resources.cjs');
const { decodeResource } = require('../resource-codec.cjs');
const ROOT = path.resolve(__dirname, '../..');
const FILES = ['winmm.dll'];
// Keep the packaged attribution even when the standalone source notice is removed.
const UPSTREAM_AI_NOTICE = "# Upstream AI source attribution\n\n`deepseek_ai_script.js` was copied and adapted from:\n\n- Project: SJYssr/CxExam_automatic_answering\n- URL: https://github.com/SJYssr/CxExam_automatic_answering\n- Commit: `3b534edae5208f1b3bdb256142491a6cd28de4a0`\n- Original file: `src/scripts/deepseek_ai_script.js`\n- License: GPL-3.0 (the root LICENSE is retained in source and release packages).\n\nRetained workflow: exam-page detection, page-load collection, Ctrl+C/copy-to-AI,\nclick-to-fill, middle-click batch fill, question types and DOM selectors.\n\nLocal adaptations: persistent DLL-adjacent config and Ctrl+G popup/opacity, bounded\nmultimodal vision requests using deepseek-flash, images from question/option DOM,\nstrict request-delay-fill-next sequential answering, pause/resume controls,\nbackup-clear-write-verify rich-editor replacement, contextual chat with clipboard-image\npaste, safe text insertion, stale-result checks, removal of destructive answer cleanup\nand private console logging. Missing/ambiguous multi-blank mapping is left for\nmanual review instead of copying one answer to every blank. The existing legacy\nworker yields to this AI flow on supported exam pages to avoid duplicate requests.\n";
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function runPowerShell(script, args) {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', script), ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
function runtimeReadme(build) {
    return `cef_ex_copy_tool ${build.version} (Windows x86)\n\n` +
        `Git: ${build.commit || 'unknown'}${build.dirty ? ' (包含未提交修改)' : ''}\n源码指纹: ${build.sourceHash}\n\n` +
        '本项目基于 https://github.com/SJYssr/CxExam_automatic_answering 修改。\n\n' +
        'AI 主流程直接移植自上游 src/scripts/deepseek_ai_script.js，固定提交 3b534edae5208f1b3bdb256142491a6cd28de4a0；保留GPL-3.0及来源说明。\n' +
        '支持的考试页面：开启AI后等待动态题目加载，自动取题（含题干/选项图片）并填入；中键用于手动重试。Ctrl+C取答案后点击空的编辑框/题目区域填入。不会自动提交。\n' +
        '安装：完全退出客户端，备份原有同名文件，再手动复制到 CXExam.exe 所在目录。\n' +
        '复制 winmm.dll 即可；gm_shim.js 和 dat.js 已作为资源内置，不读取外置 JS。\n' +
        '更新脚本需要重新编译 DLL；固定字典和图片已离线内置；题库/API 仍需要网络。资源采用 LZMS 压缩和 SHA-256 损坏校验，要求 Windows 8 及以上。\n' +
        'DeepSeek 图文：Ctrl+G 打开设置，填入 API Key 并启用；默认模型 deepseek-flash。默认关闭，不配置仍走原题库。\n' +
        '简约面板：输入 Key 后点保存；设置会写入 DLL 同目录 config.json，重启后继续加载。测试连接独立执行，不保存或启用AI，仍可能少量收费。\n' +
        '自动答题严格逐题请求并立即填入后再处理下一题；“对话”页保留上下文，输入框 Ctrl+V 可直接粘贴剪贴板图片。\n' +
        '面板支持右下角调尺寸并记忆位置/大小；Ctrl+D 选中文字后立即发送到对话，Ctrl+Shift+S 框选当前客户端截图（Esc取消）；截图只加入草稿。\n' +
        '对话保留可移除的附件缩略图，点击“发送”或 Enter 即发送，Shift+Enter 换行；聊天记录使用细滚动条。支持流式回复和停止生成，显示请求状态及接口实际报告的 token。停止不保证服务端停止计费。\n' +
        '官方 api.deepseek.com 请求通过 DLL 内受限同源原生通道发送，可避开考试页 connect-src CSP；不会关闭全局浏览器安全策略，也不代理任意地址。\n' +
        '连接正常只表示接口响应正常，不表示图片识别/答案正确；实际答题的选项范围与数量校验仍保留。\n' +
        'Ctrl+G 再次关闭；默认50%不透明度，面板内 Ctrl+滚轮以10%调整，右键20%/50%切换，标题栏可拖动，Esc隐藏。\n' +
        'Ctrl+R 暂停/继续答题；更多设置中的“快捷键设置”可自定义四个组合并保存，原生拦截同步生效。\n' +
        '这是页面内悬浮窗，不挡住其他页面区域；快捷键仅在客户端CEF获得焦点时生效，不是系统全局热键。\n' +
        '也可将 config.example.json 复制为 DLL 同目录的 config.json，填入 Key 并把 enabled 改为 true；此文件是明文，请保护好。\n' +
        '界面保存的 Key 不写网页 localStorage，会以明文写入本机 config.json，请勿上传或分享。图文会发送到配置的 API；请求可能收费。\n' +
        'ai-only 不回退题库，ai-first 失败时回退原题库；网络/限流/格式错误不自动重发 AI，需在设置中清除缓存重试。\n' +
        '题图由页面自动采集；跨域图片失败时不绕过 CORS/CSP，可刷新页面或在 AI 对话中粘贴截图咨询。\n' +
        '复制完成后重新启动客户端。本包不会自动安装或写入客户端。\n\n' +
        '诊断：Ctrl+Shift+P 打开开发者工具，在 Console 运行 __cefGetDiagnostics()。\n' +
        '崩溃转储：未处理异常会在 %LOCALAPPDATA%\\cef_ex_copy_tool\\crash-dumps 生成本地 .dmp；不会自动上传。\n' +
        '回退：退出客户端后恢复备份，移走本次新增而原来不存在的文件。\n' +
        'manifest.json 记录版本及文件 SHA-256；调试符号位于单独的 symbols.zip 包，不需要安装。\n\n' +
        '源码与说明：https://github.com/tangqingfeng7/cef_ex_copy_tool\n许可证：见 LICENSE。\n';
}
function makeRelease() {
    const example = fs.readFileSync(path.join(ROOT, 'config.example.json'));
    const exampleConfig = JSON.parse(example);
    if (exampleConfig.apiKey !== '' || exampleConfig.enabled !== false)
        throw new Error('Refusing to publish credentials or an enabled config template');
    const dllPath = path.join(ROOT, 'out/build/x86-integrated/src/Release/winmm.dll');
    // Check before creating any release directory or rebuilding external scripts.
    const dll = fs.readFileSync(dllPath);
    const current = buildInfo(ROOT);
    const dllBuild = verifyDll(dll, current);
    const pdb = fs.readFileSync(path.join(path.dirname(dllPath), 'winmm.pdb'));
    execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
    const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/js/metadata.json')));
    const embeddedScripts = {};
    for (const [name, id] of [['gm_shim.js', 201], ['dat.js', 202]]) {
        const source = fs.readFileSync(path.join(ROOT, 'out/js', name));
        const stored = readResource(dll, 10, id);
        const resource = decodeResource(stored);
        if (!resource.equals(source)) throw new Error('Stale embedded script: ' + name + '; rebuild DLL');
        embeddedScripts[name] = { resourceId: id, bytes: source.length, storedBytes: stored.length,
            storage: 'CXZ1/LZMS', sha256: sha256(source) };
    }
    const contents = [dll];
    const after = buildInfo(ROOT);
    verifyDll(dll, after);
    if (current.commit !== metadata.build.commit || current.dirty !== after.dirty)
        throw new Error('Sources changed during packaging; retry after finishing edits');
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    const dir = path.join(ROOT, 'out/release', id);
    const stage = path.join(ROOT, 'out/release', '.partial-' + id);
    const symbolDir = path.join(stage, 'symbols');
    const baseName = 'cef_ex_copy_tool-v' + dllBuild.version + '-x86-' +
        (dllBuild.commit ? dllBuild.commit.slice(0, 8) : 'unknown') + (after.dirty ? '-dirty' : '');
    fs.mkdirSync(symbolDir, { recursive: true });
    // Validate the private byte snapshots, not paths that a concurrent build could replace.
    fs.writeFileSync(path.join(stage, 'winmm.dll'), dll);
    fs.writeFileSync(path.join(symbolDir, 'winmm.pdb'), pdb);
    const signature = runPowerShell('check-symbols.ps1', ['-DllPath', path.join(stage, 'winmm.dll'),
        '-PdbPath', path.join(symbolDir, 'winmm.pdb')]);
    const manifest = { schema: 4, scriptMode: 'embedded', embeddedScripts, scriptVersion: metadata.script.version,
        dllBuild, scriptBuild: metadata.build, git: { commit: after.commit, dirty: after.dirty },
        symbols: { archive: baseName + '-symbols.zip', ...signature, pdbSha256: sha256(pdb) },
        createdAt: new Date().toISOString(), files: {} };
    FILES.forEach((name, i) => {
        fs.writeFileSync(path.join(stage, name), contents[i]);
        manifest.files[name] = sha256(contents[i]);
    });
    const readme = Buffer.from(runtimeReadme(dllBuild), 'utf8');
    const license = fs.readFileSync(path.join(ROOT, 'LICENSE'));
    for (const [name, bytes] of [['README.txt', readme], ['LICENSE', license], ['config.example.json', example],
        ['UPSTREAM_AI_NOTICE.md', Buffer.from(UPSTREAM_AI_NOTICE, 'utf8')]]) {
        fs.writeFileSync(path.join(stage, name), bytes);
        manifest.files[name] = sha256(bytes);
    }
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(symbolDir, 'symbols.json'), JSON.stringify({ schema: 1, dllBuild,
        dllSha256: sha256(dll), pdbSha256: sha256(pdb), ...signature }, null, 2));
    fs.writeFileSync(path.join(symbolDir, 'README.txt'),
        '调试符号包，不需要复制到客户端。\n保留 winmm.pdb 与对应运行包一起归档。\n' +
        'symbols.json 记录 DLL/PDB 的 SHA-256、GUID 和 age，用于核对构建。\n' +
        '分析崩溃时将调试器的符号路径指向本包解压目录。\n', 'utf8');
    const archives = {};
    for (const [source, name, files] of [
        [stage, baseName + '.zip', [...FILES, 'README.txt', 'LICENSE', 'config.example.json', 'UPSTREAM_AI_NOTICE.md', 'manifest.json']],
        [symbolDir, baseName + '-symbols.zip', ['winmm.pdb', 'symbols.json', 'README.txt']]]) {
        const zip = path.join(stage, name);
        runPowerShell('zip-release.ps1', ['-SourceDir', source, '-ArchivePath', zip, '-FilesJson', JSON.stringify(files)]);
        archives[name] = sha256(fs.readFileSync(zip));
    }
    fs.writeFileSync(path.join(stage, 'archives.json'), JSON.stringify({ schema: 1, archives }, null, 2));
    verifyDll(dll, buildInfo(ROOT));
    // Only complete, verified archives appear as a finished release directory.
    fs.renameSync(stage, dir);
    return dir;
}
module.exports = { makeRelease, FILES, sha256, runPowerShell };
if (require.main === module) console.log('[release] ' + makeRelease());
