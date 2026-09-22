const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const MARKER = 'CEF_CX_BUILD_INFO_V1:';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function gitInfo(root = ROOT) {
    try {
        const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
        const dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options).trim();
        return { commit, dirty };
    } catch (_) { return { commit: null, dirty: null }; }
}

function sourceInfo(root = ROOT) {
    const files = ['VERSION', 'CMakeLists.txt', 'vcpkg.json', 'vcpkg-configuration.json',
        'tools/build-info.cjs', 'tools/build-environment.ps1', 'tools/build-dll.ps1', 'scripts/clipboard_fix.js',
        'scripts/userscript_boot.js', 'scripts/diagnostics.js'];
    function walk(dir) {
        for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const name = dir + '/' + item.name;
            if (item.isDirectory()) walk(name);
            else if (item.isFile()) files.push(name);
            else throw new Error('Unsupported source entry: ' + name);
        }
    }
    ['src', 'cef', 'chromium'].forEach(walk);
    // Hash actual bytes, including uncommitted/untracked native sources. No timestamps.
    const hashes = files.sort().map(name => [name, sha256(fs.readFileSync(path.join(root, name)))]);
    const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version) || version.split('.').some(n => Number(n) > 65535))
        throw new Error('VERSION must contain three integers in the range 0..65535');
    return { version, sourceHash: sha256(JSON.stringify(hashes)) };
}

function buildInfo(root = ROOT, configuration = 'Release') {
    return { schema: 1, ...sourceInfo(root), ...gitInfo(root), architecture: 'x86', configuration };
}

function readDllInfo(binary) {
    const marker = Buffer.from(MARKER, 'utf16le');
    const start = binary.indexOf(marker);
    if (start < 0) throw new Error('DLL has no build metadata; rebuild with tools/build-dll.ps1');
    let end = start + marker.length;
    while (end + 1 < binary.length && (binary[end] !== 0 || binary[end + 1] !== 0)) end += 2;
    if (end + 1 >= binary.length || end - start > 8192) throw new Error('Invalid DLL build metadata');
    let info;
    try { info = JSON.parse(binary.subarray(start + marker.length, end).toString('utf16le')); }
    catch (_) { throw new Error('Invalid DLL build metadata'); }
    if (info.schema !== 1 || !/^[a-f0-9]{64}$/.test(info.sourceHash) || typeof info.version !== 'string')
        throw new Error('Invalid DLL build metadata');
    return info;
}

function verifyDll(binary, current) {
    const embedded = readDllInfo(binary);
    for (const key of ['version', 'sourceHash', 'commit', 'architecture', 'configuration']) {
        if (embedded[key] !== current[key])
            throw new Error('Stale DLL (' + key + ' differs); run tools/build-dll.ps1 before packaging');
    }
    return embedded;
}

function generate(output, configuration) {
    const info = buildInfo(ROOT, configuration);
    const json = JSON.stringify(info);
    const header = '#pragma once\n' +
        '#define CEF_CX_VERSION_NUM ' + info.version.replace(/\./g, ',') + ',0\n' +
        '#define CEF_CX_VERSION_STRING ' + JSON.stringify(info.version) + '\n' +
        '#define CEF_CX_BUILD_RECORD L' + JSON.stringify(MARKER + json) + '\n';
    fs.mkdirSync(output, { recursive: true });
    function write(name, content) {
        const file = path.join(output, name);
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
    }
    write('build_info.h', header);
    let embedded = fs.readFileSync(path.join(ROOT, 'src/clipboard_repair.h.in'), 'utf8');
    for (const [key, file, delimiter] of [
        ['CLIPBOARD_REPAIR_JS', 'clipboard_fix.js', 'CEFPASTE'],
        ['USERSCRIPT_BOOT_JS', 'userscript_boot.js', 'CEFBOOT'],
        ['DIAGNOSTICS_JS', 'diagnostics.js', 'CEFDIAG']]) {
        // Refresh even when timestamps are preserved; split MSVC wide literals.
        const source = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8')
            .replace(/\r\n/g, '\n').replace(/\n/g, '\n)' + delimiter + '"\nLR"' + delimiter + '(');
        embedded = embedded.replace('@' + key + '@', () => source);
    }
    write('clipboard_repair.h', embedded);
}

module.exports = { ROOT, MARKER, sha256, gitInfo, sourceInfo, buildInfo, readDllInfo, verifyDll };
if (require.main === module) {
    if (process.argv.length !== 4) throw new Error('Usage: node tools/build-info.cjs <generated-directory> <configuration>');
    generate(path.resolve(process.argv[2]), process.argv[3]);
}
