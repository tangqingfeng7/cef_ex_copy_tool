const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.DEEPSEEK_TEST_SOURCE_ROOT || root;
const dll = process.env.DEEPSEEK_TEST_DLL || path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll');
const shim = () => decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8');
const completion = value => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
const blank = n => `<div class="questionLi" data-question-id="q${n}"><h3 class="mark_name">填空题 Q${n}</h3><input name="type${n}" type="hidden" value="2"><textarea></textarea></div>`;
async function fixture(html, api, config = {}) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'ai.fixture.invalid') return api(route);
        if (url.pathname.endsWith('.png')) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + html });
    });
    await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/improvements');
    await page.evaluate(c => { window.__CX_AI_CONFIG__ = { enabled: false, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0, ...c }; }, config);
    await page.evaluate(shim());
    return { browser, page, async start(extra = {}) {
        await page.evaluate(c => { __cefDeepSeek.openSettings(); __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0, ...c }); }, { ...config, ...extra });
    }};
}

test('multi-select synchronizes exact choice set under all overwrite policies and refuses false success', { timeout: 30000 }, async () => {
    const html = '<div class="questionLi" data-question-id="multi"><h3 class="mark_name">多选题 Q1</h3><input name="type1" type="hidden" value="1">' +
        ['A', 'B', 'C'].map(x => `<div class="answerBg" data-letter="${x}" onclick="this.querySelector('i').classList.toggle('check_answer')">${x}<i class="${x !== 'C' ? 'check_answer' : ''}"></i></div>`).join('') + '</div>';
    for (const [policy, decision, expected] of [['always', true, 'BC'], ['empty-only', true, 'AB'], ['ask', false, 'AB'], ['ask', true, 'BC']]) {
        const f = await fixture(html, route => route.fulfill({ contentType: 'application/json', body: completion({ type: 'multiple', choices: ['B', 'C'], needsReview: false }) }), { overwritePolicy: policy });
        try {
            await f.page.evaluate(value => { window.confirm = () => value; }, decision);
            await f.start();
            await f.page.waitForFunction(() => window.aiAnswersData && Object.keys(aiAnswersData).length);
            const selected = await f.page.locator('.answerBg').evaluateAll(nodes => nodes.filter(n => n.querySelector('.check_answer')).map(n => n.dataset.letter).join(''));
            assert.equal(selected, expected, policy + ':' + decision);
        } finally { await f.browser.close(); }
    }
    const inert = await fixture(html.replace(/onclick="[^"]*"/g, ''), route => route.fulfill({ contentType: 'application/json', body: completion({ type: 'multiple', choices: ['B', 'C'], needsReview: false }) }));
    try {
        await inert.start();
        await inert.page.waitForFunction(() => window.aiAnswersData && Object.keys(aiAnswersData).length);
        assert.match(await inert.page.locator('#cef-deepseek-settings').locator('#progressBody').textContent(), /未填入/);
    } finally { await inert.browser.close(); }
});

test('control-only configuration changes preserve a pending request and the sequential queue', { timeout: 15000 }, async () => {
    let release, requests = [];
    const f = await fixture(blank(1) + blank(2), async route => {
        const prompt = JSON.parse(route.request().postData()).messages[1].content[0].text;
        const n = prompt.includes('Q1') ? 1 : 2;
        requests.push(n);
        if (n === 1) await new Promise(resolve => { release = resolve; });
        return route.fulfill({ contentType: 'application/json', body: completion({ type: 'blank', answers: ['answer' + n], needsReview: false }) });
    });
    try {
        await f.start();
        for (let n = 0; !release && n < 100; n++) await f.page.waitForTimeout(10);
        assert(release);
        await f.page.evaluate(() => __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 100, overwritePolicy: 'empty-only' }));
        release();
        await f.page.waitForFunction(() => Array.from(document.querySelectorAll('.questionLi textarea')).every(x => x.value), null, { timeout: 5000 });
        assert.deepEqual(requests, [1, 2]);
    } finally { if (release) release(); await f.browser.close(); }
});

