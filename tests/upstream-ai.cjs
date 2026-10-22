const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const root = path.resolve(__dirname, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const shim = decodeResource(readResource(fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')), 10, 201)).toString('utf8');
const dat = decodeResource(readResource(fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')), 10, 202)).toString('utf8');
const html = '<!doctype html><meta charset="utf-8"><div class="questionLi" data-question-id="one"><h3 class="mark_name">单选题：IMAGE choose Alpha <img src="/question.png"></h3><div class="answerBg" id="a">Alpha <img src="/option.png"></div><div class="answerBg" id="b">Beta</div></div>' +
    '<div class="questionLi" data-question-id="two"><h3 class="mark_name" id="copyTitle">简答题：TEXT answer</h3><textarea id="textAnswer"></textarea></div>' +
    '<div class="questionLi" data-question-id="three"><h3 class="mark_name">判断题：JUDGE false</h3><div class="answerBg" id="yes">对</div><div class="answerBg" id="no">错</div></div>';

test('copied upstream AI: auto collect and fill image questions, copy/click-fill, privacy and no legacy duplicate', { timeout: 35000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(), requests = [], imageAuth = [], other = [], errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
            const r = route.request(), u = new URL(r.url());
            if (u.hostname === 'mooc1.chaoxing.com') {
                if (u.pathname.endsWith('.png')) { imageAuth.push(r.headers().authorization); return route.fulfill({ contentType: 'image/png', body: png }); }
                return route.fulfill({ contentType: 'text/html;charset=utf-8', body: html });
            }
            if (u.hostname === 'ai.fixture.invalid') {
                const body = JSON.parse(r.postData()); requests.push(body);
                const prompt = body.messages[1].content[0].text;
                const content = prompt.includes('COPY-MARKER') ? '3.14 "quoted" _value_' : prompt.includes('TEXT') ?
                    JSON.stringify({ type: 'text', answers: ['<img src=x onerror=window.pwned=1>'], needsReview: false }) : prompt.includes('JUDGE') ?
                        JSON.stringify({ type: 'judge', answers: ['错'], needsReview: false }) :
                        JSON.stringify({ type: 'single', choices: ['A'], needsReview: false });
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
            }
            other.push(u.pathname);
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(u.hostname === 'scriptcat.org' ? { data: { name: 'fixture', script: { version: '0.0.0' } } } : { code: 0, result: [] }) });
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/fixture');
        await page.evaluate(() => {
            window.__CX_AI_CONFIG__ = { enabled: true, apiKey: 'fixture-only-not-a-real-key', baseUrl: 'https://ai.fixture.invalid', mode: 'ai-only' };
            document.querySelector('#a').onclick = () => { window.selectedA = true; };
            document.querySelector('#no').onclick = () => { window.selectedNo = true; };
        });
        await page.evaluate(shim);
        await page.evaluate(fs.readFileSync(path.join(root, 'scripts/userscript_boot.js'), 'utf8'));
        await page.evaluate(code => __cefRunUserScript(function () { return new Function('$', 'jQuery', code).call(window, __wnJQ, __wnJQ); }), dat);
        await page.waitForFunction(() => window.aiAnswersData && Object.keys(aiAnswersData).length === 3);
        await page.waitForFunction(() => window.selectedA && window.selectedNo && document.querySelector('#textAnswer').value);
        assert.equal(requests.length, 3);
        assert.equal(await page.evaluate(() => __cxUpstreamAI.sourceCommit), '3b534edae5208f1b3bdb256142491a6cd28de4a0');
        assert.equal(await page.evaluate(() => !!window.selectedA), true, 'enabled startup fills without a middle click');
        const imageRequest = requests.find(body => body.messages[1].content[0].text.includes('IMAGE'));
        assert.equal(imageRequest.model, 'deepseek-flash'); assert.deepEqual(imageRequest.response_format, { type: 'json_object' });
        const blocks = imageRequest.messages[1].content;
        assert.equal(blocks.filter(b => b.type === 'image_url' && b.image_url.url.startsWith('data:image/png;base64,')).length, 2);
        assert(blocks.some(b => b.type === 'text' && b.text.includes('选项 A')));
        assert(imageAuth.every(value => value === undefined), 'no AI authorization on image hosts');
        assert.equal(await page.evaluate(() => window.selectedA && window.selectedNo), true);
        assert.equal(await page.locator('#textAnswer').inputValue(), '<img src=x onerror=window.pwned=1>');
        assert.equal(await page.evaluate(() => !!window.pwned), false);
        assert(!other.some(p => /autoFreeAnswer|reportOnline/.test(p)), 'legacy worker does not send duplicate question requests');
        await page.locator('#textAnswer').fill('');
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '简答题 COPY-MARKER 3.14' } });
            const range = document.createRange(); range.selectNodeContents(document.querySelector('#copyTitle'));
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
        await page.keyboard.press('Control+c');
        await page.waitForFunction(() => window.copiedAIAnswer === '3.14 "quoted" _value_');
        await page.locator('#textAnswer').click();
        await page.waitForFunction(() => document.querySelector('#textAnswer').value === '3.14 "quoted" _value_');
        assert.equal(requests.length, 4, 'copy + Ctrl+C listeners merge into one request');
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-only-not-a-real-key')), false);
        await page.keyboard.press('Control+g'); assert.equal(await page.locator('#cef-deepseek-settings').isVisible(), true);
        assert.equal(await page.locator('#cef-deepseek-settings').evaluate(host => host.shadowRoot.querySelectorAll('#progressBody tr').length), 3);
        assert.equal(await page.evaluate(() => Array.from(document.body.children).some(node => node.style.position === 'fixed' && /AI答题/.test(node.textContent))), false);
        await page.keyboard.press('Control+g'); assert.equal(await page.locator('#cef-deepseek-settings').isHidden(), true);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('enabled AI waits for dynamically rendered questions and fills them automatically', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(); let requests = 0; const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.hostname === 'mooc1.chaoxing.com') return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8"><main id="app"></main>' });
            if (url.hostname === 'ai.fixture.invalid') {
                requests++;
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'single', choices: ['B'], needsReview: false }) } }] }) });
            }
            return route.fulfill({ contentType: 'application/json', body: '{}' });
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/dynamic');
        await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid' }; });
        await page.evaluate(shim);
        await page.evaluate(fs.readFileSync(path.join(root, 'scripts/userscript_boot.js'), 'utf8'));
        await page.evaluate(code => __cefRunUserScript(function () { return new Function('$', 'jQuery', code).call(window, __wnJQ, __wnJQ); }), dat);
        await page.evaluate(() => __cefDeepSeek.openSettings());
        assert.equal(requests, 0, 'no request is made before questions exist');
        await page.evaluate(() => {
            document.querySelector('#app').innerHTML = '<div class="questionLi" data-question-id="late"><h3 class="mark_name">单选题：dynamic</h3><div class="answerBg" id="lateA">A</div><div class="answerBg" id="lateB">B</div></div>';
            document.querySelector('#lateB').onclick = () => { window.dynamicFilled = true; };
        });
        await page.waitForFunction(() => window.dynamicFilled === true);
        assert.equal(requests, 1);
        assert.match(await page.locator('#cef-deepseek-settings').evaluate(host => host.shadowRoot.querySelector('#status').textContent), /逐题处理完成：1 道，写入 1 项/);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('AI fills a review-flagged blank answer, sends the question image and keeps the warning inside the panel', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(); let requestBody;
        const blankHtml = '<!doctype html><meta charset="utf-8"><div class="questionLi" data-question-id="blank">' +
            '<h3 class="mark_name">填空题：看图依次填写三空 <img src="/blank.png"></h3><input name="type0" type="hidden" value="2">' +
            '<div class="eidtDiv"><textarea></textarea></div><div class="eidtDiv"><textarea></textarea></div><div class="eidtDiv"><textarea></textarea></div></div>';
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.hostname === 'mooc1.chaoxing.com') {
                if (url.pathname === '/blank.png') return route.fulfill({ contentType: 'image/png', body: png });
                return route.fulfill({ contentType: 'text/html;charset=utf-8', body: blankHtml });
            }
            if (url.hostname === 'ai.fixture.invalid') {
                requestBody = JSON.parse(route.request().postData());
                const content = JSON.stringify({ type: 'blank', answers: ['第一空', '第二空', '第三空'], needsReview: true });
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
            }
            return route.fulfill({ contentType: 'application/json', body: '{}' });
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/blanks');
        await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid' }; });
        await page.evaluate(shim);
        await page.evaluate(fs.readFileSync(path.join(root, 'scripts/userscript_boot.js'), 'utf8'));
        await page.evaluate(code => __cefRunUserScript(function () { return new Function('$', 'jQuery', code).call(window, __wnJQ, __wnJQ); }), dat);
        await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).every(node => node.value));
        assert.deepEqual(await page.locator('textarea').evaluateAll(nodes => nodes.map(node => node.value)), ['第一空', '第二空', '第三空']);
        assert(requestBody.messages[1].content.some(item => item.type === 'image_url' && item.image_url.url.startsWith('data:image/png;base64,')));
        await page.evaluate(() => __cefDeepSeek.openSettings());
        assert.match(await page.locator('#cef-deepseek-settings').evaluate(host => host.shadowRoot.querySelector('#progressBody').textContent), /第一空；第二空；第三空（模型建议核对）/);
        assert.equal(await page.locator('#cef-deepseek-settings').evaluate(host => host.shadowRoot.querySelector('#progressBody tr').dataset.state), 'review');
        assert.equal(await page.evaluate(() => Array.from(document.body.children).some(node => node.style.position === 'fixed' && /多个填空/.test(node.textContent))), false);
    } finally { await browser.close(); }
});

