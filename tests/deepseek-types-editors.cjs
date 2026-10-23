const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const code = 'students = []\nfor i in range(3):\n    name = input("姓名：")\n    students.append(name)\nprint(students)';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function fixture(html, response, setup) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); const requests = [];
    await page.route('**/*', route => {
        if (new URL(route.request().url()).hostname === 'ai.fixture.invalid') {
            const body = JSON.parse(route.request().postData()); requests.push(body);
            const value = typeof response === 'function' ? response(body) : response;
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) });
        }
        return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + html });
    });
    await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/types-editors');
    if (setup) await page.evaluate(setup);
    await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: false, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 }; });
    await page.evaluate(decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8'));
    return { browser, page, requests, async start() {
        await page.evaluate(() => { __cefDeepSeek.openSettings(); __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 }); });
        await page.waitForFunction(() => {
            const row = document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#progressBody tr');
            return row && row.getAttribute('data-state') !== 'pending';
        }, null, { timeout: 5000 });
    }, async progress() { return page.locator('#cef-deepseek-settings').locator('#progressBody').textContent(); } };
}
function question(title, inputs, editor = '<div class="eidtDiv"><textarea></textarea></div>') {
    return `<div class="questionLi" data-question-id="one"><h3 class="mark_name">${title}</h3><img src="${png}">${inputs}${editor}</div>`;
}

test('explicit short-answer labels override empty/conflicting fields; unrelated typeface is not question metadata', { timeout: 45000 }, async () => {
    for (const [title, inputs] of [
        ['6.（简答题，5.0分）', '<input name="type6" type="hidden" value="">'],
        ['6.（简答题，5.0分）', '<input name="type6" type="hidden" value="0">'],
        ['6.（简答题，5.0分）', '<input name="typeface" type="hidden" value="0"><input name="type6" type="hidden" value="4">'],
        ['6. 编写程序', '<input name="type6" type="hidden" value="   ">'],
        ['6. 根据图片完成程序', '<input name="typeface" type="hidden" value="0"><input name="type6" type="hidden" value="4">'],
        ['6. 根据图片完成程序', '<input name="type6" type="hidden" value="not-a-number">']
    ]) {
        const f = await fixture(question(title, inputs), request => ({ type: request.messages[1].content[0].text.includes('题型：text') ? 'text' : 'single', answers: [code], choices: [], needsReview: false }));
        try {
            await f.start();
            assert.match(f.requests[0].messages[1].content[0].text, /题型：text/);
            assert.equal(await f.page.locator('.questionLi textarea').inputValue(), code);
            assert.equal(f.requests[0].messages[1].content.filter(x => x.type === 'image_url').length, 1);
        } finally { await f.browser.close(); }
    }
});

test('judge aliases include boolean false and F; choice letters map using actual reversed option labels', { timeout: 30000 }, async () => {
    const html = '<div class="questionLi" data-question-id="one"><h3 class="mark_name">5.（判断题，5.0分）</h3><input name="type5" type="hidden" value="3">' +
        ['错误', '正确'].map((text, index) => `<div class="answerBg" data-index="${index}" onclick="document.querySelectorAll('.answerBg i').forEach(n=>n.className='');this.querySelector('i').className='check_answer'"><span class="answer_p">${text}</span><i></i></div>`).join('') + '</div>';
    for (const value of [
        { type: 'judge', answers: [], answer: false, needsReview: false },
        { type: 'judge', answers: ['F'], needsReview: false },
        { type: 'judge', answers: [false], needsReview: false },
        { type: 'judge', choices: ['A'], needsReview: false },
        { type: 'boolean', correct: false }
    ]) {
        const f = await fixture(html, value);
        try {
            await f.start();
            assert.equal(await f.page.locator('.answerBg').evaluateAll(nodes => nodes.findIndex(n => n.querySelector('.check_answer'))), 0);
            assert.match(await f.progress(), /已填入/);
        } finally { await f.browser.close(); }
    }
    const bad = await fixture(html, { type: 'judge', answers: [false, true], needsReview: false });
    try {
        await bad.start();
        assert.equal(await bad.page.locator('.check_answer').count(), 0);
        assert.match(await bad.progress(), /失败/);
    } finally { await bad.browser.close(); }
});

