const { chromium } = require('./transpile/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const root = path.resolve(__dirname, '..');
let fix = fs.readFileSync(path.join(root, 'scripts', 'clipboard_fix.js'), 'utf8');
let shim;
if (process.argv[2]) {
    const { readResource } = require('./embedded-resources.cjs');
    const { decodeResource } = require('./resource-codec.cjs');
    const dll = fs.readFileSync(process.argv[2]);
    const binary = dll.toString('utf16le');
    const start = binary.indexOf('// Standalone paste repair, compatible with Chrome 70.');
    assert(start >= 0, 'DLL must contain the embedded repair');
    const embedded = binary.slice(start, binary.indexOf('\0', start));
    assert.equal(embedded.replace(/\r\n/g, '\n'), fix.replace(/\r\n/g, '\n'), 'embedded JS matches source');
    fix = embedded;
    shim = decodeResource(readResource(dll, 10, 201)).toString('utf8');
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
            window.addEventListener('keydown', e => {
                if (e.ctrlKey && /^[cvx]$/i.test(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
            }, true);
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
        await page.evaluate(async () => {
            const email = document.createElement('input');
            email.type = 'email'; email.id = 'email'; email.setAttribute('onpaste', 'return false');
            document.body.appendChild(email);
            await navigator.clipboard.writeText('person@example.test');
        });
        await page.locator('#email').press('Control+v');
        assert.equal(await page.locator('#email').inputValue(), 'person@example.test', 'blocked email input uses native paste');
        await page.evaluate(() => navigator.clipboard.writeText('粘贴 test'));
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
        await page.evaluate(async () => {
            const el = document.querySelector('textarea');
            el.readOnly = false; el.value = '复制与剪切'; el.focus(); el.select();
            window.copyShortcuts = 0;
            document.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'c') window.copyShortcuts++; });
            await navigator.clipboard.writeText('sentinel');
        });
        await page.keyboard.press('Control+c');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '复制与剪切', 'host cannot cancel copy');
        assert.equal(await page.evaluate(() => copyShortcuts), 1, 'copy shortcut still reaches the document listener');
        await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
        await page.keyboard.press('Control+x');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '复制与剪切', 'host cannot cancel cut');
        assert.equal(await page.locator('textarea').inputValue(), '', 'cut removes the selection');
        if (shim) {
            await page.evaluate(() => {
                window.__CX_AI_CONFIG__ = { enabled: false, panelOpacity: 0.5 };
                window.addEventListener('contextmenu', e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
            });
            await page.evaluate(shim);
            await page.evaluate(() => __cefDeepSeek.openSettings());
            const panel = page.locator('#cef-deepseek-settings');
            await page.evaluate(() => navigator.clipboard.writeText('fixture-key'));
            await panel.locator('#key').press('Control+v');
            assert.equal(await panel.locator('#key').inputValue(), 'fixture-key', 'native paste reaches the panel input');
            await panel.locator('#tabChat').click();
            await page.evaluate(async () => {
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
                const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': image, 'text/plain': new Blob(['附图文字'], { type: 'text/plain' }) })]);
            });
            await panel.locator('#chatInput').press('Control+v');
            await panel.locator('#chatImages').waitFor();
            assert.equal(await panel.locator('#chatInput').inputValue(), '附图文字', 'panel inserts image clipboard text once');
            await panel.locator('#titlebar').click({ button: 'right' });
            assert.equal(await panel.evaluate(el => el.style.opacity), '0.2', 'right click reaches the panel opacity handler');
        }
        console.log('PASS: native clipboard shortcuts, undo, selection, readonly, iframe, contenteditable and maxlength' + (shim ? ', panel text/image paste and right click' : ''));
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(e => { console.error(e); process.exitCode = 1; });

