// build.js —— 把scripts/dat.js 转译成客户端旧 V8 能跑的版本，输出到 out/js/dat.js。
// 改完源文件 dat.js 后运行：  npm run build
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { sha256, gitInfo } = require('../build-info.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'scripts', 'dat.js');
const OUT_DIR = path.join(ROOT, 'out', 'js');
const OUT = path.join(OUT_DIR, 'dat.js');

fs.mkdirSync(OUT_DIR, { recursive: true });
const src = fs.readFileSync(SRC, 'utf8');
const header = src.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
if (!header) throw new Error('Missing userscript metadata');
const metadata = { script: {}, requires: [], resources: {} };
for (const [, key, value] of header[1].matchAll(/^\/\/\s*@([\w]+)\s+(.+)$/gm)) {
    if (['name', 'version', 'namespace'].includes(key)) metadata.script[key] = value.trim();
    if (key === 'require') metadata.requires.push(value.trim());
    if (key === 'resource') {
        const parts = value.trim().split(/\s+/);
        metadata.resources[parts[0]] = parts[1];
    }
}
if (!metadata.script.version) throw new Error('Missing script version');
const shim = fs.readFileSync(path.join(ROOT, 'scripts', 'gm_shim.js'), 'utf8');
metadata.build = {
    id: sha256(JSON.stringify([src, shim,
        fs.readFileSync(path.join(__dirname, 'babel.config.json'), 'utf8'),
        fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8'),
        fs.readFileSync(__filename, 'utf8')])),
    ...gitInfo(ROOT)
};
const res = babel.transformSync(src, {
    configFile: path.join(__dirname, 'babel.config.json'),
    filename: SRC,
});
const guard = '(function(w){var build=' + JSON.stringify(metadata.build) + ';' +
    'w.__cefDatBuild=build;' +
    'if(!w.__cefUserScriptMetadata||!w.__cefUserScriptMetadata.build||w.__cefUserScriptMetadata.build.id!==build.id){' +
    'var e=new Error("gm_shim.js and dat.js are from different builds; replace both files");' +
    'e.code="CEF_SCRIPT_PAIR_MISMATCH";throw e;}})(window);\n';
fs.writeFileSync(OUT, guard + res.code, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'gm_shim.js'),
    'window.__cefUserScriptMetadata=' + JSON.stringify(metadata) + ';\n' + shim, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log('[build] dat.js -> out/js/dat.js  (' + src.length + ' -> ' + res.code.length + ' 字符)');
