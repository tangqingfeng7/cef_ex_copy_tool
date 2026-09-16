const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const fix = fs.readFileSync(path.resolve(__dirname, '../scripts/clipboard_fix.js'), 'utf8');
test('agreement controls avoid forced selection and mouse outline while keyboard focus remains visible', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<style>:focus{outline:2px solid blue}p{user-select:none}</style>' +
            '<p id="question">Question text</p><label tabindex="0" id="agree"><input type="checkbox"><span>Agreement</span></label>' +
            '<button id="enter">Enter</button><label>Answer<textarea></textarea></label>');
        await page.evaluate(fix);
        assert.equal(await page.locator('#question').evaluate(el => getComputedStyle(el).userSelect), 'text');
        assert.equal(await page.locator('#agree span').evaluate(el => getComputedStyle(el).userSelect), 'none');
        assert.equal(await page.locator('textarea').evaluate(el => getComputedStyle(el).userSelect), 'text');
        await page.locator('#agree span').click();
        assert.equal(await page.locator('input').isChecked(), true);
        await page.locator('#agree').focus();
        assert.equal(await page.locator('#agree').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('html').getAttribute('data-cef-pointer-mode'), null);
        await page.locator('#agree').focus();
        assert.equal(await page.locator('#agree').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
        await page.locator('#agree span').click();
        assert.equal(await page.locator('input').isChecked(), false);
        await page.locator('#enter').click();
        assert.equal(await page.locator('#enter').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
        await page.evaluate(() => {
            const question = document.createElement('div'); question.id = 'question-block'; question.tabIndex = 0;
            question.innerHTML = '<span>Selectable question text</span>';
            document.body.appendChild(question);
            const editor = document.createElement('div'); editor.id = 'editable-block'; editor.contentEditable = 'true';
            editor.textContent = 'Editor text'; document.body.appendChild(editor);
            document.querySelector('textarea').style.border = '1px solid rgb(100, 150, 200)';
        });
        for (const selector of ['#question-block span', '#editable-block']) {
            await page.locator(selector).click();
            await page.keyboard.press('Control+c');
            assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
        }
        await page.locator('#question-block').evaluate(el => {
            const range = document.createRange(); range.selectNodeContents(el);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
        assert.equal(await page.evaluate(() => getSelection().toString()), 'Selectable question text');
        await page.locator('textarea').click();
        assert.equal(await page.locator('textarea').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(100, 150, 200)');
        await page.keyboard.press('Tab');
        await page.locator('#question-block').focus();
        assert.equal(await page.locator('#question-block').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    } finally { await browser.close(); }
});
