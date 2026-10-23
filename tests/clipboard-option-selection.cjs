const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const binary = fs.readFileSync(dll).toString('utf16le');
const start = binary.indexOf('// Standalone paste repair, compatible with Chrome 70.');
assert(start >= 0);
const fix = binary.slice(start, binary.indexOf('\0', start));
async function fixture() {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif}.answerBg{width:480px;padding:14px;user-select:none}.answer_p{display:inline-block}label{user-select:none}</style><div class="questionLi"><h3>多选题题干</h3><div class="answerBg" role="checkbox" onclick="window.choiceClicks=(window.choiceClicks||0)+1"><label><input type="checkbox"><span class="answer_p">A 儿女的柔情与长调</span></label></div></div><label id="agreement"><input type="checkbox"><span>用户协议</span></label><button id="normal" onclick="window.normalClicks=(window.normalClicks||0)+1">普通按钮</button>' }));
    await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/option-copy');
    await page.evaluate(() => {
        document.querySelector('.answerBg').addEventListener('mousedown', e => e.preventDefault());
        document.querySelector('.answerBg').addEventListener('selectstart', e => e.preventDefault());
    });
    await page.evaluate(fix);
    return { browser, page };
}
async function dragText(page, selector) {
    const b = await page.locator(selector).boundingBox();
    await page.mouse.move(b.x + 1, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 15 });
    await page.mouse.up();
}

test('option labels can be drag-selected and copied without selecting an answer, while plain clicks still select', async () => {
    const f = await fixture();
    try {
        assert.equal(await f.page.locator('.answer_p').evaluate(x => getComputedStyle(x).userSelect), 'text');
        await dragText(f.page, '.answer_p');
        const selected = await f.page.evaluate(() => getSelection().toString());
        assert.match(selected, /儿女的柔情与长调/);
        await f.page.keyboard.press('Control+c');
        assert.equal(await f.page.evaluate(() => navigator.clipboard.readText()), selected);
        assert.equal(await f.page.evaluate(() => window.choiceClicks || 0), 0, 'drag-to-copy must not trigger an option click');
        assert.equal(await f.page.locator('.answerBg input').isChecked(), false);
        await f.page.locator('.answer_p').click();
        assert.equal(await f.page.evaluate(() => window.choiceClicks), 2, 'a native label click also dispatches a click to its associated input');
        assert.equal(await f.page.locator('.answerBg input').isChecked(), true);
        assert.equal(await f.page.locator('#agreement span').evaluate(x => getComputedStyle(x).userSelect), 'none');
        await f.page.locator('#agreement span').click();
        assert.equal(await f.page.locator('#agreement input').isChecked(), true);
        await f.page.locator('#normal').click();
        assert.equal(await f.page.evaluate(() => window.normalClicks), 1);
    } finally { await f.browser.close(); }
});

test('dynamically added options are selectable and programmatic/keyboard option activation is not blocked', async () => {
    const f = await fixture();
    try {
        await f.page.evaluate(() => {
            const row = document.createElement('div'); row.className = 'answerBg'; row.setAttribute('role', 'button');
            row.innerHTML = '<span class="answer_p">B 既有诗的美感，也有词的美感</span>';
            row.onclick = () => { window.dynamicClicks = (window.dynamicClicks || 0) + 1; };
            document.querySelector('.questionLi').appendChild(row);
        });
        assert.equal(await f.page.locator('.answer_p').last().evaluate(x => getComputedStyle(x).userSelect), 'text');
        await dragText(f.page, '.answerBg:last-child .answer_p');
        assert.match(await f.page.evaluate(() => getSelection().toString()), /也有词的美感/);
        assert.equal(await f.page.evaluate(() => window.dynamicClicks || 0), 0);
        const clicks = await f.page.evaluate(() => {
            const row = document.querySelectorAll('.answerBg')[1]; row.click();
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
            return window.dynamicClicks;
        });
        assert.equal(clicks, 2, 'AI/programmatic and keyboard-style clicks remain functional after a drag');
    } finally { await f.browser.close(); }
});
