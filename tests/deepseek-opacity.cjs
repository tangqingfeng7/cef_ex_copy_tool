const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const shim = decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8');
async function fixture(panelOpacity = 0.8) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext(), page = await context.newPage();
    let disk = { enabled: false, apiKey: 'saved-fixture-key', model: 'saved-fixture-model', baseUrl: 'https://api.deepseek.com', answerDelayMs: 2500, panelOpacity };
    let status = 200, gate, concurrent = 0, maxConcurrent = 0;
    const writes = []; let generated = 0;
    await context.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.pathname.endsWith('/health')) return route.fulfill({ contentType: 'application/json', body: '{"cefCxAiProxy":1}' });
        if (u.pathname.endsWith('/config')) {
            const value = JSON.parse(route.request().postData()); writes.push(value);
            concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
            const wait = gate; gate = null; if (wait) await wait;
            if (status === 200) disk = { ...disk, ...value };
            await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ saved: status === 200 }) });
            concurrent--; return;
        }
        if (u.pathname.endsWith('/chat/completions')) { generated++; return route.abort(); }
        return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8">' });
    });
    async function load(target = page) {
        await target.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/opacity');
        await target.evaluate(value => {
            window.__CX_AI_CONFIG__ = value;
            window.__cefNativeAiProxy = { version: 1, configWrite: true };
        }, disk);
        await target.evaluate(shim); await target.evaluate(() => __cefDeepSeek.openSettings());
    }
    await load();
    return { browser, context, page, writes, load, disk: () => disk, generated: () => generated, maxConcurrent: () => maxConcurrent,
        status(value) { status = value; }, holdNext() { let release; gate = new Promise(resolve => { release = resolve; }); return release; } };
}
const panel = page => page.locator('#cef-deepseek-settings');
const saved = page => page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#opacitySaveState')?.textContent === '已保存');

test('opacity restores from DLL-adjacent config and slider auto-save preserves saved settings, not unsaved drafts', async () => {
    const f = await fixture();
    try {
        assert.equal(await panel(f.page).evaluate(x => x.style.opacity), '0.8');
        await panel(f.page).locator('#key').fill('unsaved-key-do-not-persist');
        await f.page.evaluate(() => {
            const p = document.querySelector('#cef-deepseek-settings').shadowRoot;
            p.querySelector('#model').value = 'unsaved-model';
            for (const value of ['90', '60', '70']) { p.querySelector('#opacity').value = value; p.querySelector('#opacity').dispatchEvent(new Event('input')); }
        });
        await saved(f.page);
        assert.equal(f.writes.length, 1, 'rapid slider input is debounced');
        assert.equal(f.disk().panelOpacity, 0.7);
        assert.equal(f.disk().apiKey, 'saved-fixture-key');
        assert.equal(f.disk().model, 'saved-fixture-model');
        assert.equal(f.disk().enabled, false);
        assert.equal(f.disk().answerDelayMs, 2500);
        await f.load();
        assert.equal(await panel(f.page).evaluate(x => x.style.opacity), '0.7');
        assert.equal(await panel(f.page).locator('#opacityLabel').textContent(), '70%');
        assert.equal(f.generated(), 0);
    } finally { await f.browser.close(); }
});

test('Ctrl-wheel, right-click and hiding the panel persist the last opacity without triggering answering', async () => {
    const f = await fixture(0.5);
    try {
        await panel(f.page).locator('header').dispatchEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true });
        await saved(f.page); assert.equal(f.disk().panelOpacity, 0.6);
        await panel(f.page).locator('header').click({ button: 'right' });
        await saved(f.page); assert.equal(f.disk().panelOpacity, 0.2);
        await f.page.evaluate(() => {
            const p = document.querySelector('#cef-deepseek-settings').shadowRoot;
            p.querySelector('#opacity').value = '90'; p.querySelector('#opacity').dispatchEvent(new Event('input'));
            __cefDeepSeek.hideSettings();
        });
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#opacitySaveState')?.textContent === '已保存');
        assert.equal(f.disk().panelOpacity, 0.9);
        await f.load(); assert.equal(await panel(f.page).evaluate(x => x.style.opacity), '0.9');
        assert.equal(f.generated(), 0);
    } finally { await f.browser.close(); }
});

