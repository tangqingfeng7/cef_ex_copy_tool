const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const fix = fs.readFileSync(path.resolve(__dirname, '../scripts/clipboard_fix.js'), 'utf8');
test('paste survives document.open and CEF reinjection in editor documents', async () => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html'); res.end('<textarea></textarea>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.evaluate(fix);
        await page.evaluate(() => navigator.clipboard.writeText('lifecycle paste'));
        const sameDocument = await page.evaluate(() => {
            const previous = document;
            document.open();
            document.write('<textarea onpaste="window.blocked=true;return false"></textarea>');
            document.close();
            return previous === document;
        });
        assert.equal(sameDocument, true, 'test must reuse the Document object');
        await page.evaluate(fix); // The CEF on_load_end fallback.
        await page.locator('textarea').focus();
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('textarea').inputValue(), 'lifecycle paste');
        // Dynamic editor rewrites can occur after CEF's load callbacks too.
        await page.evaluate(() => {
            document.open();
            document.write('<textarea onpaste="return false"></textarea>');
            document.close();
        });
        await page.waitForFunction(() => !!document.getElementById('__cefClipboardStyle'));
        await page.locator('textarea').focus();
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('textarea').inputValue(), 'lifecycle paste', 'observer repairs after late document rewrite');
        await page.evaluate(() => {
            const editor = document.createElement('iframe'); editor.id = 'editor';
            document.body.appendChild(editor);
        });
        await page.waitForFunction(() => !!document.querySelector('#editor').contentWindow.__cefPasteFixRefresh);
        await page.evaluate(() => {
            const doc = document.querySelector('#editor').contentDocument;
            doc.open(); doc.write('<body onpaste="return false"></body>'); doc.close(); doc.designMode = 'on';
        });
        const editorBody = page.frameLocator('#editor').locator('body');
        await editorBody.click();
        await page.keyboard.press('Control+v');
        assert.equal(await editorBody.innerText(), 'lifecycle paste', 'designMode editor after document rewrite');
        for (let i = 0; i < 3; ++i) await page.evaluate(fix);
        await page.locator('textarea').fill(''); await page.locator('textarea').focus();
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('textarea').inputValue(), 'lifecycle paste', 'refresh must not duplicate insertion');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
