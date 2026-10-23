const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');
const source = () => process.env.RENDER_TEST_SOURCE ? fs.readFileSync(process.env.RENDER_TEST_SOURCE, 'utf8') : decodeResource(readResource(fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')), 10, 201)).toString('utf8');
async function fixture() {
    const state = { mode: 'stream', requests: [], response: null };
    const server = http.createServer(async (req, res) => {
        if (req.url.startsWith('/__cef_cx_ai_proxy__/')) { res.writeHead(404); return res.end(); }
        if (!req.url.endsWith('/chat/completions')) { res.setHeader('content-type', 'text/html;charset=utf-8'); return res.end('<!doctype html><meta charset="utf-8"><p>local render fixture</p>'); }
        let body = ''; for await (const chunk of req) body += chunk;
        state.requests.push(JSON.parse(body));
        if (state.mode === 'json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'JSON 最终回复' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })); }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.flushHeaders(); state.response = res;
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.goto(url);
    await page.evaluate(url => {
        window.__CX_AI_CONFIG__ = { enabled: false, apiKey: 'fixture-only', baseUrl: url, panelOpacity: 1 };
        // Deterministically suspend only the render scheduler. Network/request
        // timeouts and Playwright's explicit 10ms polling retain real timers.
        const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
        let id = -1;
        const frames = new Map(), timers = new Map(), history = [];
        window.requestAnimationFrame = callback => { const n = id--; frames.set(n, callback); history.push(callback); return n; };
        window.cancelAnimationFrame = n => frames.delete(n);
        window.setTimeout = (callback, delay, ...args) => { if (delay !== 100) return timeout(callback, delay, ...args); const n = id--; timers.set(n, callback); history.push(callback); return n; };
        window.clearTimeout = n => { if (!timers.delete(n)) clear(n); };
        window.__renderClock = { frames, timers, history, flush(kind) { const map = kind === 'frame' ? frames : timers, callbacks = Array.from(map.values()); map.clear(); callbacks.forEach(fn => fn(performance.now())); } };
    }, url);
    await page.evaluate(source());
    await page.evaluate(() => { __cefDeepSeek.openSettings(); document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#tabChat').click(); });
    const panel = page.locator('#cef-deepseek-settings');
    async function waitState(expected) { await page.waitForFunction(expected => __cefDeepSeek.status().chatRequest.state === expected, expected, { polling: 10 }); }
    async function idle(expected = 'completed') { await waitState(expected); await page.waitForFunction(() => !document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatSend').disabled, null, { polling: 10 }); }
    async function send(text) { state.response = null; await panel.locator('#chatInput').evaluate((el, text) => el.value = text, text); await panel.locator('#chatSend').evaluate(el => el.click()); }
    function emit(parts, end) {
        assert(state.response && !state.response.destroyed, 'live mock response');
        let data = parts.map(content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('');
        if (end === 'done') data += 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }) + '\n\ndata: [DONE]\n\n';
        if (end) state.response.end(data); else state.response.write(data);
    }
    async function ready() { await waitState('waiting'); for (let i = 0; !state.response && i < 100; i++) await new Promise(r => setTimeout(r, 5)); assert(state.response); }
    return { page, panel, state, errors, waitState, idle, send, emit, ready, async close() { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

test('burst deltas coalesce, reuse history/text/attachment nodes and avoid repeated state writes; final text flushes without rAF', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.state.mode = 'json'; await f.send('第一问'); await f.idle();
        await f.page.evaluate(() => {
            const panel = document.querySelector('#cef-deepseek-settings').shadowRoot;
            window.__historyNodes = Array.from(panel.querySelector('#chatLog').children); window.__historyText = __historyNodes.map(n => n.firstChild);
            window.__statWrites = 0;
            new MutationObserver(records => window.__statWrites += records.length).observe(panel.querySelector('#requestStats'), { childList: true, characterData: true, subtree: true, attributes: true });
        });
        await f.panel.locator('#chatInput').evaluate(async el => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
            const blob = await new Promise(resolve => canvas.toBlob(resolve)), file = new File([blob], 'draft.png', { type: 'image/png' });
            const event = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } }); el.dispatchEvent(event);
        });
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelectorAll('#chatImages img').length === 1, null, { polling: 10 });
        f.state.mode = 'stream';
        await f.page.evaluate(() => { const p = document.querySelector('#cef-deepseek-settings').shadowRoot; p.querySelector('#chatInput').value = '保留的草稿'; __cefDeepSeek.askSelection('仅发送选中文字', true); window.__draftImage = p.querySelector('#chatImages img'); });
        await f.ready();
        const chunk = '<b>中文🙂</b>\n'; f.emit(Array(200).fill(chunk)); await f.waitState('streaming');
        const before = await f.page.evaluate(() => { const p = document.querySelector('#cef-deepseek-settings').shadowRoot; return { frames: __renderClock.frames.size, timers: __renderClock.timers.size, text: p.querySelector('#chatLog').lastChild.textContent, sameHistory: __historyNodes.every((n, i) => p.querySelector('#chatLog').children[i] === n && n.firstChild === __historyText[i]), sameImage: p.querySelector('#chatImages img') === __draftImage, draft: p.querySelector('#chatInput').value }; });
        assert.deepEqual(before, { frames: 1, timers: 1, text: '等待回复…', sameHistory: true, sameImage: true, draft: '保留的草稿' });
        await f.page.evaluate(() => __renderClock.flush('frame'));
        assert.equal(await f.panel.locator('#chatLog > .assistant').last().textContent(), chunk.repeat(200));
        assert.equal(await f.panel.locator('#chatLog b').count(), 0, 'stream stays plain text');
        f.emit(['最后一段'], 'done'); await f.idle();
        assert.equal(await f.panel.locator('#chatLog > .assistant').last().textContent(), chunk.repeat(200) + '最后一段');
        assert.equal(f.state.requests.length, 2); assert.equal(f.state.requests[1].messages.at(-1).content, '仅发送选中文字');
        const after = await f.page.evaluate(() => { const p = document.querySelector('#cef-deepseek-settings').shadowRoot; return { sameHistory: __historyNodes.every((n, i) => p.querySelector('#chatLog').children[i] === n && n.firstChild === __historyText[i]), sameImage: p.querySelector('#chatImages img') === __draftImage, pending: __renderClock.frames.size + __renderClock.timers.size, writes: __statWrites, usage: __cefDeepSeek.status().usage }; });
        assert(after.sameHistory && after.sameImage); assert.equal(after.pending, 0); assert(after.writes < 25, 'state writes must not scale with delta count: ' + after.writes); assert.equal(after.usage.total, 23);
        await f.panel.locator('#chatImages button').evaluate(el => el.click()); assert.equal(await f.panel.locator('#chatImages img').count(), 0);
        assert.equal(await f.panel.locator('#chatInput').inputValue(), '保留的草稿'); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('stop forces pending text, failed assistant stays out of context, and stale callbacks cannot touch clear/new generation', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.send('停止这次'); await f.ready(); f.emit(['未', '刷', '新的内容']); await f.waitState('streaming');
        await f.page.evaluate(() => window.__staleCallbacks = __renderClock.history.slice());
        await f.panel.locator('#chatStop').evaluate(el => el.click()); await f.idle('canceled');
        assert.match(await f.panel.locator('#chatLog').textContent(), /未刷新的内容.*已停止/s);
        await f.send('第二次'); await f.ready(); f.emit(['新请求内容']); await f.waitState('streaming');
        await f.page.evaluate(() => __staleCallbacks.forEach(fn => fn(performance.now())));
        assert.equal(await f.panel.locator('#chatLog > .assistant').last().textContent(), '等待回复…');
        assert.equal(await f.page.evaluate(() => __renderClock.frames.size), 1);
        f.emit(['收尾'], 'done'); await f.idle();
        assert.equal(await f.panel.locator('#chatLog > .assistant').last().textContent(), '新请求内容收尾');
        assert(!f.state.requests[1].messages.some(m => m.role === 'assistant' && m.content.includes('未刷新')));
        await f.panel.locator('#chatClear').evaluate(el => el.click());
        await f.page.evaluate(() => __renderClock.history.forEach(fn => fn(performance.now())));
        assert.equal(await f.panel.locator('#chatLog > div').count(), 0);
        assert.equal(await f.page.evaluate(() => __renderClock.frames.size + __renderClock.timers.size), 0); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('timer fallback works with suspended animation frames; incomplete SSE and JSON completion flush final text synchronously', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.send('后台页'); await f.ready(); f.emit(['a', '中', '🙂']); await f.waitState('streaming');
        await f.page.evaluate(() => __renderClock.flush('timer'));
        assert.equal(await f.panel.locator('#chatLog > .assistant').textContent(), 'a中🙂');
        assert.equal(await f.page.evaluate(() => __renderClock.frames.size + __renderClock.timers.size), 0);
        f.emit(['中断前最后一段'], 'incomplete'); await f.idle('failed');
        assert.match(await f.panel.locator('#chatLog > .assistant').textContent(), /a中🙂中断前最后一段.*流式响应中断/s);
        assert.equal(await f.page.evaluate(() => __renderClock.frames.size + __renderClock.timers.size), 0);
        f.state.mode = 'json'; await f.send('JSON回退'); await f.idle();
        assert.equal(await f.panel.locator('#chatLog > .assistant').last().textContent(), 'JSON 最终回复');
        const result = await f.page.evaluate(() => ({ pending: __renderClock.frames.size + __renderClock.timers.size, usage: __cefDeepSeek.status().usage }));
        assert.equal(result.pending, 0); assert.equal(result.usage.total, 7); assert.equal(result.usage.unreported, 1); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('history cap evicts only the oldest pair, retains remaining node identities, and clear removes all rows', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.state.mode = 'json';
        for (let i = 0; i < 9; i++) { await f.send('问题 ' + i); await f.idle(); }
        await f.page.evaluate(() => { const log = document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog'); window.__keptNodes = Array.from(log.children).slice(2); window.__keptTexts = __keptNodes.map(n => n.firstChild); });
        await f.send('问题 9'); await f.idle();
        assert.equal(await f.panel.locator('#chatLog > div').count(), 18);
        assert.equal(await f.page.evaluate(() => { const log = document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog'); return __keptNodes.every((n, i) => log.children[i] === n && n.firstChild === __keptTexts[i]); }), true);
        assert.equal(f.state.requests.length, 10);
        await f.panel.locator('#chatClear').evaluate(el => el.click()); assert.equal(await f.panel.locator('#chatLog > div').count(), 0); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});
