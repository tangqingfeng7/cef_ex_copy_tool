const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const binary = fs.readFileSync(dll), shim = decodeResource(readResource(binary, 10, 201)).toString('utf8');
const dat = decodeResource(readResource(binary, 10, 202)).toString('utf8');
async function fixture(loadDat = false, overrideFetch = false) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    page.setDefaultTimeout(5000);
    let disk = { enabled: false, apiKey: 'saved-fixture', baseUrl: 'https://api.deepseek.com', answeringPaused: false }, configStatus = 200;
    const writes = []; let api = 0, apiGate;
    await page.route('**/*', async route => {
        const p = new URL(route.request().url()).pathname;
        if (p.endsWith('/health')) return route.fulfill({ contentType: 'application/json', body: '{"cefCxAiProxy":1}' });
        if (p.endsWith('/config')) {
            const next = JSON.parse(route.request().postData()); writes.push(next); if (configStatus === 200) disk = next;
            return route.fulfill({ status: configStatus, contentType: 'application/json', body: JSON.stringify({ saved: configStatus === 200, win32: configStatus === 200 ? 0 : 5 }) });
        }
        if (p.endsWith('/chat/completions')) {
            api++; const gate = apiGate; apiGate = null; if (gate) await gate;
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'text', answers: ['sample'], needsReview: false }) } }] }) });
        }
        if (p.endsWith('/fixture')) return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8"><main tabindex="0">fixture</main>' });
        return route.fulfill({ contentType: 'application/json', body: '{"code":0,"result":[]}' });
    });
    async function load() {
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/fixture');
        await page.evaluate(({ value, overrideFetch }) => {
            window.__CX_AI_CONFIG__ = value;
            window.__cefNativeAiProxy = { version: 1, configWrite: true };
            if (overrideFetch) window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        }, { value: disk, overrideFetch });
        await page.evaluate(shim);
        if (loadDat) await page.evaluate('(function($,jQuery){\n' + dat + '\n}).call(window,window.__wnJQ||window.$,window.__wnJQ||window.jQuery)');
        await page.evaluate(() => __cefDeepSeek.openSettings());
    }
    await load();
    return { browser, page, writes, load, disk: () => disk, api: () => api, fail(value) { configStatus = value ? 500 : 200; },
        holdNextApi() { let release; apiGate = new Promise(resolve => { release = resolve; }); return release; } };
}
const panel = p => p.locator('#cef-deepseek-settings');
const saved = p => p.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#opacitySaveState').textContent === '已保存', null, { timeout: 2000 });

test('Down lazily creates the real embedded legacy UI, Up hides it and showing recovers off-screen coordinates', { timeout: 15000 }, async () => {
    const f = await fixture(true);
    try {
        await f.page.locator('main').focus();
        await f.page.keyboard.press('ArrowDown');
        const old = f.page.locator('#modelId_xx');
        assert.equal(await old.count(), 1, 'dat.js must create the old panel even when its worker has not initialized it');
        assert.equal(await old.isVisible(), true);
        await f.page.keyboard.press('ArrowUp'); assert.equal(await old.isVisible(), false);
        await f.page.setViewportSize({ width: 820, height: 650 });
        assert.equal(await old.isVisible(), false, 'resizing must not reopen a deliberately hidden panel');
        await old.evaluate(x => { x.style.left = '9999px'; x.style.top = '9999px'; });
        await f.page.keyboard.press('ArrowDown');
        await f.page.waitForFunction(() => {
            const p = document.getElementById('modelId_xx'), b = p && p.getBoundingClientRect();
            return b && b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1;
        }, null, { timeout: 2000 });
        const b = await old.boundingBox(); assert(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 901 && b.y + b.height <= 701,
            JSON.stringify({ box: b, css: await old.getAttribute('style') }));
        assert.equal(await old.locator('#iframeNode').count(), 1);
        assert.equal(f.api(), 0, 'manual legacy UI does not start duplicate AI requests');
    } finally { await f.browser.close(); }
});

