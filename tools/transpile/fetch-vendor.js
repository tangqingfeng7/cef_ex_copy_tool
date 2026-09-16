// fetch-vendor.js —— 把 dat.js 需要的 @require/@resource 依赖下载到 vendor/，多镜像兜底。
// 换机器、或 vendor/ 缺文件时运行：  npm run fetch-vendor
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, 'vendor');
fs.mkdirSync(OUT, { recursive: true });

// 每个目标文件给若干候选 URL，按顺序尝试，第一个成功即用。
const TARGETS = {
    'axios.min.js': [
        'https://cdn.jsdelivr.net/npm/axios@0.27.2/dist/axios.min.js',
        'https://unpkg.com/axios@0.27.2/dist/axios.min.js',
    ],
    'jquery.min.js': [
        'https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js',
        'https://unpkg.com/jquery@3.6.0/dist/jquery.min.js',
    ],
    'polyfill.min.js': [
        'https://cdn.jsdelivr.net/npm/promise-polyfill@8.3.0/dist/polyfill.min.js',
        'https://unpkg.com/promise-polyfill@8.3.0/dist/polyfill.min.js',
    ],
    'hash.min.js': [
        'https://cdn.staticfile.org/cryptico/0.0.1343522940/hash.min.js',
        'https://cdn.bootcdn.net/ajax/libs/cryptico/0.0.1343522940/hash.min.js',
    ],
    'vue.min.js': [
        'https://cdn.jsdelivr.net/npm/vue@2.6.0/dist/vue.min.js',
        'https://unpkg.com/vue@2.6.0/dist/vue.min.js',
    ],
    'element-ui.index.js': [
        'https://cdn.jsdelivr.net/npm/element-ui@2.15.13/lib/index.js',
        'https://unpkg.com/element-ui@2.15.13/lib/index.js',
    ],
    'element-ui.index.min.css': [
        'https://cdn.jsdelivr.net/npm/element-ui@2.14.1/lib/theme-chalk/index.css',
        'https://unpkg.com/element-ui@2.14.1/lib/theme-chalk/index.css',
    ],
    'table.json': [
        'https://www.forestpolice.org/ttf/2.0/table.json',
        'https://cdn.lyck6.cn/ttf/1.0/table.json',
    ],
    'source-table.json': [
        'https://cdn.lyck6.cn/ttf/1.0/table.json',
        'https://www.forestpolice.org/ttf/2.0/table.json',
    ],
};

function fetchOnce(url, maxRedirect) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirect > 0) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return resolve(fetchOnce(next, maxRedirect - 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(new Error('TIMEOUT')); });
    });
}

(async () => {
    const ok = [], bad = [];
    for (const [name, urls] of Object.entries(TARGETS)) {
        let saved = false;
        for (const u of urls) {
            try {
                const buf = await fetchOnce(u, 5);
                if (buf.length < 32) throw new Error('too small ' + buf.length);
                fs.writeFileSync(path.join(OUT, name), buf);
                console.log('OK   ' + name + '  (' + buf.length + ' bytes)  <- ' + u);
                ok.push(name); saved = true; break;
            } catch (e) {
                console.log('miss ' + name + '  <- ' + u + '  : ' + e.message);
            }
        }
        if (!saved) bad.push(name);
    }
    console.log('\n==== 成功 ' + ok.length + ' / ' + Object.keys(TARGETS).length + ' ====');
    if (bad.length) { console.log('未取到: ' + bad.join(', ')); process.exitCode = 1; }
})();
