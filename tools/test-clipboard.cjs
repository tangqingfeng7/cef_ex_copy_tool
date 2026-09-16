const { chromium } = require('./transpile/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const root = path.resolve(__dirname, '..');
let fix = fs.readFileSync(path.join(root, 'scripts', 'clipboard_fix.js'), 'utf8');
if (process.argv[2]) {
    const binary = fs.readFileSync(process.argv[2]).toString('utf16le');
    const start = binary.indexOf('// Standalone paste repair, compatible with Chrome 70.');
    assert(start >= 0, 'DLL must contain the embedded repair');
    const embedded = binary.slice(start, binary.indexOf('\0', start));
    assert.equal(embedded.replace(/\r\n/g, '\n'), fix.replace(/\r\n/g, '\n'), 'embedded JS matches source');
    fix = embedded;
}
(async () => {
    const server = http.createServer((req, res) => (res.setHeader('Content-Type', 'text/html; charset=utf-8'), res.end('<textarea id="answer"></textarea>')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.evaluate(() => {
            window.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'v') e.preventDefault(); }, true);
            window.addEventListener('paste', e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
            document.querySelector('textarea').setAttribute('onpaste', 'return false');
            window.inputCount = 0;
            document.addEventListener('input', () => window.inputCount++);
        });
        await page.evaluate(() => navigator.clipboard.writeText('粘贴 test'));
        await page.locator('textarea').focus();
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('textarea').inputValue(), '', 'baseline must reproduce blocked paste');
        await page.evaluate(fix);
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('textarea').inputValue(), '粘贴 test');
        assert.equal(await page.evaluate(() => inputCount), 1, 'input event must reach application');
        await page.keyboard.press('Control+z');
        assert.equal(await page.locator('textarea').inputValue(), '', 'undo must work');
        await page.locator('textarea').fill('abcd');
        await page.evaluate(() => document.querySelector('textarea').setSelectionRange(1, 3));
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('textarea').inputValue(), 'a粘贴 testd', 'replace selection exactly once');
        await page.evaluate(fix);
        await page.locator('textarea').fill('');
        await page.keyboard.press('Shift+Insert');
        assert.equal(await page.locator('textarea').inputValue(), '粘贴 test', 'repeat install and Shift+Insert');
        await page.evaluate(() => {
            const el = document.querySelector('textarea');
            el.readOnly = true;
        });
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('textarea').inputValue(), '粘贴 test', 'readonly must remain protected');
        await page.evaluate(() => {
            const frame = document.createElement('iframe');
            frame.srcdoc = '<textarea onpaste="return false"></textarea>';
            document.body.appendChild(frame);
        });
        const frameInput = page.frameLocator('iframe').locator('textarea');
        await frameInput.waitFor();
        await page.waitForFunction(() => document.querySelector('iframe').contentWindow.__cefPasteFixDocument);
        await frameInput.focus();
        await page.keyboard.press('Control+v');
        assert.equal(await frameInput.inputValue(), '粘贴 test', 'dynamic iframe');
        await page.evaluate(() => {
            const rich = document.createElement('div');
            rich.id = 'rich';
            rich.contentEditable = 'true';
            document.body.appendChild(rich);
        });
        await page.locator('#rich').focus();
        await page.keyboard.press('Control+v');
        assert.equal(await page.locator('#rich').innerText(), '粘贴 test', 'contenteditable');
        await page.evaluate(() => {
            const el = document.querySelector('textarea');
            el.readOnly = false;
            el.value = '';
            el.maxLength = 3;
        });
        await page.locator('textarea').focus();
        await page.keyboard.press('Control+v');
        assert.equal((await page.locator('textarea').inputValue()).length, 3, 'maxlength');
        await page.evaluate(() => {
            const el = document.querySelector('textarea'); el.blur(); el.readOnly = true;
        });
        await page.locator('textarea').focus();
        assert.equal(await page.locator('textarea').evaluate(el => el.readOnly), true, 'focus must not strip readonly');
        await page.keyboard.press('Control+v');
        assert.equal((await page.locator('textarea').inputValue()).length, 3);
        assert.equal(await page.evaluate(() => {
            let calls = 0; const el = document.querySelector('textarea');
            const listener = () => calls++;
            el.addEventListener('paste', listener); el.removeEventListener('paste', listener);
            el.dispatchEvent(new Event('paste', { bubbles: true })); return calls;
        }), 0, 'listener removal retains identity');
        await page.evaluate(() => document.querySelector('iframe').srcdoc = '<textarea></textarea>');
        await page.waitForFunction(() => {
            const w = document.querySelector('iframe').contentWindow;
            return w.__cefPasteFixDocument === w.document && !!w.document.querySelector('textarea');
        });
        await frameInput.focus(); await page.keyboard.press('Control+v');
        assert.equal(await frameInput.inputValue(), '粘贴 test', 'iframe navigation reinstalls');
        assert.equal(await page.evaluate(() => typeof window.__cefPasteFixTimer), 'undefined', 'no frame polling');
        console.log('PASS: baseline reproduction, blocked paste, input event, undo, selection, Shift+Insert, idempotence, readonly, dynamic iframe, contenteditable, maxlength');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(e => { console.error(e); process.exitCode = 1; });

