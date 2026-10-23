const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function fixture(native = false) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const requests = []; let answer = { type: 'text', answers: ['line\n'.repeat(80)], needsReview: false }, balanceStatus = 200, balanceBody, balanceGate;
    await page.route('**/*', async route => {
        const request = route.request(), u = new URL(request.url());
        if (u.pathname.endsWith('/health')) return route.fulfill({ contentType: 'application/json', body: '{"cefCxAiProxy":1}' });
        if (u.pathname.endsWith('/user/balance') || u.pathname.endsWith('/chat/completions')) {
            requests.push({ url: u.href, method: request.method(), headers: request.headers(), body: request.postData() });
            if (u.pathname.endsWith('/user/balance')) {
                const gate = balanceGate; balanceGate = null;
                if (gate) await gate;
                await new Promise(resolve => setTimeout(resolve, 60));
                return route.fulfill({ status: balanceStatus, contentType: 'application/json', body: JSON.stringify(balanceBody || { is_available: true, balance_infos: [
                    { currency: 'CNY', total_balance: '12.3400', granted_balance: '2.00', topped_up_balance: '10.3400' },
                    { currency: 'USD', total_balance: '0.50', granted_balance: '0.00', topped_up_balance: '0.50' }
                ] }) });
            }
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }) });
        }
        return route.fulfill({ contentType: 'text/html;charset=utf-8', body: `<!doctype html><meta charset="utf-8"><div id="question"><img src="${png}" width="100" height="100"></div>` });
    });
    await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/preview-balance');
    await page.evaluate(native => {
        window.__CX_AI_CONFIG__ = { enabled: false, apiKey: 'fixture-private', baseUrl: 'https://api.deepseek.com' };
        if (native) window.__cefNativeAiProxy = { version: 1, balanceRead: true };
    }, native);
    await page.evaluate(decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8'));
    await page.evaluate(() => __cefDeepSeek.openSettings());
    return { browser, page, requests, setAnswer(value) { answer = value; }, setBalanceStatus(value) { balanceStatus = value; }, setBalanceBody(value) { balanceBody = value; },
        holdNextBalance() { let release; balanceGate = new Promise(resolve => { release = resolve; }); return release; } };
}

test('only answer/chat tabs remain and question-column images directly preview actual captured bytes', async () => {
    const f = await fixture();
    try {
        await f.page.evaluate(async () => {
            const result = await __cefDeepSeek.answer({ question: '图片编程题', type: 4, options: [], root: document.querySelector('#question') });
            __cefDeepSeek.progress({ index: 1, root: document.querySelector('#question'), question: '图片编程题', answer: result.list[0][0], state: 'success' });
        });
        const panel = f.page.locator('#cef-deepseek-settings');
        assert.deepEqual(await panel.locator('.tabs button').allTextContents(), ['答题', '对话']);
        assert.equal(await panel.locator('#tabImages, #imagePane, #imageDiagnostics').count(), 0);
        const img = panel.locator('#progressBody td:nth-child(2) img');
        await img.scrollIntoViewIfNeeded();
        assert.equal(await img.isVisible(), true);
        assert.match(await img.getAttribute('src'), /^data:image\/png;base64,/);
        const content = JSON.parse(f.requests.find(x => x.url.endsWith('/chat/completions')).body).messages[1].content;
        assert.equal(await img.getAttribute('src'), content.find(x => x.type === 'image_url').image_url.url);
        assert.equal(await img.getAttribute('aria-expanded'), null);
        assert.equal(await img.getAttribute('role'), null);
        if (process.env.DEEPSEEK_UI_SCREENSHOT) await f.page.screenshot({ path: process.env.DEEPSEEK_UI_SCREENSHOT });
    } finally { await f.browser.close(); }
});

test('judge normalization preserves false in scalar, single-item and explicit alternate answer fields', async () => {
    const f = await fixture();
    try {
        for (const raw of [false, 'F', { type: 'judge', answers: false }, { type: 'judge', answer: ['错'] },
            { type: 'judge', result: false }, { type: 'judge', is_correct: false }, { type: 'judge', choices: ['B'], answers: [] }]) {
            f.setAnswer(raw);
            const result = await f.page.evaluate(async () => {
                __cefDeepSeek.clear();
                try { return await __cefDeepSeek.answer({ question: '判断题', type: 3, options: ['对', '错'] }); }
                catch (e) { return { error: e.message }; }
            });
            assert.deepEqual(result.list, [['错误']], JSON.stringify(raw) + ': ' + result.error);
        }
        const system = JSON.parse(f.requests.at(-1).body).messages[0].content;
        assert(!system.includes('"answers":[]'), 'judge prompt must not demonstrate an empty answer array');
    } finally { await f.browser.close(); }
});

test('ambiguous and empty judge responses are not filled and receive bounded structure diagnostics', async () => {
    const f = await fixture();
    try {
        for (const [raw, hint] of [
            [{ type: 'judge', answers: [], needsReview: false }, /判断题.*缺少.*answers.*array\(0\)/],
            [{ type: 'judge', answers: ['正确'], result: false }, /冲突/],
            [{ type: 'judge', result: 0 }, /无法唯一/],
            [{ type: 'judge', answer: ['对', '错'] }, /数量/]
        ]) {
            f.setAnswer(raw);
            const error = await f.page.evaluate(async () => {
                __cefDeepSeek.clear();
                try { await __cefDeepSeek.answer({ question: '判断题', type: 3, options: ['对', '错'] }); return ''; }
                catch (e) { return e.message; }
            });
            assert.match(error, hint);
            assert(!error.includes('fixture-private'));
        }
    } finally { await f.browser.close(); }
});

