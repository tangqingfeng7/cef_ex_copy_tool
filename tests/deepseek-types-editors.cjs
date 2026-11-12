const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const dll = process.env.DEEPSEEK_TEST_DLL || path.resolve(__dirname, '../out/build/x86-integrated/src/Release/winmm.dll');
const code = 'students = []\nfor i in range(3):\n    name = input("姓名：")\n    students.append(name)\nprint(students)';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function fixture(html, response, setup) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); const requests = [];
    await page.route('**/*', route => {
        if (new URL(route.request().url()).hostname === 'ai.fixture.invalid') {
            const body = JSON.parse(route.request().postData()); requests.push(body);
            const value = typeof response === 'function' ? response(body) : response;
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) });
        }
        return route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + html });
    });
    await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/types-editors');
    if (setup) await page.evaluate(setup);
    await page.evaluate(() => { window.__CX_AI_CONFIG__ = { enabled: false, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 }; });
    await page.evaluate(decodeResource(readResource(fs.readFileSync(dll), 10, 201)).toString('utf8'));
    return { browser, page, requests, async start() {
        await page.evaluate(() => { __cefDeepSeek.openSettings(); __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0 }); });
        await page.waitForFunction(() => {
            const row = document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#progressBody tr');
            return row && row.getAttribute('data-state') !== 'pending';
        }, null, { timeout: 5000 });
    }, async progress() { return page.locator('#cef-deepseek-settings').locator('#progressBody').textContent(); } };
}
async function holdFirstAnswer(page, reply) {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const first = new Promise(resolve => { started = resolve; });
    const requests = [];
    await page.route('https://ai.fixture.invalid/**', async route => {
        requests.push(JSON.parse(route.request().postData()));
        if (requests.length === 1) { started(); await gate; }
        const value = typeof reply === 'function' ? reply(requests.length) : reply;
        await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] } });
    });
    return { first, release, requests };
}
function question(title, inputs, editor = '<div class="eidtDiv"><textarea></textarea></div>') {
    return `<div class="questionLi" data-question-id="one"><h3 class="mark_name">${title}</h3><img src="${png}">${inputs}${editor}</div>`;
}

test('explicit short-answer labels override empty/conflicting fields; unrelated typeface is not question metadata', { timeout: 45000 }, async () => {
    for (const [title, inputs] of [
        ['6.（简答题，5.0分）', '<input name="type6" type="hidden" value="">'],
        ['6.（简答题，5.0分）', '<input name="type6" type="hidden" value="0">'],
        ['6.（简答题，5.0分）', '<input name="typeface" type="hidden" value="0"><input name="type6" type="hidden" value="4">'],
        ['6. 编写程序', '<input name="type6" type="hidden" value="   ">'],
        ['6. 根据图片完成程序', '<input name="typeface" type="hidden" value="0"><input name="type6" type="hidden" value="4">'],
        ['6. 根据图片完成程序', '<input name="type6" type="hidden" value="not-a-number">']
    ]) {
        const f = await fixture(question(title, inputs), request => ({ type: request.messages[1].content[0].text.includes('题型：text') ? 'text' : 'single', answers: [code], choices: [], needsReview: false }));
        try {
            await f.start();
            assert.match(f.requests[0].messages[1].content[0].text, /题型：text/);
            assert.equal(await f.page.locator('.questionLi textarea').inputValue(), code);
            assert.equal(f.requests[0].messages[1].content.filter(x => x.type === 'image_url').length, 1);
        } finally { await f.browser.close(); }
    }
});

test('judge aliases include boolean false and F; choice letters map using actual reversed option labels', { timeout: 30000 }, async () => {
    const html = '<div class="questionLi" data-question-id="one"><h3 class="mark_name">5.（判断题，5.0分）</h3><input name="type5" type="hidden" value="3">' +
        ['错误', '正确'].map((text, index) => `<div class="answerBg" data-index="${index}" onclick="document.querySelectorAll('.answerBg i').forEach(n=>n.className='');this.querySelector('i').className='check_answer'"><span class="answer_p">${text}</span><i></i></div>`).join('') + '</div>';
    for (const value of [
        { type: 'judge', answers: [], answer: false, needsReview: false },
        { type: 'judge', answers: ['F'], needsReview: false },
        { type: 'judge', answers: [false], needsReview: false },
        { type: 'judge', choices: ['A'], needsReview: false },
        { type: 'boolean', correct: false }
    ]) {
        const f = await fixture(html, value);
        try {
            await f.start();
            assert.equal(await f.page.locator('.answerBg').evaluateAll(nodes => nodes.findIndex(n => n.querySelector('.check_answer'))), 0);
            assert.match(await f.progress(), /已填入/);
        } finally { await f.browser.close(); }
    }
    const bad = await fixture(html, { type: 'judge', answers: [false, true], needsReview: false });
    try {
        await bad.start();
        assert.equal(await bad.page.locator('.check_answer').count(), 0);
        assert.match(await bad.progress(), /失败/);
    } finally { await bad.browser.close(); }
});

