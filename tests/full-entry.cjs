const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');

test('complete DLL script entry works with offline assets, mocked API, host plugins and reinjection', { timeout: 40000 }, async () => {
    const binary = fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll'));
    const shim = decodeResource(readResource(binary, 10, 201)).toString('utf8');
    const dat = decodeResource(readResource(binary, 10, 202)).toString('utf8');
    const boot = fs.readFileSync(path.join(root, 'scripts/userscript_boot.js'), 'utf8');
    const diagnostics = fs.readFileSync(path.join(root, 'scripts/diagnostics.js'), 'utf8');
    const html = '<!doctype html><meta charset="utf-8"><button id="enter">Host entry</button>' +
        '<div class="questionLi"><h3>1. Local fixture: choose Alpha</h3><input type="hidden" value="0">' +
        '<div class="stem_answer"><div class="answerBg" id="optionA"><span class="answer_p">Alpha</span></div>' +
        '<div class="answerBg" id="optionB"><span class="answer_p">Beta</span></div></div></div>';
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const context = await browser.newContext();
        const requests = [], cdn = [], errors = [];
        await context.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (url.hostname === '127.0.0.1') return route.continue();
            if (url.hostname.includes('jsdelivr')) { cdn.push(url.href); return route.abort(); }
            requests.push({ method: request.method(), path: url.pathname, body: request.postData() });
            let result = { code: 0, result: [] };
            if (url.pathname.endsWith('/autoFreeAnswer')) result = { code: 0, result: { success: false, answers: [['Alpha']], num: -1 } };
            if (url.hostname === 'scriptcat.org') result = { data: { name: 'fixture', script: { version: '0.0.0' } } };
            return route.fulfill({ status: 200, contentType: 'application/json', headers: {
                'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS'
            }, body: JSON.stringify(result) });
        });
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://127.0.0.1:' + server.address().port + '/mooc2/work/dowork');
        await page.evaluate(() => {
            localStorage.setItem('__wngm___delay', '20');
            localStorage.setItem('__wngm_search_delay', '0');
            localStorage.setItem('__wngm___fillAnswerDelay', '5');
            localStorage.setItem('__wngm_auto_jump', 'false');
            window.entered = 0;
            window.hostJQ = function () { return Object.create(window.hostJQ.fn); };
            window.hostJQ.fn = { fullFadeIn() { window.entered++; } };
            window.$ = window.jQuery = window.hostJQ;
            document.querySelector('#enter').onclick = () => window.$('#enter').fullFadeIn();
            document.querySelector('#optionA').onclick = () => { window.fixtureSelected = 'Alpha'; };
        });
        const payload = 'window.__cefRunUserScript(function(){return (function($,jQuery){\n' + dat +
            '\n}).call(window,window.__wnJQ||window.$,window.__wnJQ||window.jQuery);});';
        async function inject() {
            await page.evaluate(boot); await page.evaluate(diagnostics);
            await page.evaluate(() => { window.__cefInjectionAllowed = window.__cefBeginUserScriptInjection(); });
            await page.evaluate(code => window.__cefEvaluateScript('gm_shim.js', code), shim);
            await page.evaluate(code => window.__cefEvaluateScript('dat.js', code), payload);
        }
        await inject();
        await page.waitForFunction(() => window.__cefUserScriptState.status === 'ready');
        await page.locator('#iframeNode').waitFor();
        await page.waitForFunction(() => window.fixtureSelected === 'Alpha', null, { timeout: 15000 });
        await page.locator('#enter').click({ force: true });
        assert.equal(await page.evaluate(() => entered), 1);
        assert.equal(await page.evaluate(() => $ === hostJQ && jQuery === hostJQ), true);
        assert.equal(await page.locator('#iframeNode').count(), 1);
        const state = await page.evaluate(() => __cefGetDiagnostics());
        assert.equal(state.userscript.status, 'ready');
        assert.equal(state.assets.Table, 'embedded'); assert.equal(state.assets.Img, 'embedded');
        assert(state.timings.totalMs >= 0);
        assert(requests.some(r => r.path.endsWith('/autoFreeAnswer')));
        assert.deepEqual(cdn, []);
        await inject();
        assert.equal(await page.locator('#iframeNode').count(), 1);
        assert.equal(await page.evaluate(() => __cefUserScriptState.attempts), 1);
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
