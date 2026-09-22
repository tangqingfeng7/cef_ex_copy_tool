const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildInfo, verifyDll } = require('../build-info.cjs');
const ROOT = path.resolve(__dirname, '../..');
const FILES = ['winmm.dll', 'gm_shim.js', 'dat.js'];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function runPowerShell(script, args) {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', script), ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
function runtimeReadme(build) {
    return `cef_ex_copy_tool ${build.version} (Windows x86)\n\n` +
        `Git: ${build.commit || 'unknown'}${build.dirty ? ' (包含未提交修改)' : ''}\n源码指纹: ${build.sourceHash}\n\n` +
        '安装：完全退出客户端，备份原有同名文件，再手动复制到 CXExam.exe 所在目录。\n' +
        '只使用内置复制粘贴功能：复制 winmm.dll。\n' +
        '使用外部脚本：同时复制本包内的 gm_shim.js 和 dat.js，不能混用不同构建。\n' +
        '复制完成后重新启动客户端。本包不会自动安装或写入客户端。\n\n' +
        '诊断：Ctrl+Shift+P 打开开发者工具，在 Console 运行 __cefGetDiagnostics()。\n' +
        '崩溃转储：未处理异常会在 %LOCALAPPDATA%\\cef_ex_copy_tool\\crash-dumps 生成本地 .dmp；不会自动上传。\n' +
        '回退：退出客户端后恢复备份，移走本次新增而原来不存在的文件。\n' +
        'manifest.json 记录版本及文件 SHA-256；调试符号位于单独的 symbols.zip 包，不需要安装。\n\n' +
        '源码与说明：https://github.com/tangqingfeng7/cef_ex_copy_tool\n许可证：见 LICENSE。\n';
}
function makeRelease() {
    const dllPath = path.join(ROOT, 'out/build/x86-integrated/src/Release/winmm.dll');
    // Check before creating any release directory or rebuilding external scripts.
    const dll = fs.readFileSync(dllPath);
    const current = buildInfo(ROOT);
    const dllBuild = verifyDll(dll, current);
    const pdb = fs.readFileSync(path.join(path.dirname(dllPath), 'winmm.pdb'));
    execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
    const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/js/metadata.json')));
    const contents = [dll, fs.readFileSync(path.join(ROOT, 'out/js/gm_shim.js')),
        fs.readFileSync(path.join(ROOT, 'out/js/dat.js'))];
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
    const manifest = { schema: 3, scriptVersion: metadata.script.version,
        dllBuild, scriptBuild: metadata.build, git: { commit: after.commit, dirty: after.dirty },
        symbols: { archive: baseName + '-symbols.zip', ...signature, pdbSha256: sha256(pdb) },
        createdAt: new Date().toISOString(), files: {} };
    FILES.forEach((name, i) => {
        fs.writeFileSync(path.join(stage, name), contents[i]);
        manifest.files[name] = sha256(contents[i]);
    });
    const readme = Buffer.from(runtimeReadme(dllBuild), 'utf8');
    const license = fs.readFileSync(path.join(ROOT, 'LICENSE'));
    for (const [name, bytes] of [['README.txt', readme], ['LICENSE', license]]) {
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
        [stage, baseName + '.zip', [...FILES, 'README.txt', 'LICENSE', 'manifest.json']],
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
