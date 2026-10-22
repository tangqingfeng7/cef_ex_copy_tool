const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');
const shim = decodeResource(readResource(fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')), 10, 201)).toString('utf8');
const incompatibleAnswer = JSON.stringify({ type: 'single', choices: ['A', 'B'], needsReview: false });
const completion = content => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] });

test('connection button accepts valid completion without answer schema, saving or starting an exam batch; minimal UI', { timeout: 25000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 800, height: 700 } }), requests = [];
        await page.route('**/*', route => {
            if (new URL(route.request().url()).hostname === 'mooc1.chaoxing.com') return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8"><style>body{font:14px "Segoe UI",sans-serif;background:#f4f6f8;color:#94a3b8}h2{font-size:16px;font-weight:400;margin:35px}</style><h2>Local UI preview · mocked API</h2><div class="questionLi"><h3 class="mark_name" hidden>单选题</h3><div class="answerBg" hidden>A</div></div>' });
            requests.push(JSON.parse(route.request().postData()));
            return route.fulfill({ contentType: 'application/json', body: completion(incompatibleAnswer) });
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/fixture'); await page.evaluate(shim);
        await page.keyboard.press('Control+g');
        const host = page.locator('#cef-deepseek-settings');
        assert.equal(await host.locator('#advanced').getAttribute('open'), null);
        assert.equal(await host.locator('#base').isVisible(), false);
        assert.equal(await host.locator('h2').count(), 0, 'no redundant title');
        await host.locator('#key').fill('fixture-only-not-a-real-key');
        await host.locator('#enabled').check();
        await host.locator('#test').click();
        await page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#status').textContent.includes('连接正常'));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].response_format, undefined);
        assert.equal(requests[0].max_tokens, 16);
        assert.equal(requests[0].messages.length, 1);
        assert.equal(requests[0].messages[0].content, 'Reply OK only.');
        assert.equal(await page.evaluate(() => __cefDeepSeek.enabled()), false, 'probe does not save draft enabled checkbox');
        assert.equal(await page.evaluate(() => __cefDeepSeek.status().configured), false, 'probe does not persist draft key');
        assert.equal(await page.evaluate(() => __cefDeepSeek.status().probeRequests), 1);
        assert.equal(await page.evaluate(() => __cefDeepSeek.status().requests), 0);
        assert.equal(await page.evaluate(() => !!window.aiAnswersData), false, 'no unintended batch requests');
        const geometry = await host.locator('.content').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
        assert(geometry.scroll <= geometry.client, 'collapsed default UI fits without a scrollbar');
        assert.equal(await host.locator('#test').evaluate(el => getComputedStyle(el).borderRadius), '7px');
        assert.equal(await host.locator('#files').isVisible(), false, 'native file input replaced by small attachment action');
        await host.locator('#opacity').fill('100');
        await host.evaluate(el => { el.style.left = '240px'; el.style.top = '120px'; });
        await page.screenshot({ path: path.join(root, 'out/deepseek-minimal-preview.png') });
        await host.locator('#advanced').locator('summary').click();
        assert.equal(await host.locator('#model').isVisible(), true);
        assert.equal(await host.locator('#model').inputValue(), 'deepseek-flash');
        await page.keyboard.press('Control+g'); await host.waitFor({ state: 'hidden' });
        assert.equal(await host.locator('#key').inputValue(), '');
    } finally { await browser.close(); }
});

test('probe distinguishes auth/rate-limit/format/network errors and never retries or enables AI', { timeout: 25000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(); await page.setContent('<!doctype html>'); await page.evaluate(shim);
        let mode = '401', count = 0;
        await page.route('https://api.fixture.invalid/**', route => {
            count++;
            if (mode === 'network') return route.abort('failed');
            if (mode === '401' || mode === '429') return route.fulfill({ status: Number(mode), body: '{}' });
            return route.fulfill({ contentType: 'application/json', body: mode === 'bad' ? '<html>bad endpoint</html>' : completion('') });
        });
        for (const [name, expected] of [['401', 'HTTP_401'], ['429', 'HTTP_429'], ['bad', 'PROBE_FORMAT'], ['empty', 'PROBE_FORMAT'], ['network', 'NETWORK']]) {
            mode = name; const before = count;
            const result = await page.evaluate(async () => { try { await __cefDeepSeek.testConnection({ apiKey: 'fixture', baseUrl: 'https://api.fixture.invalid' }); } catch (e) { return e.code; } });
            assert.equal(result, expected); assert.equal(count, before + 1);
            assert.equal(await page.evaluate(() => __cefDeepSeek.enabled()), false);
        }
        assert.equal(await page.evaluate(() => __cefDeepSeek.status().configured), false);
    } finally { await browser.close(); }
});

test('real answer validation remains strict after separating the health probe', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(); await page.setContent('<!doctype html>'); await page.evaluate(shim);
        await page.route('https://api.fixture.invalid/**', route => route.fulfill({ contentType: 'application/json', body: completion(incompatibleAnswer) }));
        const code = await page.evaluate(async () => {
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://api.fixture.invalid' });
            try { await __cefDeepSeek.answer({ question: 'single with bad choices', options: ['A', 'B'], type: 0 }); } catch (e) { return e.code; }
        });
        assert.equal(code, 'FORMAT', 'do not weaken actual answer checks just to make a connection test pass');
    } finally { await browser.close(); }
});

test('official DeepSeek uses the DLL same-origin proxy when page CSP blocks direct connect', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(); let health = 0, proxied = 0, direct = 0;
        await page.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (url.hostname === 'mooc1.chaoxing.com') {
                if (url.pathname === '/__cef_cx_ai_proxy__/health') {
                    health++;
                    return route.fulfill({ contentType: 'application/json', body: '{"cefCxAiProxy":1}' });
                }
                if (url.pathname === '/__cef_cx_ai_proxy__/chat/completions') {
                    proxied++;
                    assert.equal(request.headers().authorization, undefined, 'secret is not left in the normal Authorization header');
                    assert.equal(request.headers()['x-cef-cx-ai-target'], 'https://api.deepseek.com/chat/completions');
                    assert.equal(request.headers()['x-cef-cx-ai-key'], 'fixture');
                    return route.fulfill({ contentType: 'application/json', body: completion('OK') });
                }
                return route.fulfill({
                    contentType: 'text/html;charset=utf-8',
                    headers: { 'Content-Security-Policy': "default-src 'self'; connect-src 'self'" },
                    body: '<!doctype html><meta charset="utf-8">'
                });
            }
            if (url.hostname === 'api.deepseek.com') direct++;
            return route.abort('blockedbyclient');
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/csp');
        await page.evaluate(() => { window.__cefNativeAiProxy = { version: 1, deepseekOnly: true }; });
        await page.evaluate(shim);
        const result = await page.evaluate(() => __cefDeepSeek.testConnection({ enabled: true, apiKey: 'fixture', baseUrl: 'https://api.deepseek.com' }));
        assert.equal(result.ok, true);
        assert.deepEqual({ health, proxied, direct }, { health: 1, proxied: 1, direct: 0 });
        assert.equal(await page.evaluate(() => __cefDeepSeek.status().transport), 'native-proxy');
    } finally { await browser.close(); }
});
