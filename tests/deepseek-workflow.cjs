const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');

const root = path.resolve(__dirname, '..');
const binary = () => fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll'));
const shim = () => decodeResource(readResource(binary(), 10, 201)).toString('utf8');
const aiScript = () => fs.readFileSync(path.join(root, 'scripts/deepseek_ai_script.js'), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const completion = content => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] });

test('Save persists config through the DLL route; chat keeps context and accepts clipboard images', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const saved = [], chats = [];
        await page.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (url.hostname === 'mooc1.chaoxing.com') {
                if (url.pathname === '/__cef_cx_ai_proxy__/health') return route.fulfill({ contentType: 'application/json', body: '{"cefCxAiProxy":1}' });
                if (url.pathname === '/__cef_cx_ai_proxy__/config') {
                    saved.push(JSON.parse(request.postData()));
                    return route.fulfill({ contentType: 'application/json', body: '{"saved":true}' });
                }
                return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8"><main>workflow fixture</main>' });
            }
            if (url.hostname === 'ai.fixture.invalid') {
                const body = JSON.parse(request.postData()); chats.push(body);
                return route.fulfill({ contentType: 'application/json', body: completion(chats.length === 1 ? '图片已收到' : '结合上文继续回答') });
            }
            return route.abort('blockedbyclient');
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/workflow');
        await page.evaluate(() => {
            window.__cefNativeAiProxy = { version: 1, deepseekOnly: true, configWrite: true };
            window.__CX_AI_CONFIG__ = { enabled: false, baseUrl: 'https://ai.fixture.invalid', model: 'deepseek-flash' };
        });
        await page.evaluate(shim());
        await page.evaluate(() => __cefDeepSeek.openSettings());
        const host = page.locator('#cef-deepseek-settings');
        assert.equal(await host.locator('#attach').count(), 0, 'question attachment action was removed');
        await host.locator('#key').fill('fixture-persistent-key');
        await host.locator('#answerDelay').fill('1.5');
        await host.locator('#advanced').evaluate(element => element.open = true);
        await host.locator('#overwritePolicy').selectOption('ask');
        await host.locator('#enabled').check();
        await host.locator('#save').click();
        for (let i = 0; i < 50 && !saved.some(c => c.apiKey === 'fixture-persistent-key'); i++) await page.waitForTimeout(20);
        assert(saved.length >= 1);
        assert.equal(saved.at(-1).apiKey, 'fixture-persistent-key');
        assert.equal(saved.at(-1).enabled, true);
        assert.equal(saved.at(-1).answerDelayMs, 1500);
        assert.equal(saved.at(-1).overwritePolicy, 'ask');
        assert.equal(await host.locator('#answerDelay').isVisible(), true, 'delay setting stays in the main DeepSeek answer pane');
        assert.match(await host.locator('.answer-controls').textContent(), /逐题间隔.*答题控制/);
        const controlHeights = await host.locator('.answer-controls').evaluate(node => [
            node.querySelector('.delay-control').getBoundingClientRect().height,
            node.querySelector('#pause').getBoundingClientRect().height
        ]);
        assert.equal(controlHeights[0], controlHeights[1], 'delay and pause controls use the same height');
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-persistent-key')), false);

        await host.locator('#tabChat').click();
        const input = host.locator('#chatInput');
        await input.evaluate((element, bytes) => {
            const file = new File([new Uint8Array(bytes)], 'clipboard.png', { type: 'image/png' });
            const event = new Event('paste', { bubbles: true, composed: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', { value: {
                items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
                getData: () => ''
            }});
            element.dispatchEvent(event);
        }, [...png]);
        await page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatImages').textContent.includes('图片 1'), null, { timeout: 5000 });
        await input.fill('这张图片是什么？');
        await host.locator('#chatSend').click();
        await page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog').textContent.includes('图片已收到'), null, { timeout: 5000 });
        assert(chats[0].messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url')));
        await input.fill('结合刚才的图片继续说明');
        await host.locator('#chatSend').click();
        await page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#chatLog').textContent.includes('结合上文继续回答'), null, { timeout: 5000 });
        assert.equal(chats.length, 2);
        assert(chats[1].messages.some(message => message.role === 'assistant' && message.content === '图片已收到'));
        assert(chats[1].messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('继续说明')));
        await host.locator('#tabAnswer').click();
        await host.locator('#advanced').evaluate(element => element.open = true);
        const beforeClear = saved.length;
        await host.locator('#clear').click();
        for (let i = 0; i < 50 && (saved.length <= beforeClear || saved.at(-1).apiKey !== ''); i++) await page.waitForTimeout(20);
        assert.equal(saved.at(-1).apiKey, '');
        assert.equal(saved.at(-1).enabled, false);
    } finally { await browser.close(); }
});