test('explicit failure-only retry keeps successful questions and bypasses only the failed request block', { timeout: 15000 }, async () => {
    const requests = [];
    const f = await fixture(blank(1) + blank(2) + blank(3), route => {
        const text = JSON.parse(route.request().postData()).messages[1].content[0].text;
        const n = Number(text.match(/Q(\d)/)[1]);
        requests.push(n);
        if (n === 2 && requests.filter(x => x === 2).length === 1) return route.fulfill({ status: 429, body: '{}' });
        return route.fulfill({ contentType: 'application/json', body: completion({ type: 'blank', answers: ['answer' + n], needsReview: false }) });
    });
    try {
        await f.start();
        await f.page.waitForFunction(() => document.querySelector('[data-question-id=q3] textarea').value);
        assert.equal(await f.page.locator('#cef-deepseek-settings').locator('#retryFailed').count(), 1);
        await f.page.locator('#cef-deepseek-settings').locator('#advanced').evaluate(x => { x.open = true; });
        await f.page.locator('#cef-deepseek-settings').locator('#retryFailed').click();
        await f.page.waitForFunction(() => document.querySelector('[data-question-id=q2] textarea').value, null, { timeout: 5000 });
        assert.deepEqual(requests, [1, 2, 3, 2]);
    } finally { await f.browser.close(); }
});

test('shortening the interval applies during the existing countdown without restarting Q1', { timeout: 15000 }, async () => {
    const requests = [];
    const f = await fixture(blank(1) + blank(2), route => {
        const text = JSON.parse(route.request().postData()).messages[1].content[0].text;
        const n = Number(text.match(/Q(\d)/)[1]); requests.push(n);
        return route.fulfill({ contentType: 'application/json', body: completion({ type: 'blank', answers: ['answer' + n], needsReview: false }) });
    }, { answerDelayMs: 5000 });
    try {
        await f.start();
        await f.page.waitForFunction(() => document.querySelector('[data-question-id=q1] textarea').value);
        const changedAt = Date.now();
        await f.page.evaluate(() => __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 }));
        await f.page.waitForFunction(() => document.querySelector('[data-question-id=q2] textarea').value, null, { timeout: 1500 });
        assert(Date.now() - changedAt < 1500);
        assert.deepEqual(requests, [1, 2]);
    } finally { await f.browser.close(); }
});

test('question image diagnostics include safe local previews and distinguish capture failure', { timeout: 15000 }, async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const html = blank(1).replace('Q1</h3>', `Q1<img src="${png}"></h3>`) + blank(2).replace('Q2</h3>', 'Q2<img src="/broken.png"></h3>');
    let apiCalls = 0;
    const f = await fixture(html, route => { apiCalls++; return route.fulfill({ contentType: 'application/json', body: completion({ type: 'blank', answers: ['x'], needsReview: false }) }); });
    try {
        await f.start();
        await f.page.waitForFunction(() => window.aiAnswersData && Object.keys(aiAnswersData).length === 2, null, { timeout: 10000 });
        const diagnostics = f.page.locator('#cef-deepseek-settings').locator('#progressBody');
        assert.equal(await diagnostics.locator('img').count(), 1);
        assert.match(await diagnostics.locator('img').getAttribute('src'), /^data:image\//);
        assert.match(await diagnostics.textContent(), /已采集/);
        assert.match(await diagnostics.textContent(), /失败/);
        assert.equal(apiCalls, 1, 'unreadable image must not start a text-only paid fallback');
    } finally { await f.browser.close(); }
});

test('tag release automation publishes only the DLL and checks live tag identity', () => {
    const workflow = fs.readFileSync(path.join(sourceRoot, '.github/workflows/build.yml'), 'utf8');
    assert.match(workflow, /Publish verified DLL/);
    assert.match(workflow, /contents: write/);
    const script = fs.readFileSync(path.join(sourceRoot, 'tools/publish-release.ps1'), 'utf8');
    assert.match(script, /ls-remote/);
    assert.match(script, /--clobber/);
    assert.match(script, /Get-FileHash/);
    assert.match(script, /gh release download/);
    assert.match(script, /v\$Version/);
});
