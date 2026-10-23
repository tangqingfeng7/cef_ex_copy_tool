const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');
const fixtureKey = 'fixture-only-not-a-real-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const ok = answer => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer || { type: 'single', choices: ['A'], needsReview: false }) } }] });
const binary = fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll'));
const shim = decodeResource(readResource(binary, 10, 201)).toString('utf8');
const dat = decodeResource(readResource(binary, 10, 202)).toString('utf8');

test('DeepSeek DLL multimodal adapter: structure, cost guards, stale results, cancellation and safe fill', { timeout: 45000 }, async t => {
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', req.url === '/image.png' ? 'image/png' : 'text/html'); res.end(req.url === '/image.png' ? png : '<!doctype html><textarea id="answer"></textarea><div id="rich" contenteditable="true"></div><div id="question">Question</div>'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.evaluate(shim);
        assert.equal(await page.evaluate(() => __cefDeepSeek.enabled()), false);
        await page.evaluate(key => {
            window.fixtureConfig = { enabled: true, apiKey: key, baseUrl: 'https://ai.fixture.invalid', concurrency: 1 };
            __cefDeepSeek.configure(fixtureConfig);
            window.ask = async data => { try { return await __cefDeepSeek.answer(data); } catch (e) { return { code: e.code }; } };
            window.single = question => ({ question, options: ['Alpha', 'Beta'], type: 0 });
        }, fixtureKey);
        let mode = 'ok', count = 0, active = 0, maxActive = 0, hold, custom;
        const requests = [];
        await page.route('https://ai.fixture.invalid/**', async route => {
            count++; active++; maxActive = Math.max(maxActive, active);
            requests.push({ headers: route.request().headers(), body: JSON.parse(route.request().postData()) });
            try {
                if (mode === 'network') return await route.abort('failed');
                if (mode === 'hold') await new Promise(resolve => { hold = resolve; });
                if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 60));
                if (mode === 'unauthorized') return await route.fulfill({ status: 401, body: '{}' });
                let body = ok();
                if (mode === 'invalid') body = ok({ type: 'single', choices: ['Z'], needsReview: false });
                if (mode === 'review') body = ok({ type: 'single', choices: ['A'], needsReview: true });
                if (mode === 'html') body = ok({ type: 'text', answers: ['<img src=x onerror=alert(1)>'], needsReview: false });
                if (mode === 'custom') body = ok(custom);
                await route.fulfill({ status: 200, contentType: 'application/json', body });
            } finally { active--; }
        });
        const imageHeaders = [];
        page.on('request', r => { if (r.url().endsWith('/image.png')) imageHeaders.push(r.headers()); });
        await t.test('images are bytes, not URL placeholders; credentials only go to API; dedup and cache', async () => {
            const result = await page.evaluate(async () => {
                const data = single('Which image?'); data.images = [location.origin + '/image.png'];
                return Promise.all([ask(data), ask(Object.assign({}, data))]);
            });
            assert.equal(result[0].success, true); assert.equal(result[1].success, true); assert.equal(count, 1);
            await page.evaluate(() => ask({ ...single('Which image?'), images: [location.origin + '/image.png'] }));
            assert.equal(count, 1);
            const request = requests[0];
            assert.equal(request.body.model, 'deepseek-flash');
            assert.deepEqual(request.body.response_format, { type: 'json_object' });
            assert(request.body.messages[1].content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,')));
            assert.equal(request.headers.authorization, 'Bearer ' + fixtureKey);
            assert(imageHeaders.length > 0); assert(imageHeaders.every(h => !h.authorization));
            const status = await page.evaluate(() => __cefDeepSeek.status());
            assert(!JSON.stringify(status).includes(fixtureKey));
        });
        await t.test('401, invalid choices and network failure never loop paid requests', async () => {
            for (const [m, code] of [['unauthorized', 'HTTP_401'], ['invalid', 'FORMAT'], ['network', 'NETWORK']]) {
                mode = m; const before = count;
                for (let i = 0; i < 2; i++) assert.equal((await page.evaluate(q => ask(single(q)), m)).code, code);
                assert.equal(count, before + 1, m + ' stays blocked until explicit retry');
            }
            mode = 'ok'; await page.evaluate(() => __cefDeepSeek.clear());
            assert.equal((await page.evaluate(() => ask(single('network')))).success, true);
        });
        await t.test('a schema-valid answer carrying needsReview remains usable and exposes the hint', async () => {
            await page.evaluate(() => __cefDeepSeek.configure(fixtureConfig)); mode = 'review';
            const result = await page.evaluate(() => ask(single('review-valid')));
            assert.deepEqual(result.list, [['A']]);
            assert.equal(result.needsReview, true);
            assert.match(result.msg, /建议核对/);
        });
        await t.test('bounded concurrency; stale DOM cannot fill; config change cancels', async () => {
            mode = 'delay'; maxActive = 0;
            await page.evaluate(() => Promise.all(['q1', 'q2', 'q3'].map(q => ask(single(q)))));
            assert.equal(maxActive, 1);
            mode = 'hold';
            await page.evaluate(() => { window.result = ask({ ...single('stale'), root: document.querySelector('#question') }); });
            while (!hold) await new Promise(r => setTimeout(r, 10));
            await page.evaluate(() => { document.querySelector('#question').textContent = 'Changed'; });
            mode = 'ok'; hold(); hold = null;
            assert.equal((await page.evaluate(() => result)).code, 'STALE');
            mode = 'hold';
            await page.evaluate(() => { window.result = ask(single('cancel')); });
            while (!hold) await new Promise(r => setTimeout(r, 10));
            await page.evaluate(() => __cefDeepSeek.configure({ ...fixtureConfig, model: 'changed-model-fixture' }));
            assert.equal((await page.evaluate(() => result)).code, 'CANCELED');
            mode = 'ok'; hold(); hold = null;
        });
        await t.test('safe text preserves literal HTML, refuses overwrite, and never stores key in page localStorage', async () => {
            mode = 'html';
            const result = await page.evaluate(async () => {
                const data = { question: 'text question', type: 4, options: [] }, r = await ask(data);
                const input = document.querySelector('#answer'), rich = document.querySelector('#rich');
                return { success: r.success, filled: __cefDeepSeek.fillText(input, r.list[0][0]), value: input.value,
                    overwrite: __cefDeepSeek.fillText(input, 'overwrite'), rich: __cefDeepSeek.fillText(rich, r.list[0][0]), children: rich.children.length };
            });
            assert.equal(result.success, true); assert.equal(result.filled, true); assert.equal(result.overwrite, false);
            assert.equal(result.value, '<img src=x onerror=alert(1)>'); assert.equal(result.children, 0);
            await page.keyboard.press('Control+g');
            assert.equal(await page.locator('#cef-deepseek-settings').count(), 1);
            assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes(fixtureConfig.apiKey)), false);
            await page.evaluate(() => __cefDeepSeek.configure({ enabled: true }));
            assert.equal((await page.evaluate(() => ask(single('no key')))).code, 'NO_KEY');
        });
        await t.test('multi-choice, judge and blank counts are validated without text cleanup', async () => {
            await page.evaluate(() => __cefDeepSeek.configure(fixtureConfig)); mode = 'custom';
            custom = { type: 'multiple', choices: ['A', 'B'], needsReview: false };
            assert.deepEqual((await page.evaluate(() => ask({ ...single('multi'), type: 1 }))).list, [['A', 'B']]);
            custom = { type: 'judge', answers: ['正确'], needsReview: false };
            assert.deepEqual((await page.evaluate(() => ask({ question: 'judge', options: ['正确', '错误'], type: 3 }))).list, [['正确']]);
            custom = { type: 'blank', answers: ['3.14', 'a.b "quoted"'], needsReview: false };
            assert.deepEqual((await page.evaluate(() => ask({ question: 'blanks', options: [], type: 2, $options: { length: 2 } }))).list, [['3.14', 'a.b "quoted"']]);
            assert.equal((await page.evaluate(() => ask({ question: 'bad blanks', options: [], type: 2, $options: { length: 3 } }))).code, 'FORMAT');
        });
        await t.test('timeout is canceled once and stays blocked; unsafe URL is rejected', async () => {
            await page.evaluate(() => __cefDeepSeek.configure({ ...fixtureConfig, timeoutMs: 5000 }));
            mode = 'hold'; const before = count;
            const result = await page.evaluate(() => ask(single('timeout')));
            assert.equal(result.code, 'TIMEOUT');
            assert.equal((await page.evaluate(() => ask(single('timeout')))).code, 'TIMEOUT');
            assert.equal(count, before + 1); mode = 'ok'; hold(); hold = null;
            const code = await page.evaluate(() => { try { __cefDeepSeek.configure({ ...fixtureConfig, baseUrl: 'http://unsafe.example' }); } catch (e) { return e.code; } });
            assert.equal(code, 'CONFIG');
        });
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('actual DLL entry uses AI-only image answer and does not call original answer API', { timeout: 40000 }, async () => {
    const html = '<!doctype html><meta charset="utf-8"><div class="questionLi"><h3>1. Choose Alpha <img src="/image.png"></h3><input type="hidden" value="0"><div class="stem_answer"><div class="answerBg" id="optionA"><span class="answer_p">Alpha</span></div><div class="answerBg"><span class="answer_p">Beta</span></div></div></div>';
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', req.url === '/image.png' ? 'image/png' : 'text/html;charset=utf-8'); res.end(req.url === '/image.png' ? png : html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(), requests = [], errors = [], ai = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
            const r = route.request(), u = new URL(r.url());
            if (u.hostname === '127.0.0.1') return route.continue();
            if (u.hostname === 'ai.fixture.invalid') { ai.push(JSON.parse(r.postData())); return route.fulfill({ status: 200, contentType: 'application/json', body: ok() }); }
            requests.push(u.pathname);
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(u.hostname === 'scriptcat.org' ? { data: { name: 'fixture', script: { version: '0.0.0' } } } : { code: 0, result: [] }) });
        });
        await page.goto('http://127.0.0.1:' + server.address().port + '/mooc2/work/dowork');
        await page.evaluate(key => {
            window.__CX_AI_CONFIG__ = { enabled: true, apiKey: key, mode: 'ai-only', baseUrl: 'https://ai.fixture.invalid' };
            for (const [k, v] of Object.entries({ __wngm___delay: '20', __wngm_search_delay: '0', __wngm___fillAnswerDelay: '5', __wngm_auto_jump: 'false' })) localStorage.setItem(k, v);
            document.querySelector('#optionA').onclick = () => { window.selected = 'Alpha'; };
        }, fixtureKey);
        await page.evaluate(fs.readFileSync(path.join(root, 'scripts/userscript_boot.js'), 'utf8'));
        await page.evaluate('window.__cefInjectionAllowed=window.__cefBeginUserScriptInjection();');
        await page.evaluate(code => __cefEvaluateScript('gm_shim.js', code), shim);
        await page.evaluate(code => __cefEvaluateScript('dat.js', code), 'window.__cefRunUserScript(function(){return(function($,jQuery){' + dat + '\n}).call(window,__wnJQ,__wnJQ);});');
        await page.waitForFunction(() => window.selected === 'Alpha', null, { timeout: 20000 });
        assert.equal(ai.length, 1);
        assert(ai[0].messages[1].content.some(c => c.type === 'image_url'));
        assert(!requests.some(p => /autoFreeAnswer|reportOnline/.test(p)));
        assert.equal(await page.evaluate(() => typeof __CX_AI_CONFIG__), 'undefined');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
