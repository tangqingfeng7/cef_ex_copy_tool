const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');

test('actual DLL popup: Ctrl+G toggle, opacity, dragging, focus, click-through and small viewport', { timeout: 30000 }, async () => {
    const shim = decodeResource(readResource(fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')), 10, 201)).toString('utf8');
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:repeating-linear-gradient(45deg,#d8e8f8,#d8e8f8 30px,#f7fafc 30px,#f7fafc 60px);height:100vh;font:18px sans-serif}button#pageButton{position:absolute;left:700px;top:150px}</style><h1>Local popup fixture</h1><p>Ctrl+G · draggable panel · 50% opacity</p><input id="pageInput"><button id="pageButton" onclick="window.clicked=(window.clicked||0)+1">Page remains clickable</button>');
        await page.evaluate(shim);
        const host = page.locator('#cef-deepseek-settings');
        await page.locator('#pageInput').focus();
        await page.keyboard.press('Control+Alt+k'); assert.equal(await host.count(), 0, 'old hotkey removed');
        await page.keyboard.press('Control+g'); await host.waitFor({ state: 'visible' });
        assert.equal(await host.evaluate(e => e.style.opacity), '0.5');
        assert.equal(await host.locator('#opacityLabel').textContent(), '50%');
        assert.equal(await host.locator('section').getAttribute('aria-modal'), 'false');
        const first = await host.boundingBox(); assert(first.width <= 340 && first.height <= 533);
        await page.locator('#pageButton').click(); assert.equal(await page.evaluate(() => clicked), 1, 'no full-page input-blocking overlay');
        await host.locator('#key').fill('unsaved-fixture-key');
        await page.keyboard.press('Control+g'); await host.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => document.activeElement.id), 'pageInput');
        assert.equal(await host.locator('#key').inputValue(), '', 'hidden password field cleared');
        await page.keyboard.press('Control+g'); await host.waitFor({ state: 'visible' });
        await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, repeat: true, bubbles: true })));
        assert.equal(await host.isVisible(), true, 'auto-repeat does not toggle');
        async function wheel(deltaY, ctrlKey = true) {
            return host.locator('section').evaluate((el, args) => { const e = new WheelEvent('wheel', { ...args, bubbles: true, composed: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; }, { deltaY, ctrlKey });
        }
        assert.equal(await wheel(-100), true); assert.equal(await host.evaluate(e => e.style.opacity), '0.6');
        assert.equal(await wheel(100, false), false); assert.equal(await host.evaluate(e => e.style.opacity), '0.6');
        for (let i = 0; i < 12; i++) await wheel(100);
        assert.equal(await host.evaluate(e => e.style.opacity), '0.1');
        for (let i = 0; i < 12; i++) await wheel(-100);
        assert.equal(await host.evaluate(e => e.style.opacity), '1');
        await host.locator('#titlebar').click({ button: 'right' }); assert.equal(await host.evaluate(e => e.style.opacity), '0.2');
        await host.locator('#titlebar').click({ button: 'right' }); assert.equal(await host.evaluate(e => e.style.opacity), '0.5');
        await host.locator('#opacity').fill('70'); assert.equal(await host.evaluate(e => e.style.opacity), '0.7');
        const title = await host.locator('#titlebar').boundingBox();
        await page.mouse.move(title.x + 35, title.y + 10); await page.mouse.down();
        await page.mouse.move(title.x + 180, title.y - 70, { steps: 8 }); await page.mouse.up();
        const moved = await host.boundingBox(); assert(moved.x > first.x + 90 && moved.y < first.y - 30, 'title drag works');
        await page.keyboard.press('Control+g'); await page.keyboard.press('Control+g');
        const reopened = await host.boundingBox(); assert.equal(reopened.x, moved.x); assert.equal(reopened.y, moved.y);
        assert.equal(await host.evaluate(e => e.style.opacity), '0.7');
        await page.screenshot({ path: path.join(root, 'out/popup-preview.png') });
        await page.setViewportSize({ width: 280, height: 300 });
        await page.waitForFunction(() => { const b = document.querySelector('#cef-deepseek-settings').getBoundingClientRect(); return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; });
        await host.locator('#dismiss').click(); await host.waitFor({ state: 'hidden' });
        await page.keyboard.press('Control+g'); await host.waitFor({ state: 'visible' });
        await page.keyboard.press('Escape'); await host.waitFor({ state: 'hidden' });
        assert.equal(await host.count(), 1, 'no duplicate panels/listeners');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
