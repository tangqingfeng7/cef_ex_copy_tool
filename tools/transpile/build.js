// build.js —— 把scripts/dat.js 转译成客户端旧 V8 能跑的版本，输出到 out/js/dat.js。
// 改完源文件 dat.js 后运行：  npm run build
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

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
const res = babel.transformSync(src, {
    configFile: path.join(__dirname, 'babel.config.json'),
    filename: SRC,
});
fs.writeFileSync(OUT, res.code, 'utf8');
const shim = fs.readFileSync(path.join(ROOT, 'scripts', 'gm_shim.js'), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'gm_shim.js'),
    'window.__cefUserScriptMetadata=' + JSON.stringify(metadata) + ';\n' + shim, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log('[build] dat.js -> out/js/dat.js  (' + src.length + ' -> ' + res.code.length + ' 字符)');
