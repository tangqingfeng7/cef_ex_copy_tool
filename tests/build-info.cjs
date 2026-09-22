const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, MARKER, buildInfo, sourceInfo, readDllInfo, verifyDll } = require('../tools/build-info.cjs');

test('built DLL embeds the current native sources, version and Git revision', () => {
    const dll = fs.readFileSync(path.join(ROOT, 'out/build/x86-integrated/src/Release/winmm.dll'));
    const current = buildInfo();
    assert.equal(verifyDll(dll, current).sourceHash, current.sourceHash);
    const binaryText = dll.toString('utf16le');
    for (const [file, marker] of [
        ['userscript_boot.js', '// Boot retries apply only before the script entry runs,'],
        ['diagnostics.js', '// Read-only snapshots for DevTools;']]) {
        const start = binaryText.indexOf(marker);
        assert(start >= 0, file + ' is embedded');
        const embedded = binaryText.slice(start, binaryText.indexOf('\0', start));
        assert.equal(embedded.replace(/\r\n/g, '\n'),
            fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8').replace(/\r\n/g, '\n'));
    }
    for (const key of ['version', 'sourceHash', 'commit', 'architecture', 'configuration']) {
        assert.throws(() => verifyDll(dll, { ...current, [key]: 'different' }), /Stale DLL/);
    }
    assert.throws(() => readDllInfo(Buffer.from('legacy DLL')), /no build metadata/);
    assert.throws(() => readDllInfo(Buffer.from(MARKER + '{invalid}\0', 'utf16le')), /Invalid DLL/);
});

test('source fingerprint notices edits with unchanged timestamps and added/deleted headers', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-fingerprint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const dir of ['src', 'cef', 'chromium', 'tools', 'scripts']) fs.mkdirSync(path.join(root, dir));
    for (const file of ['CMakeLists.txt', 'vcpkg.json', 'vcpkg-configuration.json',
        'tools/build-info.cjs', 'tools/build-environment.ps1', 'tools/build-dll.ps1', 'scripts/clipboard_fix.js',
        'scripts/userscript_boot.js', 'scripts/diagnostics.js', 'src/main.cpp'])
        fs.writeFileSync(path.join(root, file), 'first');
    fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0\n');
    const first = sourceInfo(root).sourceHash;
    const file = path.join(root, 'src/main.cpp');
    const stat = fs.statSync(file);
    fs.writeFileSync(file, 'other'); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.notEqual(sourceInfo(root).sourceHash, first);
    fs.writeFileSync(file, 'first');
    assert.equal(sourceInfo(root).sourceHash, first);
    fs.writeFileSync(path.join(root, 'src/extra.h'), 'new header');
    assert.notEqual(sourceInfo(root).sourceHash, first);
    fs.unlinkSync(path.join(root, 'src/extra.h'));
    assert.equal(sourceInfo(root).sourceHash, first);
    fs.writeFileSync(path.join(root, 'scripts/dat.js'), 'external script only');
    assert.equal(sourceInfo(root).sourceHash, first, 'external-only edits do not require a DLL rebuild');
    fs.writeFileSync(path.join(root, 'VERSION'), '1.0.999999');
    assert.throws(() => sourceInfo(root), /VERSION/);
});
