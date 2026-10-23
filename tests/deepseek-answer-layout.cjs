const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const code = '已填入：students = []\n' + Array.from({ length: 30 }, (_, i) => `    students.append(("学生${i}", 90, 82))`).join('\n') + '\nprint(students)\n<img src=x onerror=alert(1)>';
async function fixture(width = 1000) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width, height: 700 } });
    await page.setContent('<!doctype html><meta charset="utf-8">');
    await page.evaluate(decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8'));
    await page.evaluate(code => {
        __cefDeepSeek.openSettings();
        __cefDeepSeek.progress({ key: 'long', index: 1, question: '6.（简答题，5.0分）编程题', answer: code, state: 'success' });
        __cefDeepSeek.progress({ key: 'short', index: 2, question: '选择题', answer: '已填入：B', state: 'success' });
    }, code);
    return { browser, page };
}

test('long/code answers occupy a full readable row below the question without an inner height limit', async () => {
    const f = await fixture();
    try {
        const values = await f.page.evaluate(() => {
            const r = document.querySelector('#cef-deepseek-settings').shadowRoot;
            const row = r.querySelector('#progressBody tr'), cells = row.querySelectorAll('td'), text = cells[2].querySelector('.answer-value');
            return { width: text.getBoundingClientRect().width, font: parseFloat(getComputedStyle(text).fontSize),
                maxHeight: getComputedStyle(text).maxHeight, height: text.clientHeight, scrollHeight: text.scrollHeight,
                top: cells[2].getBoundingClientRect().top, questionBottom: cells[1].getBoundingClientRect().bottom,
                text: text.textContent, images: text.querySelectorAll('img').length,
                label: cells[2].querySelector('.answer-label')?.textContent,
                shortLong: r.querySelectorAll('#progressBody tr')[1].classList.contains('long-answer-row') };
        });
        assert(values.width >= 250, 'a code answer cannot remain in the old 94px column');
        assert(values.font >= 14);
        assert.equal(values.maxHeight, 'none');
        assert.equal(values.height, values.scrollHeight, 'use the main panel scroll, not a tiny nested scrollbox');
        assert(values.top >= values.questionBottom - 1);
        assert.equal(values.text, code);
        assert.equal(values.images, 0);
        assert.equal(values.label, '答案');
        assert.equal(values.shortLong, false, 'short choice answers keep the compact row');
    } finally { await f.browser.close(); }
});

test('narrow viewports keep the wide answer within the panel and status updates can switch layout without losing text', async () => {
    const f = await fixture(280);
    try {
        const values = await f.page.evaluate(() => {
            const r = document.querySelector('#cef-deepseek-settings').shadowRoot, t = r.querySelector('.answer-value');
            const box = t.getBoundingClientRect(), host = document.querySelector('#cef-deepseek-settings').getBoundingClientRect();
            return { width: box.width, left: box.left, right: box.right, hostRight: host.right, font: parseFloat(getComputedStyle(t).fontSize) };
        });
        assert(values.width >= 200);
        assert(values.left >= 0 && values.right <= values.hostRight + 1 && values.hostRight <= 280);
        assert(values.font >= 14);
        const result = await f.page.evaluate(() => {
            __cefDeepSeek.progress({ key: 'long', answer: '请求中…', state: 'pending' });
            const r = document.querySelector('#cef-deepseek-settings').shadowRoot;
            const compact = !r.querySelector('#progressBody tr').classList.contains('long-answer-row');
            __cefDeepSeek.progress({ key: 'long', answer: '这是一段超过长度阈值的完整简答内容。'.repeat(10), state: 'success' });
            return { compact, wide: r.querySelector('#progressBody tr').classList.contains('long-answer-row'),
                text: r.querySelector('.answer-value').textContent };
        });
        assert.equal(result.compact, true); assert.equal(result.wide, true);
        assert.equal(result.text, '这是一段超过长度阈值的完整简答内容。'.repeat(10));
    } finally { await f.browser.close(); }
});