test('upstream adapter rejects stale root and disabled startup never calls paid API', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(); let requests = 0, release;
        await page.route('**/*', route => {
            if (new URL(route.request().url()).hostname === 'mooc1.chaoxing.com') return route.fulfill({ contentType: 'text/html', body: html.replaceAll('<img src="/question.png">', '').replaceAll('<img src="/option.png">', '') });
            requests++;
            return new Promise(resolve => { release = () => resolve(route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'A' } }] }) })); });
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/fixture'); await page.evaluate(shim);
        assert.equal(requests, 0); assert.equal(await page.evaluate(() => __cxUpstreamAI.active()), false);
        await page.evaluate(() => { __cefDeepSeek.configure({ apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid' }); });
        assert.equal(await page.evaluate(() => __cxUpstreamAI.active()), true, 'upstream key-only config remains compatible');
        while (!release) await new Promise(resolve => setTimeout(resolve, 5));
        // Change the root while the first queued request is in flight.
        await page.evaluate(() => { document.querySelector('h3').textContent = 'changed question'; });
        release(); release = null;
        // Cancel remaining batch jobs with a configuration change; no stale fill.
        await page.evaluate(() => __cefDeepSeek.configure({ enabled: false }));
        await page.waitForTimeout(50);
        await page.evaluate(() => { document.querySelector('#a').onclick = () => { window.clicked = true; }; __cxUpstreamAI.fillAnswersFromAI(window.aiAnswersData || {}); });
        assert.equal(await page.evaluate(() => !!window.clicked), false);
    } finally { await browser.close(); }
});
