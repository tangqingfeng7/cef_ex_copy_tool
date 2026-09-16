// serve.js —— 方案8：本地托管 dat.js 主脚本，支持热更新。
//
// 作用：起一个本地 HTTP 服务，把scripts/dat.js（源码、含现代语法）
//       用 Babel 即时转译成客户端旧 V8 能跑的版本，并带 CORS 头返回。
//       客户端里的 dat.loader.js 注入后会 fetch 本服务，拿到脚本再 eval。
//       => 改完scripts/dat.js 保存，刷新考试页面即可生效，无需手动转译/拷贝。
//
// 用法：
//   cd tools/transpile
//   npm run serve            # 默认监听 127.0.0.1:8799
//   PORT=9001 npm run serve  # 自定义端口（注意同步改 gm_shim.js 的 __wnDatRemoteURL）
//
// 注意：
//   - 本服务应运行在「考试客户端所在的同一台机器」上，loader 走 127.0.0.1 访问。
//   - 页面是 https，fetch http://127.0.0.1 属于 Chromium 对 localhost 的安全例外，正常放行。

const http = require('http');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8799', 10);

// scripts/dat.js（源码）。serve.js 位于 tools/transpile/ 下。
const DAT_SRC = path.resolve(__dirname, '..', '..', 'scripts', 'dat.js');
const BABEL_CONFIG = path.resolve(__dirname, 'babel.config.json');
// 离线依赖目录（axios/jQuery/Vue/ElementUI 等，避免考试机连不上外网 CDN）。
const VENDOR_DIR = path.resolve(__dirname, 'vendor');
const MIME = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

// 按 mtime 缓存转译结果，避免每次请求都重新转译大文件。
let cache = { mtimeMs: 0, code: '' };

function buildDat() {
    const stat = fs.statSync(DAT_SRC);
    if (cache.code && stat.mtimeMs === cache.mtimeMs) {
        return cache.code;
    }
    const src = fs.readFileSync(DAT_SRC, 'utf8');
    const out = babel.transformSync(src, {
        configFile: BABEL_CONFIG,
        filename: DAT_SRC,
    });
    cache = { mtimeMs: stat.mtimeMs, code: out.code };
    console.log(`[serve] 已转译 dat.js (${src.length} -> ${out.code.length} 字符)`);
    return out.code;
}

function sendCors(res, status, body, type) {
    res.writeHead(status, {
        'Content-Type': type || 'application/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        sendCors(res, 204, '');
        return;
    }
    const url = (req.url || '/').split('?')[0];

    // 离线依赖：/vendor/<file>，从本地 vendor 目录读取（防目录穿越）。
    if (url.indexOf('/vendor/') === 0) {
        const name = path.basename(url);
        // sourcemap（.map）仅供 DevTools 调试，没有也不影响运行，安静地返回空。
        if (name.toLowerCase().endsWith('.map')) {
            sendCors(res, 200, '{}', 'application/json; charset=utf-8');
            return;
        }
        const file = path.join(VENDOR_DIR, name);
        try {
            const buf = fs.readFileSync(file);
            sendCors(res, 200, buf, MIME[path.extname(name).toLowerCase()] || 'application/octet-stream');
        } catch (e) {
            console.error('[serve] vendor 缺失:', name);
            sendCors(res, 404, `console.error('[dat-loader] vendor 缺失: ${name}');`);
        }
        return;
    }

    if (url === '/dat.js' || url === '/') {
        try {
            sendCors(res, 200, buildDat());
        } catch (e) {
            // 转译失败（多半是源码语法错误）：返回一段会在控制台报错的 JS，方便定位。
            const msg = String((e && e.message) || e).replace(/`/g, "'").replace(/\\/g, '/');
            console.error('[serve] 转译失败:', e && e.message);
            sendCors(res, 200, `console.error('[dat-loader] 服务端转译失败:', \`${msg}\`);`);
        }
        return;
    }
    sendCors(res, 404, `console.error('[dat-loader] 未知路径: ${url}');`);
});

server.listen(PORT, HOST, () => {
    console.log(`[serve] dat.js 本地服务已启动: http://${HOST}:${PORT}/dat.js`);
    console.log(`[serve] 源文件: ${DAT_SRC}`);
    console.log('[serve] 改完源文件保存后，刷新考试页面即可热更新。Ctrl+C 退出。');
    try { buildDat(); } catch (e) { console.error('[serve] 首次转译失败:', e && e.message); }
});
