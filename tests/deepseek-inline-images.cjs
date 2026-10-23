const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
async function fixture(broken = false) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); const requests = [];
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'ai.fixture.invalid') {
            requests.push(JSON.parse(route.request().postData()));
            if (requests.length === 1) await gate;
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: {
                content: JSON.stringify({ type: 'text', answers: ['print("sample")'], needsReview: false })
            } }] }) });
        }
        if (url.pathname === '/broken.png') return route.fulfill({ status: 404, body: '' });
        const question = n => `<div class="questionLi" data-question-id="q${n}"><h3 class="mark_name">6.（简答题，5.0分）相同题干</h3><input name="type${n}" type="hidden" value="4"><div class="stem"></div><div class="eidtDiv"><textarea></textarea></div></div>`;
        return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + question(1) + (broken ? '' : question(2)) });
    });
    await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/inline-images');
    await page.evaluate(broken => {
        const roots = document.querySelectorAll('.questionLi');
        roots.forEach((root, index) => {
            for (let i = 0; i < (index === 0 && !broken ? 2 : 1); i++) {
                const img = document.createElement('img');
                if (broken) img.src = '/broken.png';
                else {
                    const c = document.createElement('canvas'); c.width = 120; c.height = 200;
                    const x = c.getContext('2d'); x.fillStyle = ['#fecaca', '#dbeafe', '#dcfce7'][index === 0 ? i : 2]; x.fillRect(0, 0, 120, 200);
                    img.src = c.toDataURL('image/png');
                }
                root.querySelector('.stem').appendChild(img);
            }
        });
        window.__CX_AI_CONFIG__ = { enabled: false, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 };
    }, broken);
    await page.evaluate(decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8'));
    return { browser, page, requests, release, async start() {
        await page.evaluate(() => {
            __cefDeepSeek.openSettings();
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 });
        });
    } };
}

test('question-column previews appear during the request and stay correctly paired for identical headings and multiple images', { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
        const started = f.page.waitForRequest('https://ai.fixture.invalid/**');
        await f.start(); await started;
        assert.deepEqual(await f.page.locator('#cef-deepseek-settings .tabs button').allTextContents(), ['答题', '对话']);
        const rows = f.page.locator('#cef-deepseek-settings #progressBody tr');
        const firstImages = rows.first().locator('td:nth-child(2) img');
        assert.equal(await firstImages.count(), 2, 'actual previews belong below the stem in the question column, before the model responds');
        await rows.first().scrollIntoViewIfNeeded();
        assert.equal(await firstImages.first().isVisible(), true);
        assert.equal(await rows.first().getAttribute('data-state'), 'pending');
        const captured = f.requests[0].messages[1].content.filter(x => x.type === 'image_url').map(x => x.image_url.url);
        assert.deepEqual(await firstImages.evaluateAll(nodes => nodes.map(x => x.src)), captured);
        f.release();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelectorAll('#progressBody tr[data-state=success]').length === 2);
        assert.equal(await rows.count(), 2);
        assert.equal(await rows.nth(1).locator('td:nth-child(2) img').count(), 1);
        const second = f.requests[1].messages[1].content.find(x => x.type === 'image_url').image_url.url;
        assert.equal(await rows.nth(1).locator('td:nth-child(2) img').getAttribute('src'), second);
        assert(!captured.includes(second), 'identical titles must not cause image crossover');
        assert.equal(await rows.locator('td:nth-child(3) img').count(), 0, 'answer column stays text only');
        assert.equal(await firstImages.first().getAttribute('role'), null, 'inline preview is not a click-to-expand control');
        assert.equal(await firstImages.first().getAttribute('aria-expanded'), null);
        assert.equal(await firstImages.first().evaluate(x => getComputedStyle(x).maxHeight), 'none', 'the complete image must be directly visible, not height-clipped');
        assert.equal(f.requests.length, 2, 'direct previews do not generate extra paid requests');
    } finally { f.release(); await f.browser.close(); }
});

test('an unreadable question image shows its capture error in the same question cell without remote preview fallback', { timeout: 10000 }, async () => {
    const f = await fixture(true);
    try {
        await f.start();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#progressBody tr[data-state=error]'));
        const cell = f.page.locator('#cef-deepseek-settings #progressBody td:nth-child(2)');
        assert.match(await cell.textContent(), /采集失败/);
        assert.equal(await cell.locator('img').count(), 0);
        assert.equal(f.requests.length, 0);
    } finally { f.release(); await f.browser.close(); }
});