test('native-forwarded legacy controls work with a plain child frame but do not steal editor arrow keys', { timeout: 15000 }, async () => {
    const f = await fixture(true);
    try {
        const result = await f.page.evaluate(() => {
            if (!window.__cefLegacyPanel) return { missing: true };
            const frame = document.createElement('iframe'); document.body.appendChild(frame);
            frame.contentDocument.body.innerHTML = '<p tabindex="0">plain frame</p><textarea>editor</textarea>';
            frame.contentDocument.querySelector('p').focus();
            const shown = __cefLegacyPanel.setVisible(true);
            __cefLegacyPanel.setVisible(false);
            frame.contentDocument.querySelector('textarea').focus();
            const blocked = __cefLegacyPanel.setVisible(true);
            document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#key').focus();
            const shadowBlocked = __cefLegacyPanel.setVisible(true);
            return { shown, blocked, shadowBlocked, hidden: document.getElementById('modelId_xx').style.display === 'none' };
        });
        assert.deepEqual(result, { shown: true, blocked: false, shadowBlocked: false, hidden: true });
    } finally { await f.browser.close(); }
});

test('config saves survive broken fetch; disabled AI and paused answering restore independently after reload', { timeout: 15000 }, async () => {
    const f = await fixture(false, true);
    try {
        await panel(f.page).locator('#enabled').check(); await saved(f.page);
        await panel(f.page).locator('#pause').click(); await saved(f.page);
        await panel(f.page).locator('#enabled').uncheck(); await saved(f.page);
        assert.equal(f.disk().enabled, false); assert.equal(f.disk().answeringPaused, true);
        await f.load();
        assert.equal(await panel(f.page).locator('#enabled').isChecked(), false);
        assert.equal(await panel(f.page).locator('#pause').getAttribute('data-paused'), 'true');
        await panel(f.page).locator('#enabled').check(); await saved(f.page);
        assert.equal(await panel(f.page).locator('#pause').getAttribute('data-paused'), 'true', 'enabling AI must not implicitly resume');
        await f.load();
        assert.equal(await panel(f.page).locator('#enabled').isChecked(), true);
        assert.equal(await panel(f.page).locator('#pause').getAttribute('data-paused'), 'true');
        await f.page.keyboard.press('Control+r'); await saved(f.page);
        assert.equal(f.disk().enabled, true); assert.equal(f.disk().answeringPaused, false);
        assert.equal(f.api(), 0);
    } finally { await f.browser.close(); }
});

test('a rejected write exposes a concrete file error and clicking unsaved retries only local config', { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
        f.fail(true); await panel(f.page).locator('#opacity').fill('90');
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#opacitySaveState').textContent === '未保存', null, { timeout: 2000 });
        assert.match(await panel(f.page).locator('#opacitySaveState').getAttribute('title'), /目录无写入权限/);
        f.fail(false); await panel(f.page).locator('#opacitySaveState').click(); await saved(f.page);
        assert.equal(f.disk().panelOpacity, 0.9); assert.equal(f.api(), 0);
    } finally { await f.browser.close(); }
});

test('pause survives off/on during a waiting answer and resume starts the current round instead of remaining stuck', { timeout: 15000 }, async () => {
    const f = await fixture(), release = f.holdNextApi();
    try {
        await f.page.evaluate(() => {
            const q = document.createElement('div'); q.className = 'questionLi'; q.dataset.questionId = 'waiting';
            q.innerHTML = '<h3 class="mark_name">1.（简答题）练习</h3><input name="type1" type="hidden" value="4"><div class="eidtDiv"><textarea></textarea></div>';
            document.body.appendChild(q);
        });
        const started = f.page.waitForRequest('**/__cef_cx_ai_proxy__/chat/completions');
        await panel(f.page).locator('#enabled').check(); await started;
        await panel(f.page).locator('#pause').click(); release();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#progressBody').textContent.includes('已识别'), null, { timeout: 2000 });
        await panel(f.page).locator('#enabled').uncheck(); await saved(f.page);
        await panel(f.page).locator('#enabled').check(); await saved(f.page);
        assert.equal(await panel(f.page).locator('#pause').getAttribute('data-paused'), 'true');
        await panel(f.page).locator('#pause').click();
        await f.page.waitForFunction(() => document.querySelector('.questionLi textarea').value === 'sample', null, { timeout: 2500 });
        assert.equal(f.api(), 2);
    } finally { release(); await f.browser.close(); }
});
