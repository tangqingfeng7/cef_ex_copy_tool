const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const code = fs.readFileSync(path.resolve(__dirname, '../out/js/dat.js'), 'utf8');
const metadata = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../out/js/metadata.json'), 'utf8'));
// Run the real bundled jQuery and its integration, stopping before network/API
// initialization. This isolates the exact bootstrap responsible for the failure.
const boundary = code.search(/\b(?:const|var|let) HTTP_STATUS =/);
assert(boundary > 0, 'userscript bootstrap boundary must be reviewed after upstream changes');
const bootstrap = code.slice(0, boundary) +
    'window.__scriptJQ = $; window.__scriptLater = function(){return $("#enter").length;};})();';

test('bundled jQuery preserves host plugins and button clicks', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        async function setup() {
            await page.goto('about:blank');
            await page.setContent('<button id="enter">Test entry</button>');
            await page.evaluate(value => { window.__cefUserScriptMetadata = value; }, metadata);
            await page.evaluate(() => {
                window.GM_getValue = (key, value) => value;
                window.entered = 0;
                window.hostJQ = function () { return Object.create(window.hostJQ.fn); };
                window.hostJQ.fn = { fullFadeIn() { window.entered++; } };
                window.$ = window.jQuery = window.hostJQ;
                document.querySelector('#enter').onclick = () => window.$('#enter').fullFadeIn();
            });
        }
        // Reproduce the deployed failure first, using the original assignment.
        await setup();
        const legacy = bootstrap.replace(/var \$ = jQuery\$1\.noConflict\(true\);\s*var jQuery = \$;/,
            'window.$ = window.jQuery = jQuery$1;');
        assert.notEqual(legacy, bootstrap);
        await page.evaluate(legacy);
        await page.click('#enter');
        assert.equal(await page.evaluate(() => entered), 0);
        assert(errors.some(message => message.includes('fullFadeIn is not a function')));
        errors.length = 0;

        await setup();
        await page.evaluate(bootstrap);
        await page.click('#enter');
        assert.equal(await page.evaluate(() => entered), 1);
        assert.equal(await page.evaluate(() => $ === hostJQ && jQuery === hostJQ), true);
        assert.equal(await page.evaluate(() => __scriptJQ === hostJQ), false);
        assert.equal(await page.evaluate(() => __scriptJQ.fn.jquery), '3.7.1');
        assert.equal(await page.evaluate(() => __scriptLater()), 1, 'later callbacks use private jQuery');
        assert.deepEqual(errors, []);

        await setup();
        await page.evaluate(() => { delete window.$; delete window.jQuery; });
        await page.evaluate(bootstrap);
        assert.equal(await page.evaluate(() => typeof $), 'undefined');
        assert.equal(await page.evaluate(() => typeof jQuery), 'undefined');
        assert.equal(await page.evaluate(() => __scriptLater()), 1);
    } finally { await browser.close(); }
});