test('option extraction omits markup labels and keeps initials in the option body', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi" data-question-id="one"><h3 class="mark_name">1.（单选题）选择作者</h3>' +
        '<div class="answerBg"><div class="clearfix"><span class="mark_letter">A.</span><span class="answer_p">A. Smith</span><i></i></div></div>' +
        '<div class="answerBg"><div class="clearfix"><span class="mark_letter">B.</span>C. Brown<i></i></div></div></div>';
    const f = await fixture(html, { type: 'single', choices: ['A'], needsReview: false });
    try {
        await f.start();
        assert.match(f.requests[0].messages[1].content[0].text, /\nA\. A\. Smith\nB\. C\. Brown$/);
    } finally { await f.browser.close(); }
});

test('text answers keep significant surrounding whitespace and unrelated page ticks do not scan questions', { timeout: 15000 }, async () => {
    const value = '    return x  ';
    const f = await fixture('<div id="timer"></div><div class="questionLi"><h3>1.（简答题）写一行代码</h3><textarea>return x</textarea></div>', { type: 'text', answers: [value], needsReview: false });
    try {
        await f.start();
        assert.equal(await f.page.locator('.questionLi textarea').inputValue(), value);
        const scans = await f.page.evaluate(async () => {
            let scans = 0;
            const query = Document.prototype.querySelectorAll;
            Document.prototype.querySelectorAll = function (selector) { if (selector === 'div.questionLi') scans++; return query.call(this, selector); };
            try {
                for (let i = 0; i < 12; i++) {
                    document.querySelector('#timer').textContent = i;
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                await new Promise(resolve => setTimeout(resolve, 180));
                return scans;
            } finally { Document.prototype.querySelectorAll = query; }
        });
        assert.equal(scans, 0);
        assert.equal(f.requests.length, 1);
    } finally { await f.browser.close(); }
});

test('single choice honors overwrite policy and reports failed readback', { timeout: 15000 }, async () => {
    for (const locked of [false, true]) {
        const html = '<div class="questionLi" data-question-id="one"><h3 class="mark_name">1.（单选题）选择一项</h3>' +
            '<div class="answerBg">A. 原选项<i class="check_answer"></i></div><div class="answerBg">B. 目标选项<i></i></div></div>';
        const f = await fixture(html, { type: 'single', choices: ['B'], needsReview: false });
        try {
            await f.page.evaluate(locked => {
                const [current, target] = document.querySelectorAll('.answerBg');
                if (!locked) target.onclick = () => { current.querySelector('i').className = ''; target.querySelector('i').className = 'check_answer'; };
                __cefDeepSeek.openSettings();
                __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', overwritePolicy: locked ? 'always' : 'empty-only' });
            }, locked);
            const row = f.page.locator('#cef-deepseek-settings #progressBody tr[data-state]:not([data-state=pending])');
            await row.waitFor();
            assert.equal(await f.page.locator('.answerBg').first().locator('.check_answer').count(), 1);
            assert.equal(await row.getAttribute('data-state'), locked ? 'error' : 'review');
            assert.match(await row.textContent(), locked ? /回读不一致/ : /按覆盖策略未替换/);
        } finally { await f.browser.close(); }
    }
});

test('disabling answering while a save control is unavailable cancels the pending click', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi"><h3 class="mark_name">1.（简答题）题目</h3><div class="eidtDiv"><textarea></textarea></div>' +
        '<button id="save_1" disabled onclick="window.saved=(window.saved||0)+1">保存</button></div>';
    const f = await fixture(html, { type: 'text', answers: ['新答案'], needsReview: false }, () => {
        const button = document.querySelector('#save_1'), descriptor = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled');
        Object.defineProperty(button, 'disabled', {
            get() { window.waitingToSave = true; return descriptor.get.call(this); },
            set(value) { descriptor.set.call(this, value); }
        });
    });
    try {
        await f.page.evaluate(() => {
            __cefDeepSeek.openSettings();
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid' });
        });
        await f.page.waitForFunction(() => window.waitingToSave);
        await f.page.evaluate(() => {
            __cefDeepSeek.configure({ enabled: false, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid' });
            document.querySelector('#save_1').disabled = false;
        });
        await f.page.locator('#cef-deepseek-settings #progressBody tr[data-state]:not([data-state=pending])').waitFor();
        assert.equal(await f.page.evaluate(() => window.saved || 0), 0);
        assert.equal(await f.page.locator('textarea').first().inputValue(), '新答案');
    } finally { await f.browser.close(); }
});

test('empty-only preserves existing blanks and saves the newly filled blanks', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi"><h3 class="mark_name">1.（填空题）两空</h3><div class="fill_blank"><input type="text" value="已有答案" readonly>' +
        '<input type="text"></div><button id="save_1" onclick="window.saved=(window.saved||0)+1">保存</button></div>';
    const f = await fixture(html, { type: 'blank', answers: ['不覆盖', '新答案'], needsReview: false });
    try {
        await f.page.evaluate(() => {
            __cefDeepSeek.openSettings();
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', overwritePolicy: 'empty-only' });
        });
        const row = f.page.locator('#cef-deepseek-settings #progressBody tr[data-state]:not([data-state=pending])');
        await row.waitFor();
        assert.equal(await row.getAttribute('data-state'), 'success');
        assert.deepEqual(await f.page.locator('.questionLi input').evaluateAll(inputs => inputs.map(input => input.value)), ['已有答案', '新答案']);
        assert.equal(await f.page.evaluate(() => window.saved || 0), 1);
    } finally { await f.browser.close(); }
});

test('embedded stem frames are neither answer targets nor writable editor bodies', { timeout: 15000 }, async () => {
    for (const editor of ['<textarea></textarea>', '']) {
        const html = '<div class="questionLi"><h3>1.（简答题）解释<iframe srcdoc="&lt;p&gt;嵌入题面&lt;/p&gt;"></iframe></h3>' + editor + '<button>保存</button></div>';
        const f = await fixture(html, { type: 'text', answers: ['答案'], needsReview: false });
        try {
            await f.start();
            assert.equal(await f.page.frameLocator('.questionLi iframe').locator('body').textContent(), '嵌入题面');
            if (editor) assert.equal(await f.page.locator('.questionLi textarea').inputValue(), '答案');
            else assert.match(await f.progress(), /页面空格 0 个/);
        } finally { await f.browser.close(); }
    }
});

test('manual edits during the save wait remain unsaved by automation', { timeout: 15000 }, async () => {
    const editor = '<textarea></textarea><button id="save-answer" disabled onclick="window.saveClicks=(window.saveClicks||0)+1;const saved=this.cloneNode(true);saved.textContent=\'已保存\';this.replaceWith(saved)">保存</button>';
    const f = await fixture(question('6.（简答题）说明原理', '', editor), { type: 'text', answers: ['AI答复'], needsReview: false });
    try {
        const run = f.start();
        await f.page.waitForFunction(() => document.querySelector('.questionLi textarea').value === 'AI答复');
        await f.page.locator('.questionLi textarea').fill('手工改写');
        await f.page.locator('#save-answer').evaluate(button => { button.disabled = false; });
        await run;
        const panel = f.page.locator('#cef-deepseek-settings');
        await panel.locator('#advanced > summary').click(); await panel.locator('#retryFailed').click();
        assert.match(await panel.locator('#status').textContent(), /没有可重试的失败题/);
        assert.equal(await f.page.locator('.questionLi textarea').inputValue(), '手工改写');
        assert.equal(await f.page.evaluate(() => window.saveClicks || 0), 0);
        assert.match(await f.progress(), /保存前答案已修改/);
        await f.page.evaluate(() => {
            const question = document.querySelector('.questionLi'), replacement = question.cloneNode(true);
            replacement.querySelector('textarea').value = question.querySelector('textarea').value;
            question.replaceWith(replacement);
            document.body.insertAdjacentHTML('beforeend', '<div class="questionLi" data-question-id="new"><h3>2.（简答题）追加题目</h3><textarea></textarea><button>保存</button></div>');
        });
        await panel.locator('#progressBody tr[data-state=success]').waitFor();
        assert.deepEqual(await f.page.locator('.questionLi textarea').evaluateAll(fields => fields.map(field => field.value)), ['手工改写', 'AI答复']);
        assert.equal(await f.page.evaluate(() => window.saveClicks || 0), 0);
        assert.equal(await panel.locator('#progressBody tr[data-state=review]').count(), 1);
        await f.page.locator('#save-answer').click();
        const manualRow = panel.locator('#progressBody tr').first();
        await manualRow.getByText('手工答案已保存', { exact: true }).waitFor();
        assert.equal(await manualRow.getAttribute('data-state'), 'success');
        assert.equal(await f.page.locator('.questionLi textarea').first().inputValue(), '手工改写');
        assert.equal(await f.page.evaluate(() => window.saveClicks), 1);
    } finally { await f.browser.close(); }
});

test('automatic processing of a newly loaded question preserves input edited during the earlier request', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi" data-question-id="one"><h3>（简答题）第一题</h3><textarea></textarea><button onclick="window.savedFirst=true">保存</button></div>';
    const reply = { type: 'text', answers: ['自动答复'], needsReview: false };
    const f = await fixture(html, reply), held = await holdFirstAnswer(f.page, reply);
    try {
        const run = f.start();
        await held.first;
        await f.page.locator('.questionLi textarea').fill('手工答复');
        await f.page.evaluate(() => document.body.insertAdjacentHTML('beforeend',
            '<div class="questionLi" data-question-id="two"><h3>（简答题）新题</h3><textarea></textarea><button>保存</button></div>'));
        held.release();
        await run;
        await f.page.waitForFunction(() => document.querySelectorAll('.questionLi textarea')[1].value === '自动答复');
        assert.deepEqual(await f.page.locator('.questionLi textarea').evaluateAll(items => items.map(item => item.value)), ['手工答复', '自动答复']);
        assert.equal(await f.page.evaluate(() => !!window.savedFirst), false);
        assert.match(await f.progress(), /保留手工答案/);
        assert.equal(held.requests.length, 2);
        await f.page.locator('.questionLi textarea').first().fill('');
        await f.page.evaluate(() => __cxUpstreamAI.start());
        await f.page.waitForFunction(() => document.querySelector('.questionLi textarea').value === '自动答复');
        await f.page.waitForFunction(() => window.savedFirst === true);
    } finally { held.release(); await f.browser.close(); }
});

