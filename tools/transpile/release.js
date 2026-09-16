const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');
const FILES = ['winmm.dll', 'gm_shim.js', 'dat.js'];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function makeRelease() {
    execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
    const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/js/metadata.json')));
    const sources = [path.join(ROOT, 'out/build/x86-integrated/src/Release/winmm.dll'),
        path.join(ROOT, 'out/js/gm_shim.js'), path.join(ROOT, 'out/js/dat.js')];
    const contents = sources.map(file => fs.readFileSync(file));
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    const dir = path.join(ROOT, 'out/release', id);
    const manifest = { schema: 1, scriptVersion: metadata.script.version, createdAt: new Date().toISOString(), files: {} };
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