test('multiline code fills an iframe editor and hidden textarea without losing line breaks or indentation', { timeout: 15000 }, async () => {
    const editor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea><iframe id="editor" srcdoc="<!doctype html><body>旧答案</body>"></iframe></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const f = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', editor), { type: 'text', answers: [code], needsReview: false });
    try {
        await f.start();
        const result = await f.page.evaluate(() => {
            const body = document.querySelector('#editor').contentDocument.body;
            const clone = body.cloneNode(true); clone.querySelectorAll('br').forEach(n => n.replaceWith(clone.ownerDocument.createTextNode('\n')));
            return { text: clone.textContent.trim(), html: document.querySelector('textarea').value, saved: window.saved || 0 };
        });
        assert.equal(result.text, code);
        assert.match(result.html, /<br>/);
        assert.equal(result.saved, 1);
        assert.match(await f.progress(), /已填入/);
    } finally { await f.browser.close(); }
});

test('UEditor verifies rich HTML line breaks rather than a lossy getContentTxt string', { timeout: 15000 }, async () => {
    const editor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const f = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', editor), { type: 'text', answers: [code], needsReview: false }, () => {
        let html = '旧答案';
        window.UE = { getEditor: () => ({
            getContent: () => html,
            getContentTxt: () => { const n = document.createElement('div'); n.innerHTML = html; return n.textContent; },
            setContent: value => { html = value; },
            sync: () => { document.querySelector('textarea').value = html; }, fireEvent: () => {}
        }) };
    });
    try {
        await f.start();
        assert.match(await f.progress(), /已填入/);
        assert.equal(await f.page.evaluate(() => window.saved), 1);
        assert.match(await f.page.locator('.questionLi textarea').inputValue(), /<br>/);
    } finally { await f.browser.close(); }
});

test('editor failure restores original content and does not pretend a hidden textarea is the visible answer', { timeout: 15000 }, async () => {
    const editor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const f = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', editor), { type: 'text', answers: [code], needsReview: false }, () => {
        let html = '旧答案';
        window.UE = { getEditor: () => ({
            getContent: () => html,
            setContent: value => { html = value; if (value !== '旧答案') throw new Error('Fixture editor rejected update'); },
            sync: () => { document.querySelector('textarea').value = html; }
        }) };
    });
    try {
        await f.start();
        assert.match(await f.progress(), /未填入/);
        assert.equal(await f.page.evaluate(() => UE.getEditor('answerEditor6').getContent()), '旧答案');
        assert.equal(await f.page.locator('.questionLi textarea').inputValue(), '旧答案');
        assert.equal(await f.page.evaluate(() => window.saved || 0), 0);
    } finally { await f.browser.close(); }
    const iframeEditor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea><iframe id="editor" srcdoc="<!doctype html><body>旧答案</body>"></iframe></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const blocked = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', iframeEditor), { type: 'text', answers: [code], needsReview: false }, () => {
        const body = document.querySelector('#editor').contentDocument.body;
        body.addEventListener('input', () => { document.querySelector('textarea').value = 'rejected update'; body.innerHTML = '旧答案'; });
    });
    try {
        await blocked.start();
        assert.match(await blocked.progress(), /未填入/);
        assert.equal(await blocked.page.evaluate(() => document.querySelector('#editor').contentDocument.body.textContent), '旧答案');
        assert.equal(await blocked.page.locator('.questionLi textarea').inputValue(), '旧答案');
        assert.equal(await blocked.page.evaluate(() => window.saved || 0), 0);
    } finally { await blocked.browser.close(); }
});