test('manual Key saves and opacity writes are serialized, keeping the latest key and opacity', async () => {
    const f = await fixture(0.5), release = f.holdNext();
    try {
        await panel(f.page).locator('#key').fill('new-saved-fixture-key');
        const started = f.page.waitForRequest('**/__cef_cx_ai_proxy__/config');
        await panel(f.page).locator('#save').click(); await started;
        await panel(f.page).locator('#opacity').fill('60');
        await panel(f.page).locator('#opacity').dispatchEvent('change');
        release(); await saved(f.page);
        await f.page.waitForFunction(() => !document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#save').disabled);
        assert.equal(f.disk().apiKey, 'new-saved-fixture-key');
        assert.equal(f.disk().panelOpacity, 0.6);
        assert.equal(await panel(f.page).evaluate(x => x.style.opacity), '0.6');
        assert.equal(f.maxConcurrent(), 1);
        assert.equal(f.generated(), 0);
    } finally { release(); await f.browser.close(); }
});

test('saving shortcuts behind an in-flight Key write keeps the new Key', async () => {
    const f = await fixture(), release = f.holdNext();
    try {
        const host = panel(f.page);
        await host.locator('#advanced').evaluate(element => { element.open = true; });
        await host.locator('#hotkeySettings').evaluate(element => { element.open = true; });
        await host.locator('#key').fill('new-saved-fixture-key');
        const started = f.page.waitForRequest('**/__cef_cx_ai_proxy__/config');
        await host.locator('#save').click(); await started;
        await host.locator('#hotkeySelection').press('Control+Alt+k');
        await host.locator('#hotkeySave').click();
        release();
        await f.page.waitForFunction(() => !document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#hotkeySave').disabled);
        assert.equal(f.disk().apiKey, 'new-saved-fixture-key');
        assert.equal(f.disk().hotkeys.selection, 'Ctrl+Alt+K');
        assert.equal(f.writes.length, 2);
    } finally { release(); await f.browser.close(); }
});

test('config writes from two already-open pages keep each other’s saved fields', async () => {
    const f = await fixture();
    try {
        const secondPage = await f.context.newPage();
        await f.load(secondPage);
        const first = panel(f.page), second = panel(secondPage);
        const saveKey = async value => {
            await first.locator('#key').fill(value);
            await first.locator('#save').click();
            await f.page.waitForFunction(() => !document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#save').disabled);
        };
        await saveKey('new-fixture-key');
        await second.locator('#advanced').evaluate(element => { element.open = true; });
        await second.locator('#hotkeySettings').evaluate(element => { element.open = true; });
        await second.locator('#hotkeySelection').press('Control+Alt+k');
        await second.locator('#hotkeySave').click();
        await secondPage.waitForFunction(() => !document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#hotkeySave').disabled);
        assert.equal(f.disk().apiKey, 'new-fixture-key');
        await saveKey('latest-fixture-key');
        assert.equal(f.disk().apiKey, 'latest-fixture-key');
        assert.equal(f.disk().hotkeys.selection, 'Ctrl+Alt+K');
        assert.deepEqual(f.writes.map(Object.keys), [['apiKey'], ['hotkeys'], ['apiKey']]);
    } finally { await f.browser.close(); }
});

test('failed opacity writes show unsaved status and never claim persistence or alter the old disk value', async () => {
    const f = await fixture(0.5);
    try {
        f.status(500);
        await panel(f.page).locator('#opacity').fill('90');
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#opacitySaveState')?.textContent === '未保存');
        assert.equal(f.disk().panelOpacity, 0.5);
        assert.equal(await panel(f.page).evaluate(x => x.style.opacity), '0.9');
        assert.equal(f.writes.length, 1, 'write failures do not retry forever');
        f.status(200);
        await panel(f.page).locator('#opacity').fill('70'); await saved(f.page);
        assert.equal(f.disk().panelOpacity, 0.7);
        assert.equal(f.generated(), 0);
    } finally { await f.browser.close(); }
});