test('save button confirmations do not rescan all questions', { timeout: 15000 }, async () => {
    const html = Array.from({ length: 4 }, (_, i) => '<div class="questionLi"><h3>（简答题）题目' + i +
        '</h3><textarea></textarea><button onclick="this.textContent=\'已保存\'">保存</button></div>').join('');
    const f = await fixture(html, { type: 'text', answers: ['自动答复'], needsReview: false });
    try {
        await f.page.evaluate(() => {
            window.signatureScans = 0;
            const query = Document.prototype.querySelectorAll;
            Document.prototype.querySelectorAll = function (selector) {
                if (selector === 'div.questionLi' && new Error().stack.includes('questionSignature')) window.signatureScans++;
                return query.call(this, selector);
            };
            __cefDeepSeek.openSettings();
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 300 });
        });
        await f.page.waitForFunction(() => Array.from(document.querySelectorAll('.questionLi button')).every(button => button.textContent === '已保存'));
        await f.page.waitForTimeout(180);
        assert.equal(await f.page.evaluate(() => window.signatureScans), 1);
        assert.equal(f.requests.length, 4);
    } finally { await f.browser.close(); }
});

test('empty-only preserves an image-only rich-text answer', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi"><h3>1.（简答题）说明原理</h3><div contenteditable="true"><img src="' + png + '"></div><button onclick="window.saveClicks=1">保存</button></div>';
    const f = await fixture(html, { type: 'text', answers: ['AI答复'], needsReview: false });
    try {
        await f.page.evaluate(() => {
            __cefDeepSeek.openSettings(); __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', overwritePolicy: 'empty-only' });
        });
        await f.page.locator('#cef-deepseek-settings #progressBody tr[data-state=review]').waitFor();
        assert.equal(await f.page.locator('.questionLi [contenteditable=true] img').count(), 1);
        assert.equal(await f.page.evaluate(() => window.saveClicks || 0), 0);
    } finally { await f.browser.close(); }
});

