const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');
function shim() { return decodeResource(readResource(fs.readFileSync(process.env.DEEPSEEK_TEST_DLL || path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')), 10, 201)).toString('utf8'); }
async function fixture() {
    const state = { requests: [], config: null, mode: 'normal', finish: null, closed: 0, capture: null, hiddenAtCapture: false };
    const server = http.createServer(async (req, res) => {
        if (!req.url.endsWith('/chat/completions')) { res.setHeader('content-type', 'text/html;charset=utf-8'); return res.end('<!doctype html><meta charset="utf-8"><p id="selected">选中文字保持原样 &lt;script&gt;不执行&lt;/script&gt;</p><input id="selectionInput" value="输入框里的选择内容"><input type="password" id="password" value="never-copy-this"><iframe id="editor" srcdoc="<p>子框架选中文字</p>"></iframe>'); }
        let body = ''; for await (const part of req) body += part;
        state.requests.push(JSON.parse(body));
        res.on('close', () => state.closed++);
        if (state.mode === 'json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '兼容 JSON 回复' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })); }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.flushHeaders();
        const first = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }) + '\r\n\r\n');
        const split = first.indexOf(Buffer.from('你')) + 1;
        res.write(first.subarray(0, split));
        await new Promise(resolve => setTimeout(resolve, 30)); res.write(first.subarray(split, first.length - 1));
        await new Promise(resolve => setTimeout(resolve, 20)); res.write(first.subarray(first.length - 1));
        if (state.mode === 'incomplete') return res.end();
        await new Promise(resolve => { state.finish = resolve; res.once('close', resolve); });
        if (res.destroyed) return;
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '，世界' }, finish_reason: 'stop' }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/__cef_cx_ai_proxy__/**', async route => {
        const req = route.request();
        if (req.url().endsWith('/health')) return route.fulfill({ contentType: 'application/json', body: '{"cefCxAiProxy":1}' });
        if (req.url().endsWith('/config')) { state.config = JSON.parse(req.postData()); return route.fulfill({ contentType: 'application/json', body: '{"saved":true}' }); }
        if (req.url().endsWith('/capture')) { state.hiddenAtCapture = await page.evaluate(() => document.querySelector('#cef-deepseek-settings').style.visibility === 'hidden'); return route.fulfill({ contentType: 'image/bmp', body: state.capture }); }
        return route.abort();
    });
    async function load(config) {
        await page.goto(url);
        await page.evaluate(c => { window.__CX_AI_CONFIG__ = c; window.__cefNativeAiProxy = { version: 1, configWrite: true, captureRead: true, streamRead: true }; }, config || { apiKey: 'fixture-only', baseUrl: url, enabled: false, panelOpacity: 1 });
        await page.evaluate(shim()); await page.evaluate(() => __cefDeepSeek.openSettings());
    }
    await load();
    const panel = page.locator('#cef-deepseek-settings');
    async function draft(text) { await panel.locator('#tabChat').click(); await panel.locator('#chatInput').fill(text); }
    async function send(text) { await draft(text); await panel.locator('#chatSend').click(); }
    return { page, panel, state, errors, url, load, draft, send, async close() { if (state.finish) state.finish(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('panel geometry persists without saving a draft Key and restores across reload and viewport changes', { timeout: 30000 }, async () => {
    const f = await fixture();
    async function resizeViewport(size) {
        // setViewportSize can resolve before the page's resize handlers have restored the panel.
        await f.page.evaluate(() => {
            window.__testViewportResize = new Promise(resolve => window.addEventListener('resize', () => resolve(), { once: true }));
        });
        await f.page.setViewportSize(size);
        await f.page.evaluate(() => window.__testViewportResize);
    }
    try {
        await f.panel.locator('#key').fill('unsaved-key-must-not-persist');
        let box = await f.panel.locator('#titlebar').boundingBox();
        await f.page.mouse.move(box.x + 40, box.y + 20); await f.page.mouse.down(); await f.page.mouse.move(140, 80); await f.page.mouse.up();
        box = await f.panel.locator('#panelResize').boundingBox();
        await f.page.mouse.move(box.x + 8, box.y + 8); await f.page.mouse.down(); await f.page.mouse.move(550, 650); await f.page.mouse.up();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#opacitySaveState').textContent === '已保存');
        assert(f.state.config.panelBounds.width > 400); assert(f.state.config.panelBounds.height > 550);
        assert.equal(f.state.config.apiKey, 'fixture-only');
        const expected = f.state.config.panelBounds;
        await f.load(f.state.config);
        box = await f.panel.boundingBox();
        for (const [key, field] of [['x', 'left'], ['y', 'top'], ['width', 'width'], ['height', 'height']]) assert(Math.abs(box[key] - expected[field]) <= 1, key);
        await resizeViewport({ width: 280, height: 300 });
        box = await f.panel.boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 281 && box.y + box.height <= 301);
        await resizeViewport({ width: 1000, height: 900 }); box = await f.panel.boundingBox(); assert(Math.abs(box.width - expected.width) <= 1);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('Ctrl+D sends selected text directly including native focused iframe; passwords and forged messages never send', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.state.mode = 'json';
        await f.page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#selected')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
        await f.page.keyboard.press('Control+d');
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.requests[0].messages.at(-1).content, '选中文字保持原样 <script>不执行</script>');
        assert.equal(await f.panel.locator('#chatInput').inputValue(), '');
        await f.page.locator('#selectionInput').evaluate(el => { el.focus(); el.setSelectionRange(0, 3); });
        await f.page.keyboard.press('Control+d');
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert.equal(f.state.requests[1].messages.at(-1).content, '输入框');
        const nativeSelection = fs.readFileSync(path.join(root, 'src/thread.cpp'), 'utf8').match(/LR"JS\(([\s\S]*?)\)JS"/)[1];
        await f.page.evaluate(code => {
            const token = 'a'.repeat(32); __cefDeepSeek.prepareSelection(token, 'Ctrl+D');
            const view = document.querySelector('#editor').contentWindow; const range = view.document.createRange(); range.selectNodeContents(view.document.querySelector('p'));
            const selection = view.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            view.eval('(function(token,combo){' + code + '})("' + token + '","Ctrl+D");');
        }, nativeSelection);
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog').textContent.includes('子框架选中文字'));
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert.equal(f.state.requests.length, 3);
        await f.page.locator('#password').evaluate(el => { el.focus(); el.setSelectionRange(0, 10); });
        await f.page.keyboard.press('Control+d');
        await f.page.evaluate(() => window.postMessage({ type: 'cef-cx-selection-draft', text: 'forged', token: 'b'.repeat(32) }, '*'));
        await f.page.waitForTimeout(80); assert.equal(f.state.requests.length, 3);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('region capture crops actual pixels, cancels cleanly and retains only removable draft thumbnails', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        // Match the native GDI wire format: top-down 32-bit BI_RGB BMP, unused alpha=0.
        const bmp = Buffer.alloc(54 + 1000 * 900 * 4); bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
        bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1000, 18); bmp.writeInt32LE(-900, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(32, 28);
        for (let y = 0; y < 900; y++) for (let x = 0; x < 1000; x++) bmp[54 + (y * 1000 + x) * 4 + (x < 500 ? 2 : 0)] = 255;
        f.state.capture = bmp;
        await f.panel.locator('#tabChat').click(); await f.panel.locator('#captureRegion').click();
        await f.page.locator('#cef-capture-region').waitFor(); await f.page.keyboard.press('Escape');
        await f.page.locator('#cef-capture-region').waitFor({ state: 'detached' });
        assert.equal(await f.panel.locator('#chatImages img').count(), 0);
        await f.panel.locator('#captureRegion').click(); await f.page.locator('#cef-capture-region').waitFor();
        await f.page.mouse.move(100, 100); await f.page.mouse.down(); await f.page.mouse.move(300, 200); await f.page.mouse.up();
        await f.page.locator('#cef-capture-region').waitFor({ state: 'detached' });
        assert(f.state.hiddenAtCapture); assert.equal(f.state.requests.length, 0);
        const pixels = await f.panel.locator('#chatImages img').evaluate(async image => { await image.decode(); const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight; const x = c.getContext('2d'); x.drawImage(image, 0, 0); return { width: c.width, height: c.height, pixel: Array.from(x.getImageData(50, 50, 1, 1).data) }; });
        assert.deepEqual(pixels, { width: 200, height: 100, pixel: [255, 0, 0, 255] });
        await f.panel.locator('#chatInput').fill('截图问题');
        assert.equal(await f.panel.locator('#chatImages img').count(), 1);
        assert.equal(await f.panel.locator('#sendPreview,#previewImages,#confirmSend').count(), 0);
        assert.equal(await f.panel.locator('#chatSend').textContent(), '发送');
        assert.equal(f.state.requests.length, 0);
        await f.panel.locator('#chatImages button').click();
        assert.equal(await f.panel.locator('#chatImages img').count(), 0);
        assert.equal(await f.panel.locator('#chatInput').inputValue(), '截图问题');
        assert.equal(f.state.requests.length, 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('direct send streams split UTF-8, preserves context and reports server usage once', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.draft('原始草稿'); assert.equal(f.state.requests.length, 0);
        await f.panel.locator('#chatInput').fill('确认的内容'); await f.panel.locator('#chatSend').click();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog').textContent.includes('你好'));
        assert.equal(await f.panel.locator('#chatStop').isEnabled(), true); assert.equal(await f.panel.locator('#requestStats').getAttribute('data-state'), 'streaming');
        assert.equal(f.state.requests[0].stream, true); assert.equal(f.state.requests[0].stream_options.include_usage, true);
        assert.equal(f.state.requests[0].messages.at(-1).content, '确认的内容');
        assert(!f.state.requests[0].messages.some(m => String(m.content).includes('原始草稿')));
        f.state.finish();
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert((await f.panel.locator('#chatLog').textContent()).includes('你好，世界'));
        assert.deepEqual(await f.page.evaluate(() => __cefDeepSeek.status().usage), { prompt: 11, completion: 5, total: 16, reported: 1, unreported: 0 });
        await f.draft('下一问'); assert.equal(f.state.requests.length, 1);
        f.state.mode = 'json'; await f.panel.locator('#chatSend').click();
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert(f.state.requests[1].messages.some(m => m.role === 'assistant' && m.content === '你好，世界'));
        assert.equal(f.state.requests.length, 2); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('stop aborts stream, keeps partial text, never retries and excludes failed assistant from subsequent context', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.send('停止测试');
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog').textContent.includes('你好'));
        await f.panel.locator('#chatStop').click();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatSend').disabled === false);
        assert.equal(await f.panel.locator('#requestStats').getAttribute('data-state'), 'canceled');
        assert((await f.panel.locator('#chatLog').textContent()).includes('你好')); assert.equal(f.state.requests.length, 1);
        assert.equal(await f.page.evaluate(() => __cefDeepSeek.status().usage.reported), 0);
        await f.draft('后续问题'); f.state.mode = 'json'; await f.panel.locator('#chatSend').click();
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert(!f.state.requests[1].messages.some(m => m.role === 'assistant' && m.content === '你好'));
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('JSON fallback and incomplete SSE are handled without fake token counts or automatic retries', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.state.mode = 'json'; await f.send('兼容测试'); await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert.equal(await f.page.evaluate(() => __cefDeepSeek.status().usage.total), 7);
        f.state.mode = 'incomplete'; await f.send('中断测试'); await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'failed');
        assert((await f.panel.locator('#chatLog').textContent()).includes('流式响应中断'));
        assert.equal(f.state.requests.length, 2); assert.equal(await f.page.evaluate(() => __cefDeepSeek.status().usage.total), 7);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});


test('queued chat cancellation removes only that job and does not abort the active request', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.send('第一个请求');
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog').textContent.includes('你好'));
        const outcome = await f.page.evaluate(async () => {
            const controller = new AbortController();
            const job = __cefDeepSeek.chat([{ role: 'user', content: '不应发送的排队请求' }], { signal: controller.signal }).then(() => 'unexpected', e => e.code);
            const queued = __cefDeepSeek.status().queued; controller.abort(); return { queued, code: await job, remaining: __cefDeepSeek.status().queued };
        });
        assert.deepEqual(outcome, { queued: 1, code: 'CANCELED', remaining: 0 });
        assert.equal(f.state.requests.length, 1); f.state.finish();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog').textContent.includes('你好，世界'));
        assert.equal(f.state.requests.length, 1); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});


test('direct send keeps removable image thumbnails, handles image-only/Enter and IME, and uses slim chat scrollbars', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.state.mode = 'json'; await f.panel.locator('#tabChat').click();
        assert.equal(await f.panel.locator('#chatSend').textContent(), '发送');
        assert.equal(await f.panel.locator('#sendPreview,#previewText,#confirmSend,#cancelSend').count(), 0);
        const style = await f.panel.locator('#chatLog').evaluate(el => ({ width: getComputedStyle(el, '::-webkit-scrollbar').width, color: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor, radius: getComputedStyle(el, '::-webkit-scrollbar-thumb').borderRadius, buttons: getComputedStyle(el, '::-webkit-scrollbar-button').display }));
        assert.deepEqual(style, { width: '4px', color: 'rgb(219, 225, 232)', radius: '4px', buttons: 'none' });
        await f.panel.locator('#chatSend').click(); assert.equal(f.state.requests.length, 0);
        const input = f.panel.locator('#chatInput');
        await input.fill('输入法内容');
        await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
        assert.equal(f.state.requests.length, 0);
        await input.press('Shift+Enter'); assert.equal(f.state.requests.length, 0);
        await input.fill('回车发送'); await input.press('Enter');
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert.equal(f.state.requests.length, 1);
        assert.equal(f.state.requests[0].messages.at(-1).content, '回车发送');
        await input.fill('');
        await input.evaluate(async el => {
            const c = document.createElement('canvas'); c.width = c.height = 8; c.getContext('2d').fillRect(0, 0, 8, 8);
            const blob = await new Promise(resolve => c.toBlob(resolve)); const file = new File([blob], 'fixture.png', { type: 'image/png' });
            const event = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } }); el.dispatchEvent(event);
        });
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelectorAll('#chatImages img').length === 1);
        assert.equal(f.state.requests.length, 1);
        await f.panel.locator('#chatSend').evaluate(el => { el.click(); el.click(); });
        await f.page.waitForFunction(() => __cefDeepSeek.status().chatRequest.state === 'completed');
        assert.equal(f.state.requests.length, 2, 'busy guard prevents duplicate sends');
        const content = f.state.requests[1].messages.at(-1).content;
        assert(content.some(b => b.type === 'image_url')); assert(content.some(b => b.type === 'text' && b.text === '请分析这张图片。'));
        assert.equal(await f.panel.locator('#chatImages img').count(), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});
