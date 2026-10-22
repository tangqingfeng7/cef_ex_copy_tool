const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const names = ['dat.js', 'gm_shim.js', 'dat.bin', 'gm_shim.bin', 'metadata.json'];
function snapshot() {
    return names.map(n => { const file = path.join(root, 'out/js', n); return [n, fs.statSync(file).mtimeMs, fs.readFileSync(file).toString('base64')]; });
}
const build = () => execFileSync(process.execPath, [path.join(root, 'tools/transpile/build.js')], { cwd: root, encoding: 'utf8' });
test('no-op build preserves all JS/resource mtimes and content; damaged output is repaired', () => {
    const before = snapshot();
    assert.match(build(), /cached:/); assert.deepEqual(snapshot(), before);
    const file = path.join(root, 'out/js/dat.bin'), original = fs.readFileSync(file), stat = fs.statSync(file);
    try {
        const broken = Buffer.from(original); broken[8] ^= 1; fs.writeFileSync(file, broken); fs.utimesSync(file, stat.atime, stat.mtime);
        assert.match(build(), /rebuilt offline/);
        assert.equal(fs.readFileSync(file).toString('base64'), original.toString('base64'));
        assert.match(build(), /cached:/);
    } finally {
        // Always leave the published intermediate pair consistent, even on failure.
        if (!fs.readFileSync(file).equals(original)) { fs.writeFileSync(file, original); build(); }
    }
});

test('a complete no-op native build does not recompile or relink the DLL', { timeout: 60000 }, () => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/build-dll.ps1')];
    const nativeBuild = () => execFileSync('powershell.exe', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    // Settle the intentionally repaired resource's timestamp before measuring.
    nativeBuild();
    const files = ['out/build/x86-integrated/src/Release/winmm.dll',
        'out/build/x86-integrated/src/Release/winmm.pdb',
        'out/build/x86-integrated/src/generated/build_info.h',
        ...names.map(name => 'out/js/' + name)];
    const capture = () => files.map(name => [name, fs.statSync(path.join(root, name)).mtimeMs]);
    const before = capture(), started = Date.now(), output = nativeBuild();
    assert.match(output, /cached:/);
    assert.deepEqual(capture(), before);
    console.log('[incremental] unchanged DLL/PDB/resources; native no-op build ' + (Date.now() - started) + ' ms');
});