test('saving reads a replacement button and skips the grace period for immediate confirmation', { timeout: 15000 }, async () => {
    const response = { type: 'text', answers: ['答案'], needsReview: false };
    const failure = '<textarea></textarea><button id="save_answer" onclick="const next=this.cloneNode(true);next.textContent=\'保存失败\';this.replaceWith(next)">保存</button>';
    const f = await fixture(question('1.（简答题）说明', '', failure), response);
    try { await f.start(); assert.match(await f.progress(), /页面提示保存失败/); }
    finally { await f.browser.close(); }

    const success = '<textarea></textarea><button id="save_answer" onclick="this.textContent=\'已保存\';window.savedNow=true">保存</button>';
    const g = await fixture(question('1.（简答题）说明', '', success), response, () => {
        const schedule = window.setTimeout; window.waitsAfterSave = [];
        window.setTimeout = function (callback, delay, ...args) {
            if (window.savedNow && (delay === 200 || delay === 600)) window.waitsAfterSave.push(delay);
            return schedule.call(this, callback, delay, ...args);
        };
    });
    try {
        await g.start(); assert.match(await g.progress(), /已填入并点击保存/);
        assert.deepEqual(await g.page.evaluate(() => window.waitsAfterSave), []);
    } finally { await g.browser.close(); }
});

