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
        await host.locator('#enabled').check();
        await host.locator('#save').click();
        for (let i = 0; i < 50 && saved.length === 0; i++) await page.waitForTimeout(20);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].apiKey, 'fixture-persistent-key');
        assert.equal(saved[0].enabled, true);
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
        await host.locator('#advanced summary').click();
        await host.locator('#clear').click();
        for (let i = 0; i < 50 && saved.length < 2; i++) await page.waitForTimeout(20);
        assert.equal(saved[1].apiKey, '');
        assert.equal(saved[1].enabled, false);
    } finally { await browser.close(); }
});

test('automatic answering requests and fills strictly one question at a time', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const snapshots = [];
        const html = '<!doctype html><meta charset="utf-8">' + [1, 2, 3].map(index =>
            `<div class="questionLi" data-question-id="q${index}"><h3 class="mark_name">${index}.（简答题）[填空题] Q${index}</h3>` +
            '<input name="type' + index + '" type="hidden" value="4"><div class="eidtDiv"><textarea></textarea></div></div>').join('');
        await page.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.hostname === 'mooc1.chaoxing.com') return route.fulfill({ contentType: 'text/html;charset=utf-8', body: html });
            if (url.hostname === 'ai.fixture.invalid') {
                snapshots.push(await page.locator('textarea').evaluateAll(nodes => nodes.map(node => node.value)));
                const body = JSON.parse(request.postData());
                const prompt = body.messages[1].content[0].text;
                const index = Number((prompt.match(/Q(\d)/) || [0, 1])[1]);
                return route.fulfill({ contentType: 'application/json', body: completion(JSON.stringify({ type: 'blank', answers: [`答案${index}`], needsReview: false })) });
            }
            return route.abort('blockedbyclient');
        });
        await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/sequential');
        await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', concurrency: 2 }; });
        await page.evaluate(shim());
        await page.evaluate(aiScript());
        await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).every(node => node.value));
        assert.deepEqual(snapshots, [['', '', ''], ['答案1', '', ''], ['答案1', '答案2', '']], 'next request starts only after the previous field was filled');
        assert.deepEqual(await page.locator('textarea').evaluateAll(nodes => nodes.map(node => node.value)), ['答案1', '答案2', '答案3']);
        await page.evaluate(() => __cefDeepSeek.openSettings());
        assert.match(await page.locator('#cef-deepseek-settings').evaluate(host => host.shadowRoot.querySelector('#status').textContent), /逐题处理完成：3 道，写入 3 项/);
    } finally { await browser.close(); }
});
