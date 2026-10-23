const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const code = 'students = []\nfor i in range(1, 4):\n    name = input("姓名：")\n    score1 = int(input("科目1："))\n    score2 = int(input("科目2："))\n    students.append((name, score1, score2))\nprint("姓名\\t科目1\\t科目2")\nfor name, score1, score2 in students:\n    print(f"{name}\\t{score1}\\t{score2}")';

async function run(raw) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); let request;
    try {
        await page.route('**/*', route => {
            if (new URL(route.request().url()).hostname === 'ai.fixture.invalid') {
                request = JSON.parse(route.request().postData());
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: raw } }] }) });
            }
            return route.fulfill({ contentType: 'text/html;charset=utf-8', body: `<!doctype html><meta charset="utf-8"><div class="questionLi" data-question-id="code"><h3 class="mark_name">6.（简答题，5.0分）</h3><div class="stem"><img src="${png}"></div><input name="type6" type="hidden" value="4"><div class="eidtDiv"><textarea></textarea></div></div>` });
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/image-code');
        await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: false, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 }; });
        const shim = decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8');
        await page.evaluate(shim);
        await page.evaluate(() => { __cefDeepSeek.openSettings(); __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture-only', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 }); });
        await page.waitForFunction(() => window.aiAnswersData && Object.keys(aiAnswersData).length, null, { timeout: 5000 });
        const output = await page.evaluate(() => ({ value: document.querySelector('.questionLi textarea').value,
            progress: document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#progressBody').textContent }));
        const blocks = request.messages[1].content;
        assert.equal(blocks.filter(x => x.type === 'image_url' && x.image_url.url.startsWith('data:image/png;base64,')).length, 1, 'the actual request must contain captured image bytes');
        return output;
    } finally { await browser.close(); }
}

test('image-only short answer accepts structured code aliases, preserving indentation and newlines', { timeout: 20000 }, async () => {
    for (const raw of [
        JSON.stringify({ type: 'code', code }),
        JSON.stringify({ type: 'short_answer', answer: code, needsReview: false }),
        JSON.stringify({ type: 'blank', answers: [code], needsReview: false }),
        '```json\n' + JSON.stringify({ type: 'text', answers: [code], needsReview: false }) + '\n```'
    ]) {
        const output = await run(raw);
        assert.equal(output.value, code);
        assert.match(output.progress, /已填入/);
    }
});

test('image code answer errors expose safe expected/actual schema hints without inserting malformed data', { timeout: 20000 }, async () => {
    for (const [raw, hint] of [
        [JSON.stringify({ type: 'multiple', choices: ['A'], needsReview: false }), /简答.*text.*multiple/],
        [JSON.stringify({ type: 'text', answers: ['first', 'second'], needsReview: false }), /答案数量/],
        [code, /JSON/]
    ]) {
        const output = await run(raw);
        assert.equal(output.value, '');
        assert.match(output.progress, hint);
    }
});