test('automatic answering resumes on a replacement question with the same ID and text', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi" data-question-id="same"><h3>1.（简答题）说明原理</h3><textarea></textarea><button onclick="window.saved=(window.saved||0)+1;const q=this.closest(\'.questionLi\'),next=q.cloneNode(true);next.querySelector(\'textarea\').value=q.querySelector(\'textarea\').value;q.replaceWith(next)">保存</button></div>';
    const response = { type: 'text', answers: ['答案'], needsReview: false };
    const f = await fixture(html, response);
    try {
        const gate = await holdFirstAnswer(f.page, response), run = f.start();
        await gate.first;
        await f.page.evaluate(() => { const question = document.querySelector('.questionLi'); question.replaceWith(question.cloneNode(true)); });
        gate.release(); await run;
        await f.page.waitForFunction(() => document.querySelector('.questionLi textarea').value === '答案' && window.saved === 1);
        const panel = f.page.locator('#cef-deepseek-settings');
        await panel.locator('#progressBody tr[data-state=success]').waitFor();
        assert.equal(await f.page.evaluate(() => window.saved), 1, 'the save-triggered rerender does not save again');
        assert.equal(gate.requests.length, 1, 'the second pass can use the answer cache');
    } finally { await f.browser.close(); }
});

test('retrying a failed question uses the current node for the same question ID', { timeout: 15000 }, async () => {
    let attempts = 0;
    const html = '<div class="questionLi" data-question-id="same"><h3>1.（简答题）说明原理</h3><textarea></textarea><button>保存</button></div>';
    const f = await fixture(html, () => ++attempts === 1 ? null : { type: 'text', answers: ['新节点答案'], needsReview: false });
    try {
        await f.start(); assert.match(await f.progress(), /失败/);
        await f.page.evaluate(() => { const question = document.querySelector('.questionLi'); question.replaceWith(question.cloneNode(true)); });
        const panel = f.page.locator('#cef-deepseek-settings');
        await panel.locator('#advanced > summary').click(); await panel.locator('#retryFailed').click();
        await panel.locator('#progressBody tr[data-state=success]').waitFor();
        assert.equal(await f.page.locator('.questionLi textarea').inputValue(), '新节点答案');
        assert.equal(attempts, 2);
    } finally { await f.browser.close(); }
});

test('explicit page save failure is retryable and an unchanged saved answer skips the click', { timeout: 15000 }, async () => {
    const response = { type: 'text', answers: ['答案'], needsReview: false };
    const editor = '<textarea></textarea><button onclick="window.clicks=(window.clicks||0)+1;this.textContent=window.saveAllowed?\'已保存\':\'保存失败\'">保存</button>';
    const f = await fixture(question('1.（简答题）题目', '', editor), response);
    try {
        await f.start(); assert.match(await f.progress(), /页面提示保存失败/);
        await f.page.evaluate(() => { window.saveAllowed = true; });
        const panel = f.page.locator('#cef-deepseek-settings');
        await panel.locator('#advanced > summary').click(); await panel.locator('#retryFailed').click();
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#progressBody tr').getAttribute('data-state') === 'success');
        assert.equal(await f.page.evaluate(() => window.clicks), 2);
        assert.equal(f.requests.length, 1, 'retry reuses the answer and only needs to retry saving');
    } finally { await f.browser.close(); }

    const already = await fixture(question('1.（简答题）题目', '', '<textarea>答案</textarea><button onclick="window.clicks=1">已保存</button>'), response);
    try {
        await already.start(); assert.match(await already.progress(), /答案已保存/);
        assert.equal(await already.page.evaluate(() => window.clicks || 0), 0);
    } finally { await already.browser.close(); }
});