test('balance uses read-only official GET, coalesces refreshes and caches without touching answer counters', async () => {
    const f = await fixture(true);
    try {
        const result = await f.page.evaluate(async () => {
            const before = __cefDeepSeek.status();
            const values = await Promise.all([__cefDeepSeek.refreshBalance(), __cefDeepSeek.refreshBalance(true)]);
            await __cefDeepSeek.refreshBalance();
            return { before, after: __cefDeepSeek.status(), values,
                text: document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#balanceStatus').textContent };
        });
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].method, 'GET');
        assert.equal(f.requests[0].body, null);
        assert.equal(f.requests[0].url, 'https://mooc1.chaoxing.com/__cef_cx_ai_proxy__/user/balance');
        assert.equal(f.requests[0].headers['x-cef-cx-ai-target'], 'https://api.deepseek.com/user/balance');
        assert.equal(f.requests[0].headers.authorization, undefined);
        assert.match(result.text, /CNY 12\.3400.*USD 0\.50/);
        assert.equal(result.after.requests, result.before.requests);
        assert.equal(result.after.probeRequests, result.before.probeRequests);
        assert(!JSON.stringify(result).includes('fixture-private'));
        f.setBalanceStatus(401);
        const code = await f.page.evaluate(async () => { try { await __cefDeepSeek.refreshBalance(true); } catch (e) { return e.code; } });
        assert.equal(code, 'HTTP_401');
        assert.match(await f.page.locator('#cef-deepseek-settings #balanceStatus').textContent(), /Key.*无效/);
    } finally { await f.browser.close(); }
});

test('custom provider keys are never sent to DeepSeek balance and old native channels require an upgrade', async () => {
    const f = await fixture(true);
    try {
        const codes = await f.page.evaluate(async () => {
            const result = [];
            for (const baseUrl of ['https://custom.invalid/v1', 'https://api.deepseek.com:444']) {
                __cefDeepSeek.configure({ enabled: false, apiKey: 'fixture-private', baseUrl });
                try { await __cefDeepSeek.refreshBalance(); } catch (e) { result.push(e.code); }
            }
            __cefDeepSeek.configure({ enabled: false, apiKey: 'fixture-private', baseUrl: 'https://api.deepseek.com' });
            window.__cefNativeAiProxy = { version: 1 };
            try { await __cefDeepSeek.refreshBalance(); } catch (e) { result.push(e.code); }
            return result;
        });
        assert.deepEqual(codes, ['BALANCE_UNSUPPORTED', 'BALANCE_UNSUPPORTED', 'PROXY_UNAVAILABLE']);
        assert.equal(f.requests.length, 0);
    } finally { await f.browser.close(); }
});

test('changing saved credentials cancels old balance results without replacing the new account state', async () => {
    const f = await fixture(true);
    const release = f.holdNextBalance();
    try {
        const started = f.page.waitForRequest('**/__cef_cx_ai_proxy__/user/balance');
        await f.page.evaluate(() => { window.oldBalance = __cefDeepSeek.refreshBalance().catch(e => ({ error: e.code })); });
        await started;
        const old = await f.page.evaluate(async () => {
            __cefDeepSeek.configure({ enabled: false, apiKey: 'fixture-new-account', baseUrl: 'https://api.deepseek.com' });
            await __cefDeepSeek.refreshBalance();
            return await window.oldBalance;
        });
        release(); assert.equal(old.error, 'STALE');
        assert.equal(f.requests.length, 2);
        assert.equal(f.requests[1].headers['x-cef-cx-ai-key'], 'fixture-new-account');
        assert.match(await f.page.locator('#cef-deepseek-settings #balanceStatus').textContent(), /CNY 12\.3400/);
        assert.equal(await f.page.locator('#cef-deepseek-settings #balanceRefresh').isEnabled(), true);
    } finally { release(); await f.browser.close(); }
});

test('zero/unavailable balance and malformed payloads are distinguished without altering answer progress', async () => {
    const f = await fixture();
    try {
        f.setBalanceBody({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] });
        await f.page.evaluate(async () => {
            __cefDeepSeek.reportStatus('保留答题状态', 'success');
            await __cefDeepSeek.refreshBalance(true);
        });
        assert.match(await f.page.locator('#cef-deepseek-settings #balanceStatus').textContent(), /CNY 0\.00.*不可用/);
        for (const raw of [{ is_available: 'false', balance_infos: [] }, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '<script>bad</script>' }] }]) {
            f.setBalanceBody(raw);
            const code = await f.page.evaluate(async () => { try { await __cefDeepSeek.refreshBalance(true); } catch (e) { return e.code; } });
            assert.equal(code, 'BALANCE_FORMAT');
        }
        assert.equal(await f.page.locator('#cef-deepseek-settings #status').textContent(), '保留答题状态');
        assert.equal(await f.page.locator('#cef-deepseek-settings #balanceStatus script').count(), 0);
        assert(f.requests.every(x => x.method === 'GET' && x.url === 'https://api.deepseek.com/user/balance'));
        const release = f.holdNextBalance();
        try {
            const code = await f.page.evaluate(async () => {
                const timer = window.setTimeout;
                window.setTimeout = (fn, ms) => timer(fn, ms === 15000 ? 30 : ms);
                try { await __cefDeepSeek.refreshBalance(true); } catch (e) { return e.code; }
                finally { window.setTimeout = timer; }
            });
            assert.equal(code, 'BALANCE_NETWORK', 'DOMException numeric code 20 must become a bounded public error code');
        } finally { release(); }
    } finally { await f.browser.close(); }
});