test('automatic answering requests and fills strictly one question at a time', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const snapshots = [], requestTimes = [];
        const html = '<!doctype html><meta charset="utf-8">' + [1, 2, 3].map(index =>
            `<div class="questionLi" data-question-id="q${index}"><h3 class="mark_name">${index}.（简答题）[填空题] Q${index}</h3>` +
            '<input name="type' + index + '" type="hidden" value="4"><div class="eidtDiv"><textarea></textarea></div></div>').join('');
        await page.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.hostname === 'mooc1.chaoxing.com') return route.fulfill({ contentType: 'text/html;charset=utf-8', body: html });
            if (url.hostname === 'ai.fixture.invalid') {
                requestTimes.push(Date.now());
                snapshots.push(await page.locator('div.questionLi textarea').evaluateAll(nodes => nodes.map(node => node.value)));
                const body = JSON.parse(request.postData());
                const prompt = body.messages[1].content[0].text;
                const index = Number((prompt.match(/Q(\d)/) || [0, 1])[1]);
                return route.fulfill({ contentType: 'application/json', body: completion(JSON.stringify({ type: 'blank', answers: [`答案${index}`], needsReview: false })) });
            }
            return route.abort('blockedbyclient');
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/sequential');
        await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', concurrency: 2, answerDelayMs: 1000 }; });
        await page.evaluate(shim());
        await page.evaluate(aiScript());
        await page.waitForFunction(() => document.querySelectorAll('textarea')[0].value === '答案1' && !document.querySelectorAll('textarea')[1].value);
        await page.evaluate(() => __cefDeepSeek.openSettings());
        assert.match(await page.locator('#cef-deepseek-settings').evaluate(host => host.shadowRoot.querySelector('#status').textContent), /秒后处理第 2\/3 题/);
        await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).every(node => node.value));
        assert.deepEqual(snapshots, [['', '', ''], ['答案1', '', ''], ['答案1', '答案2', '']], 'next request starts only after the previous field was filled');
        assert(requestTimes[1] - requestTimes[0] >= 900 && requestTimes[2] - requestTimes[1] >= 900, 'configured interval is applied after each fill and before the next request');
        assert.deepEqual(await page.locator('div.questionLi textarea').evaluateAll(nodes => nodes.map(node => node.value)), ['答案1', '答案2', '答案3']);
        await page.evaluate(() => __cefDeepSeek.openSettings());
        assert.match(await page.locator('#cef-deepseek-settings').evaluate(host => host.shadowRoot.querySelector('#status').textContent), /逐题处理完成：3 道，写入 3 项/);
    } finally { await browser.close(); }
});