test('Ctrl+C sends only a current selection and ignores a collapsed input selection', { timeout: 15000 }, async () => {
    const f = await fixture('<textarea id="copy-source">本次选择</textarea>', '回答');
    try {
        await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(f.page.url()).origin });
        await f.page.evaluate(async () => {
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid' });
            await navigator.clipboard.writeText('上次复制的测试文本');
        });
        const input = f.page.locator('#copy-source');
        await input.focus(); await input.evaluate(el => el.setSelectionRange(0, 0));
        const isAI = request => request.url().includes('ai.fixture.invalid');
        const [unexpected] = await Promise.all([f.page.waitForRequest(isAI, { timeout: 400 }).catch(() => null), f.page.keyboard.press('Control+c')]);
        assert.equal(unexpected, null);
        await input.evaluate(el => el.select());
        const [request] = await Promise.all([f.page.waitForRequest(isAI), f.page.keyboard.press('Control+c')]);
        assert.match(request.postData(), /本次选择/);
        assert.doesNotMatch(request.postData(), /上次复制的测试文本/);
    } finally { await f.browser.close(); }
});

test('a read-only blank prevents partial edits before the first write', { timeout: 15000 }, async () => {
    const editor = '<textarea></textarea><textarea readonly></textarea><button onclick="window.saveClicks=1">保存</button>';
    const f = await fixture(question('6.（填空题）两处', '', editor), { type: 'blank', answers: ['第一空', '第二空'], needsReview: false });
    try {
        await f.start();
        assert.deepEqual(await f.page.locator('.questionLi textarea').evaluateAll(nodes => nodes.map(node => node.value)), ['', '']);
        assert.equal(await f.page.evaluate(() => window.saveClicks || 0), 0);
        assert.match(await f.progress(), /第 2 个填写位置不可写/);
    } finally { await f.browser.close(); }
});

test('typing in an iframe while the answer is pending preserves the manual edit', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi"><h3 class="mark_name">1.（简答题）题目</h3><div class="eidtDiv">' +
        '<textarea style="display:none">原答案</textarea><iframe srcdoc="<body contenteditable=true>原答案</body>"></iframe></div>' +
        '<button id="save_1" onclick="window.saved=(window.saved||0)+1">保存</button></div>';
    const reply = { type: 'text', answers: ['模型答案'], needsReview: false };
    const f = await fixture(html, reply), hold = await holdFirstAnswer(f.page, reply);
    try {
        const done = f.start();
        await hold.first;
        const editor = f.page.frameLocator('iframe').locator('body');
        await editor.fill('手写答案');
        hold.release(); await done;
        assert.equal(await editor.textContent(), '手写答案');
        assert.equal(await f.page.locator('.questionLi textarea').inputValue(), '原答案');
        assert.equal(await f.page.evaluate(() => window.saved || 0), 0);
        assert.match(await f.progress(), /已变化/);
    } finally { hold.release(); await f.browser.close(); }
});

test('redrawing the question canvas retries once and preserves a manually selected answer', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi"><h3 class="mark_name">1.（单选题）选颜色</h3><canvas width="32" height="32"></canvas>' +
        '<div class="answerBg" onclick="this.classList.add(\'check_answer\')">红</div><div class="answerBg" onclick="this.classList.add(\'check_answer\')">蓝</div></div>';
    const reply = { type: 'single', choices: ['A'], needsReview: false };
    for (const [paused, editAnswer] of [[false, false], [false, true], [true, false]]) {
        const f = await fixture(html, reply, () => {
            const ctx = document.querySelector('canvas').getContext('2d');
            ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 32, 32);
        });
        const hold = await holdFirstAnswer(f.page, index => ({ ...reply, choices: [index === 1 ? 'A' : 'B'] }));
        try {
            const done = f.start(); await hold.first;
            if (paused) {
                await f.page.evaluate(() => __cxUpstreamAI.setPaused(true, false));
                hold.release();
                await f.page.waitForFunction(() => Object.values(window.aiAnswersData || {}).some(item => item.validate));
            }
            await f.page.locator('canvas').evaluate(canvas => {
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 32, 32);
            });
            if (editAnswer) await f.page.locator('.answerBg').first().click();
            if (paused) await f.page.evaluate(() => __cxUpstreamAI.setPaused(false, false));
            else hold.release();
            await done;
            assert.equal(await f.page.locator('.check_answer').textContent(), editAnswer ? '红' : '蓝');
            assert.equal(hold.requests.length, editAnswer ? 1 : 2);
            assert.match(await f.progress(), editAnswer ? /已变化/ : /已填入/);
        } finally { hold.release(); await f.browser.close(); }
    }
});

