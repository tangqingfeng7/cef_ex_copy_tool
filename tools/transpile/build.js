// Build paired scripts offline; skip Babel/compression when verified outputs are current.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sha256, gitInfo } = require('../build-info.cjs');
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'out/js');
fs.mkdirSync(OUT, { recursive: true });
const lock = path.join(OUT, '.build.lock');
let owned = false;
try {
    const deadline = Date.now() + 60000;
    while (!owned) {
        try { const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); owned = true; }
        catch (e) {
            if (e.code !== 'EEXIST') throw e;
            try { const pid = Number(fs.readFileSync(lock, 'utf8')); if (pid > 0) process.kill(pid, 0); }
            catch (error) { if (error.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
            if (Date.now() >= deadline) throw new Error('Timed out waiting for userscript build lock');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    build();
} finally { if (owned) fs.unlinkSync(lock); }
function writeIfChanged(name, content) {
    const file = path.join(OUT, name), bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) return;
    const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file);
}
function build() {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/dat.js'), 'utf8');
    const shim = fs.readFileSync(path.join(ROOT, 'scripts/gm_shim.js'), 'utf8');
    const assetManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/assets/manifest.json'), 'utf8'));
    const inputs = ['scripts/dat.js', 'scripts/gm_shim.js', 'scripts/deepseek.js', 'scripts/deepseek_ai_script.js', 'scripts/assets/manifest.json',
        'tools/transpile/build.js', 'tools/transpile/babel.config.json', 'tools/transpile/package-lock.json',
        'tools/build-info.cjs', 'tools/resource-codec.ps1'];
    const embedded = {}, assets = {};
    for (const [name, asset] of Object.entries(assetManifest.assets)) {
        if (path.basename(asset.file) !== asset.file) throw new Error('Unsafe asset path');
        const file = 'scripts/assets/' + asset.file, bytes = fs.readFileSync(path.join(ROOT, file));
        if (sha256(bytes) !== asset.sha256 || bytes.length !== asset.bytes) throw new Error('Pinned asset hash mismatch: ' + name);
        if (name === 'Table') { JSON.parse(bytes.toString('utf8')); embedded[name] = { text: bytes.toString('utf8') }; }
        else embedded[name] = { dataUrl: 'data:' + asset.mime + ';base64,' + bytes.toString('base64') };
        inputs.push(file); assets[name] = { sha256: asset.sha256, bytes: bytes.length, source: asset.url };
    }
    const git = gitInfo(ROOT);
    const id = sha256(JSON.stringify(inputs.map(file => [file, sha256(fs.readFileSync(path.join(ROOT, file)))])));
    const key = sha256(JSON.stringify({ id, git }));
    const cachePath = path.join(OUT, 'cache.json');
    try {
        const cache = JSON.parse(fs.readFileSync(cachePath));
        const names = ['dat.js', 'gm_shim.js', 'dat.bin', 'gm_shim.bin', 'metadata.json'];
        if (cache.key === key && cache.outputs && Object.keys(cache.outputs).length === names.length &&
            names.every(name => sha256(fs.readFileSync(path.join(OUT, name))) === cache.outputs[name])) {
            writeIfChanged('build.stamp', key + '\n');
            console.log('[build] cached: Babel and compression skipped; outputs unchanged'); return;
        }
    } catch (_) { /* Missing/corrupt cache must rebuild, never trust timestamps. */ }
    const header = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
    if (!header) throw new Error('Missing userscript metadata');
    const metadata = { script: {}, requires: [], resources: {}, embeddedAssets: assets };
    for (const [, name, value] of header[1].matchAll(/^\/\/\s*@([\w]+)\s+(.+)$/gm)) {
        if (['name', 'version', 'namespace'].includes(name)) metadata.script[name] = value.trim();
        if (name === 'require') metadata.requires.push(value.trim());
        if (name === 'resource') { const [n, url] = value.trim().split(/\s+/); metadata.resources[n] = url; }
    }
    if (!metadata.script.version) throw new Error('Missing script version');
    for (const [name, url] of Object.entries(metadata.resources)) {
        if (!assetManifest.assets[name] || assetManifest.assets[name].url !== url) throw new Error('Unpinned resource: ' + name);
    }
    metadata.build = { id, ...git };
    const babel = require('@babel/core');
    const result = babel.transformSync(source, { configFile: path.join(__dirname, 'babel.config.json'), filename: path.join(ROOT, 'scripts/dat.js') });
    const guard = '(function(w){var build=' + JSON.stringify(metadata.build) + ';w.__cefDatBuild=build;' +
        'if(!w.__cefUserScriptMetadata||!w.__cefUserScriptMetadata.build||w.__cefUserScriptMetadata.build.id!==build.id){' +
        'var e=new Error("Embedded script pair mismatch; rebuild DLL");e.code="CEF_SCRIPT_PAIR_MISMATCH";throw e;}})(window);\n';
    writeIfChanged('dat.js', guard + result.code);
    writeIfChanged('gm_shim.js', 'window.__cefUserScriptMetadata=' + JSON.stringify(metadata) + ';\n' +
        'window.__cefEmbeddedResources=' + JSON.stringify(embedded) + ';\n' + shim + '\n' +
        babel.transformSync(fs.readFileSync(path.join(ROOT, 'scripts/deepseek.js'), 'utf8'), {
            configFile: path.join(__dirname, 'babel.config.json'), filename: path.join(ROOT, 'scripts/deepseek.js')
        }).code + '\n' + babel.transformSync(fs.readFileSync(path.join(ROOT, 'scripts/deepseek_ai_script.js'), 'utf8'), {
            configFile: path.join(__dirname, 'babel.config.json'), filename: path.join(ROOT, 'scripts/deepseek_ai_script.js')
        }).code);
    for (const name of ['dat', 'gm_shim']) {
        const temp = path.join(OUT, name + '.' + process.pid + '.bin');
        try {
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
                path.join(ROOT, 'tools/resource-codec.ps1'), '-Mode', 'Encode', '-InputPath', path.join(OUT, name + '.js'), '-OutputPath', temp],
                { stdio: ['ignore', 'pipe', 'pipe'] });
            writeIfChanged(name + '.bin', fs.readFileSync(temp));
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    metadata.storage = { format: 'CXZ1', algorithm: 'LZMS', scripts: {} };
    for (const name of ['dat', 'gm_shim']) metadata.storage.scripts[name] = {
        decodedBytes: fs.statSync(path.join(OUT, name + '.js')).size, storedBytes: fs.statSync(path.join(OUT, name + '.bin')).size,
        sha256: sha256(fs.readFileSync(path.join(OUT, name + '.js'))) };
    writeIfChanged('metadata.json', JSON.stringify(metadata, null, 2));
    const outputs = {};
    for (const name of ['dat.js', 'gm_shim.js', 'dat.bin', 'gm_shim.bin', 'metadata.json']) outputs[name] = sha256(fs.readFileSync(path.join(OUT, name)));
    writeIfChanged('cache.json', JSON.stringify({ key, outputs }, null, 2));
    writeIfChanged('build.stamp', key + '\n');
    console.log('[build] rebuilt offline with pinned assets: ' + JSON.stringify(metadata.storage.scripts));
}