test('existing rich-editor text is backed up, cleared and replaced; pause button and Ctrl+R resume safely', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage(); let requests = 0, requestedAt = 0;
        const html = '<!doctype html><meta charset="utf-8"><div class="questionLi" data-question-id="existing">' +
            '<h3 class="mark_name">2.（简答题）[填空题] len(\'Hello world!\') 的值为()</h3>' +
            '<input name="type0" type="hidden" value="4"><div class="eidtDiv">' +
            '<textarea name="answerEditor2" style="display:none">旧答案</textarea>' +
            '<iframe id="editor" srcdoc="<!doctype html><body>旧答案</body>"></iframe></div>' +
            '<button id="save_2" onclick="window.saved=(window.saved||0)+1"></button></div>';
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.hostname === 'mooc1.chaoxing.com') return route.fulfill({ contentType: 'text/html;charset=utf-8', body: html });
            if (url.hostname === 'ai.fixture.invalid') {
                requests++; requestedAt = Date.now();
                return route.fulfill({ contentType: 'application/json', body: completion(JSON.stringify({ type: 'blank', answers: ['12'], needsReview: false })) });
            }
            return route.abort('blockedbyclient');
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/existing-editor');
        await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: false, baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 50 }; });
        await page.evaluate(shim());
        await page.evaluate(aiScript());
        await page.evaluate(() => {
            __cxUpstreamAI.setPaused(true);
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 50 });
            __cefDeepSeek.openSettings();
        });
        await page.waitForTimeout(120);
        assert.equal(requests, 0, 'pause prevents paid requests before resume');
        const host = page.locator('#cef-deepseek-settings');
        assert.match(await host.locator('#pause').textContent(), /继续答题/);
        await page.keyboard.press('Control+r');
        await page.waitForFunction(() => document.querySelector('#editor').contentDocument.body.textContent.trim() === '12');
        assert.equal(requests, 1);
        assert(Date.now() - requestedAt < 500, 'the final answer is filled immediately because no next-question interval is needed');
        assert.match(await host.locator('#pause').textContent(), /暂停答题/);
        assert.match(await page.locator('textarea[name=answerEditor2]').inputValue(), /12/);
        assert.equal(await page.evaluate(() => window.saved), 1);
        assert.match(await host.evaluate(element => element.shadowRoot.querySelector('#progressBody').textContent), /已替换原内容/);
    } finally { await browser.close(); }
});

test('overwrite policy preserves existing text or asks before replacement', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const html = '<!doctype html><meta charset="utf-8"><div class="questionLi" data-question-id="policy">' +
        '<h3 class="mark_name">1.（简答题）[填空题] 1+1=()</h3><input name="type0" type="hidden" value="4">' +
        '<div class="eidtDiv"><textarea name="answerEditor1" style="display:none">旧答案</textarea>' +
        '<iframe id="editor" srcdoc="<!doctype html><body>旧答案</body>"></iframe></div>' +
        '<button id="save_1" onclick="window.saved=(window.saved||0)+1"></button></div>';
    async function run(policy, confirmValue) {
        const page = await browser.newPage(); let requests = 0;
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.hostname === 'mooc1.chaoxing.com') return route.fulfill({ contentType: 'text/html;charset=utf-8', body: html });
            if (url.hostname === 'ai.fixture.invalid') {
                requests++;
                return route.fulfill({ contentType: 'application/json', body: completion(JSON.stringify({ type: 'blank', answers: ['2'], needsReview: false })) });
            }
            return route.abort('blockedbyclient');
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/policy-' + policy + '-' + confirmValue);
        await page.evaluate(([selected, decision]) => {
            window.__CX_AI_CONFIG__ = { enabled: false, baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0, overwritePolicy: selected };
            window.confirm = () => decision;
        }, [policy, confirmValue]);
        await page.evaluate(shim());
        await page.evaluate(aiScript());
        await page.evaluate(selected => __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0, overwritePolicy: selected }), policy);
        await page.waitForFunction(() => window.aiAnswersData && Object.keys(window.aiAnswersData).length > 0);
        await page.waitForTimeout(50);
        const result = await page.evaluate(() => ({
            text: document.querySelector('#editor').contentDocument.body.textContent.trim(),
            saved: window.saved || 0,
            progress: (() => { __cefDeepSeek.openSettings(); return document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#progressBody').textContent; })()
        }));
        await page.close();
        return { ...result, requests };
    }
    try {
        const emptyOnly = await run('empty-only', true);
        assert.deepEqual({ text: emptyOnly.text, saved: emptyOnly.saved, requests: emptyOnly.requests }, { text: '旧答案', saved: 0, requests: 1 });
        assert.match(emptyOnly.progress, /按覆盖策略未替换/);
        const declined = await run('ask', false);
        assert.equal(declined.text, '旧答案');
        assert.equal(declined.saved, 0);
        const accepted = await run('ask', true);
        assert.equal(accepted.text, '2');
        assert.equal(accepted.saved, 1);
        assert.match(accepted.progress, /已替换原内容/);
    } finally { await browser.close(); }
});
