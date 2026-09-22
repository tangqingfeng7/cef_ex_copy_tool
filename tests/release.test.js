const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRelease, runPowerShell, sha256 } = require('../tools/transpile/release');
const root = path.resolve(__dirname, '..');

// Run after the parallel runtime tests: packaging rebuilds their JS fixtures.
test('versioned runtime and symbol ZIPs contain matching files, instructions and hashes', () => {
    const dir = makeRelease();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
    const archives = JSON.parse(fs.readFileSync(path.join(dir, 'archives.json'))).archives;
    const names = Object.keys(archives);
    assert.equal(names.length, 2);
    const runtime = names.find(name => !name.endsWith('-symbols.zip'));
    const symbols = names.find(name => name.endsWith('-symbols.zip'));
    assert(runtime.includes('-v' + manifest.dllBuild.version + '-x86-'));
    assert.equal(symbols, manifest.symbols.archive);
    for (const [name, hash] of Object.entries(archives))
        assert.equal(sha256(fs.readFileSync(path.join(dir, name))), hash);
    const runtimeEntries = runPowerShell('zip-release.ps1', ['-ArchivePath', path.join(dir, runtime), '-Inspect']);
    const symbolEntries = runPowerShell('zip-release.ps1', ['-ArchivePath', path.join(dir, symbols), '-Inspect']);
    assert.deepEqual(Object.keys(runtimeEntries).sort(), ['LICENSE', 'README.txt', 'dat.js', 'gm_shim.js', 'manifest.json', 'winmm.dll'].sort());
    assert.deepEqual(Object.keys(symbolEntries).sort(), ['README.txt', 'symbols.json', 'winmm.pdb'].sort());
    for (const [name, hash] of Object.entries(manifest.files)) assert.equal(runtimeEntries[name], hash);
    assert.equal(runtimeEntries['manifest.json'], sha256(fs.readFileSync(path.join(dir, 'manifest.json'))));
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'symbols/symbols.json')));
    assert.equal(info.dllSha256, runtimeEntries['winmm.dll']);
    assert.equal(info.pdbSha256, symbolEntries['winmm.pdb']);
    assert.equal(info.guid, manifest.symbols.guid); assert.equal(info.age, manifest.symbols.age);
    const readme = fs.readFileSync(path.join(dir, 'README.txt'), 'utf8');
    assert(readme.includes('__cefGetDiagnostics()') && readme.includes('手动复制'));
    assert(readme.includes('crash-dumps') && readme.includes('不会自动上传'));
    console.log('[verified release] ' + dir);
});

test('symbol validation rejects a PDB belonging to another binary', () => {
    assert.throws(() => runPowerShell('check-symbols.ps1', [
        '-DllPath', path.join(process.env.WINDIR, 'System32', 'kernel32.dll'),
        '-PdbPath', path.join(root, 'out/build/x86-integrated/src/Release/winmm.pdb')
    ]), /PDB does not match DLL/);
});
