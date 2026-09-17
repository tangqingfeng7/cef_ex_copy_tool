const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildInfo, verifyDll } = require('../build-info.cjs');
const ROOT = path.resolve(__dirname, '../..');
const FILES = ['winmm.dll', 'gm_shim.js', 'dat.js'];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function makeRelease() {
    const dllPath = path.join(ROOT, 'out/build/x86-integrated/src/Release/winmm.dll');
    // Check before creating any release directory or rebuilding external scripts.
    const dll = fs.readFileSync(dllPath);
    const current = buildInfo(ROOT);
    const dllBuild = verifyDll(dll, current);
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
    const manifest = { schema: 2, scriptVersion: metadata.script.version,
        dllBuild, scriptBuild: metadata.build, git: { commit: after.commit, dirty: after.dirty },
        createdAt: new Date().toISOString(), files: {} };
    fs.mkdirSync(dir, { recursive: true });
    FILES.forEach((name, i) => {
        fs.writeFileSync(path.join(dir, name), contents[i]);
        manifest.files[name] = sha256(contents[i]);
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return dir;
}
module.exports = { makeRelease, FILES, sha256 };
if (require.main === module) console.log('[release] ' + makeRelease());