test('finishing copied-text lookup resumes queued automatic work and shows the configured pause key', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi" data-question-id="one"><h3>1.（简答题）第一题</h3><textarea></textarea><button>保存</button></div>';
    const reply = { type: 'text', answers: ['自动填入'], needsReview: false };
    const f = await fixture(html, reply);
    const held = await holdFirstAnswer(f.page, reply);
    try {
        const panel = f.page.locator('#cef-deepseek-settings');
        await f.page.evaluate(() => {
            __cefDeepSeek.openSettings();
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', answerDelayMs: 0,
                answeringPaused: true, hotkeys: { pause: 'Alt+R' } });
        });
        await f.page.waitForFunction(() => document.querySelector('#cef-deepseek-settings').shadowRoot.getElementById('status').textContent.includes('Alt+R 继续'));
        await f.page.evaluate(() => { window.copyJob = __cxUpstreamAI.handleCopyAIRequest('简答题：第一题', document.querySelector('.questionLi')); });
        await held.first;
        await f.page.evaluate(() => {
            document.body.insertAdjacentHTML('beforeend', '<div class="questionLi" data-question-id="two"><h3>2.（简答题）第二题</h3><textarea></textarea><button>保存</button></div>');
            __cxUpstreamAI.setPaused(false, false);
        });
        // The question observer debounces for 120 ms while the copy request is still active.
        await f.page.waitForTimeout(180);
        held.release();
        await panel.locator('#progressBody tr[data-state=success]').last().waitFor();
        await f.page.waitForFunction(() => document.querySelectorAll('.questionLi textarea')[1].value === '自动填入');
        assert.equal(held.requests.length, 3);
    } finally { held.release(); await f.browser.close(); }
});

test('switching to local-only cancels the old DeepSeek fallback and immediately rechecks the question', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi"><h3>1.（简答题）题干</h3><textarea></textarea><button>保存</button></div>';
    const reply = { type: 'text', answers: ['旧 AI 答案'], needsReview: false };
    const f = await fixture(html, reply);
    const held = await holdFirstAnswer(f.page, reply);
    try {
        let lookups = 0;
        await f.page.route('**/__cef_cx_ai_proxy__/question-bank', route => {
            lookups++;
            return route.fulfill({ json: lookups === 1 ? { ok: true, matched: false, reason: 'not-found' } :
                { ok: true, matched: true, bank: '本地库', answer: { type: 'text', answers: ['本地答案'], needsReview: false } } });
        });
        await f.page.evaluate(() => {
            window.__cefNativeAiProxy = { questionBank: true };
            __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', bankAnswerMode: 'first', answerDelayMs: 0 });
        });
        await held.first;
        await f.page.evaluate(() => __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: 'https://ai.fixture.invalid', bankAnswerMode: 'only', answerDelayMs: 0 }));
        await f.page.waitForFunction(() => document.querySelector('.questionLi textarea').value === '本地答案', null, { timeout: 4000 });
        assert.equal(lookups, 2);
        assert.equal(held.requests.length, 1);
    } finally { held.release(); await f.browser.close(); }
});

test('late option text causes another automatic pass after the old answer is discarded', { timeout: 15000 }, async () => {
    const html = '<div class="questionLi"><h3 class="mark_name">1.（单选题）题目</h3><div class="answerBg">甲</div>' +
        '<div class="answerBg" onclick="this.classList.add(\'check_answer\')">乙</div></div>';
    const reply = n => ({ type: 'single', choices: [n === 1 ? 'A' : 'B'], needsReview: false });
    const f = await fixture(html, reply(1)), hold = await holdFirstAnswer(f.page, reply);
    try {
        const done = f.start(); await hold.first;
        await f.page.locator('.answerBg').first().evaluate(option => { option.textContent = '更新后的甲'; });
        hold.release(); await done;
        await f.page.locator('#cef-deepseek-settings #progressBody tr[data-state=success]').waitFor();
        assert.equal(hold.requests.length, 2);
        assert.match(hold.requests[1].messages[1].content[0].text, /更新后的甲/);
        assert.equal(await f.page.locator('.answerBg').last().evaluate(option => option.classList.contains('check_answer')), true);
    } finally { hold.release(); await f.browser.close(); }
});

test('multiline code fills an iframe editor and hidden textarea without losing line breaks or indentation', { timeout: 15000 }, async () => {
    const editor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea><iframe id="editor" srcdoc="<!doctype html><body>旧答案</body>"></iframe></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const f = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', editor), { type: 'text', answers: [code], needsReview: false });
    try {
        await f.start();
        const result = await f.page.evaluate(() => {
            const body = document.querySelector('#editor').contentDocument.body;
            const clone = body.cloneNode(true); clone.querySelectorAll('br').forEach(n => n.replaceWith(clone.ownerDocument.createTextNode('\n')));
            return { text: clone.textContent.trim(), html: document.querySelector('textarea').value, saved: window.saved || 0 };
        });
        assert.equal(result.text, code);
        assert.match(result.html, /<br>/);
        assert.equal(result.saved, 1);
        assert.match(await f.progress(), /已填入/);
    } finally { await f.browser.close(); }
});

test('UEditor verifies rich HTML line breaks rather than a lossy getContentTxt string', { timeout: 15000 }, async () => {
    const editor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const f = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', editor), { type: 'text', answers: [code], needsReview: false }, () => {
        let html = '旧答案';
        window.UE = { getEditor: () => ({
            getContent: () => html,
            getContentTxt: () => { const n = document.createElement('div'); n.innerHTML = html; return n.textContent; },
            setContent: value => { html = value; },
            sync: () => { document.querySelector('textarea').value = html; }, fireEvent: () => {}
        }) };
    });
    try {
        await f.start();
        assert.match(await f.progress(), /已填入/);
        assert.equal(await f.page.evaluate(() => window.saved), 1);
        assert.match(await f.page.locator('.questionLi textarea').inputValue(), /<br>/);
    } finally { await f.browser.close(); }
});

test('editor failure restores original content and does not pretend a hidden textarea is the visible answer', { timeout: 15000 }, async () => {
    const editor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const f = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', editor), { type: 'text', answers: [code], needsReview: false }, () => {
        let html = '旧答案';
        window.UE = { getEditor: () => ({
            getContent: () => html,
            setContent: value => { html = value; if (value !== '旧答案') throw new Error('Fixture editor rejected update'); },
            sync: () => { document.querySelector('textarea').value = html; }
        }) };
    });
    try {
        await f.start();
        assert.match(await f.progress(), /未填入/);
        assert.equal(await f.page.evaluate(() => UE.getEditor('answerEditor6').getContent()), '旧答案');
        assert.equal(await f.page.locator('.questionLi textarea').inputValue(), '旧答案');
        assert.equal(await f.page.evaluate(() => window.saved || 0), 0);
    } finally { await f.browser.close(); }
    const iframeEditor = '<div class="eidtDiv"><textarea name="answerEditor6" style="display:none">旧答案</textarea><iframe id="editor" srcdoc="<!doctype html><body>旧答案</body>"></iframe></div><button id="save_6" onclick="window.saved=(window.saved||0)+1"></button>';
    const blocked = await fixture(question('6.（简答题，5.0分）', '<input name="type6" type="hidden" value="4">', iframeEditor), { type: 'text', answers: [code], needsReview: false }, () => {
        const body = document.querySelector('#editor').contentDocument.body;
        body.addEventListener('input', () => { document.querySelector('textarea').value = 'rejected update'; body.innerHTML = '旧答案'; });
    });
    try {
        await blocked.start();
        assert.match(await blocked.progress(), /未填入/);
        assert.equal(await blocked.page.evaluate(() => document.querySelector('#editor').contentDocument.body.textContent), '旧答案');
        assert.equal(await blocked.page.locator('.questionLi textarea').inputValue(), '旧答案');
        assert.equal(await blocked.page.evaluate(() => window.saved || 0), 0);
    } finally { await blocked.browser.close(); }
});
