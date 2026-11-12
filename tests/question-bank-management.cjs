const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { chromium } = require('../tools/transpile/node_modules/playwright');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const { zipSync, strToU8 } = require('../userscripts/vendor/fflate-0.8.2.js');
const root = path.resolve(__dirname, '..');
const shim = decodeResource(readResource(fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')), 10, 201)).toString('utf8');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const question = (id, stem = '测试题干') => ({ id, type: 'single', stem, options: [{ id: 'A', text: '选项甲' }, { id: 'B', text: '选项乙' }], answer: ['A'], tags: ['网络'] });
const payload = (name, questions) => ({ schemaVersion: 1, name, questions });

async function fixture() {
    const native = spawn(path.join(root, 'out/build/x86-integrated/src/Release/question_bank_test.exe'), ['--serve'], { windowsHide: true });
    const waiting = [], requests = [], errors = [];
    const lines = readline.createInterface({ input: native.stdout });
    lines.on('line', line => { const job = waiting.shift(); if (job) { try { job.resolve(JSON.parse(line)); } catch (e) { job.reject(e); } } });
    native.on('exit', code => { for (const job of waiting.splice(0)) job.reject(new Error('Native fixture exited: ' + code)); });
    native.on('error', e => { for (const job of waiting.splice(0)) job.reject(e); });
    function api(value) { return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); native.stdin.write(JSON.stringify(value) + '\n'); }); }
    const server = http.createServer(async (req, res) => {
        if (req.url.endsWith('/question-bank')) {
            try {
                let text = ''; for await (const chunk of req) text += chunk;
                const input = JSON.parse(text); requests.push(input);
                const result = await api(input); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(result));
            } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: e.message })); }
        }
        if (req.url.endsWith('/config')) { res.setHeader('content-type', 'application/json'); return res.end('{"saved":true}'); }
        res.setHeader('content-type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><title>题库测试</title><p>题库管理回归测试</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
        window.__CX_AI_CONFIG__ = { enabled: false, bankAnswerMode: 'only', panelOpacity: 1, panelBounds: { left: 80, top: 40, width: 580, height: 780 }, universalScriptEnabled: false };
        window.__cefNativeAiProxy = { version: 1, questionBank: true, configWrite: true };
    });
    await page.evaluate(shim); await page.evaluate(() => __cefDeepSeek.openSettings());
    const panel = page.locator('#cef-deepseek-settings');
    async function waitEnabled(id) { await page.waitForFunction(id => { const e = document.querySelector('#cef-deepseek-settings').shadowRoot.getElementById(id); return e && !e.disabled; }, id); }
    async function bank() { await panel.locator('#tabBank').click(); await waitEnabled('bankSearch'); }
    async function file(value, name = '测试.json') { await panel.locator('#bankImportTab').click(); await panel.locator('#bankFile').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) }); await waitEnabled('bankImport'); }
    async function statusIncludes(text) { await page.waitForFunction(text => document.querySelector('#cef-deepseek-settings').shadowRoot.getElementById('bankStatus').textContent.includes(text), text); }
    async function ask(stem, options = ['选项乙', '选项甲'], type = 0) { return page.evaluate(async ({ stem, options, type }) => { try { return await __cefDeepSeek.answer({ question: stem, options, type }); } catch (e) { return { code: e.code }; } }, { stem, options, type }); }
    return { page, panel, requests, errors, api, bank, file, waitEnabled, statusIncludes, ask, async close() { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); native.stdin.end(); native.kill(); lines.close(); } };
}

test('bank UI pages and filters real SQLite; details and images load on demand', { timeout: 45000 }, async () => {
    const f = await fixture();
    try {
        const questions = Array.from({ length: 43 }, (_, i) => question(String(i), '课程题目 ' + i));
        const longStem = '这是可以完整粘贴到搜索框的中文题干'.repeat(12);
        questions[42].stem = longStem + '[图片:x]'; questions[42].images = [{ id: 'x', dataUrl: png }];
        assert((await f.api({ action: 'import', payload: payload('网络课', questions) })).ok);
        await f.api({ action: 'import', payload: payload('其他课', [question('other')]) });
        await f.bank(); await f.panel.locator('#bankFilter').selectOption('网络课'); await f.statusIncludes('本页 20');
        assert.equal(await f.panel.locator('#bankResults > details').count(), 20);
        assert.equal(f.requests.filter(r => r.action === 'detail' || r.action === 'images').length, 0);
        await f.panel.locator('#bankResults > details > summary').first().click();
        await f.panel.getByRole('button', { name: '加载 1 张图片' }).waitFor();
        assert.equal(f.requests.filter(r => r.action === 'detail' && r.images).length, 0);
        assert((await f.api({ action: 'import', payload: payload('其他课', [question('new')]) })).ok);
        await f.panel.getByRole('button', { name: '加载 1 张图片' }).click(); await f.panel.locator('#bankResults img').waitFor();
        assert.equal(f.requests.filter(r => r.action === 'detail' && r.images).length, 1);
        await f.panel.locator('#bankNext').click(); await f.statusIncludes('本页 20'); await f.waitEnabled('bankNext');
        assert.equal(await f.panel.locator('#bankPage').textContent(), '第 2 页');
        await f.panel.locator('#bankNext').click(); await f.statusIncludes('本页 3');
        assert.equal(await f.panel.locator('#bankResults > details').count(), 3);
        await f.panel.locator('#bankPrev').click(); await f.waitEnabled('bankNext'); assert.equal(await f.panel.locator('#bankPage').textContent(), '第 2 页');
        assert(longStem.length <= 512 && Buffer.byteLength(longStem) > 512);
        await f.panel.locator('#bankQuery').fill(longStem); await f.panel.locator('#bankSearch').click(); await f.statusIncludes('本页 1 道题');
        await f.panel.locator('#bankQuery').clear();
        await f.panel.locator('#bankTag').fill('不存在'); await f.panel.locator('#bankSearch').click(); await f.statusIncludes('本页 0');
        await f.panel.locator('#bankType').selectOption('boolean'); await f.statusIncludes('本页 0');
        assert.equal(await f.panel.locator('#bankPage').textContent(), '第 1 页');
        await f.page.setViewportSize({ width: 300, height: 480 });
        await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await f.panel.locator('#bankBrowseView').evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth }));
        assert(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('browse reopens a current detail and matches complete tags verbatim', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const original = { ...question('exact-tag', '原题干'), tags: [' 网络 '] };
        await f.api({ action: 'import', payload: payload('共享库', [original]) });
        await f.bank();
        await f.panel.locator('#bankTag').fill(' 网络 ');
        await f.panel.locator('#bankSearch').click(); await f.statusIncludes('本页 1 道题');
        const card = f.panel.locator('#bankResults > details'), summary = card.locator('summary');
        await summary.click();
        await card.getByText('答案： A. 选项甲', { exact: true }).waitFor();
        await summary.click();
        await f.api({ action: 'import', payload: payload('共享库', [{ ...original, stem: '新题干', answer: ['B'] }]) });
        const [{ id }] = (await f.api({ action: 'conflicts' })).conflicts;
        const { revision } = await f.api({ action: 'conflictDetail', id });
        assert((await f.api({ action: 'resolve', id, revision, decision: 'incoming' })).ok);
        await summary.click();
        await card.getByText('答案： B. 选项乙', { exact: true }).waitFor();
        assert.match(await summary.textContent(), /新题干/);
        assert.equal(f.requests.filter(request => request.action === 'detail').length, 2);
    } finally { await f.close(); }
});

test('resuming checks a held bank answer before filling or clicking save', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        for (const duringSave of [false, true]) {
            const stem = duringSave ? '保存前题库已变化' : '写入前题库已变化';
            const original = { id: stem, type: 'text', stem, answer: '旧答案' };
            await f.api({ action: 'import', payload: payload('共享库', [original]) });
            const exam = await f.page.context().browser().newPage(), calls = [];
            let started, release;
            const first = new Promise(resolve => { started = resolve; });
            const held = new Promise(resolve => { release = resolve; });
            try {
                await exam.route('https://mooc1.chaoxing.com/**', async route => {
                    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html;charset=utf-8',
                        body: '<div class="questionLi"><h3>（简答题）' + stem + '</h3><textarea></textarea><button id="answerSave" ' +
                            (duringSave ? 'disabled ' : '') + 'onclick="window.saved=document.querySelector(&quot;textarea&quot;).value">保存</button></div>' });
                    const input = route.request().postDataJSON();
                    calls.push(input.action);
                    const result = await f.api(input);
                    if (calls.length === 1) { started(); if (!duringSave) await held; }
                    return route.fulfill({ json: result });
                });
                await exam.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/shared-bank');
                await exam.evaluate(() => {
                    window.__CX_AI_CONFIG__ = { enabled: false };
                    window.__cefNativeAiProxy = { questionBank: true };
                });
                await exam.evaluate(shim);
                await exam.evaluate(() => { __cefDeepSeek.openSettings(); __cefDeepSeek.configure({ bankAnswerMode: 'only', answerDelayMs: 0 }); });
                await first;
                if (duringSave) await exam.waitForFunction(() => document.querySelector('.questionLi textarea').value === '旧答案');
                await exam.evaluate(() => __cxUpstreamAI.setPaused(true, false));
                release();
                await exam.waitForFunction(() => Object.values(window.aiAnswersData || {}).some(item => item.answer === '旧答案'));

                await f.api({ action: 'import', payload: payload('共享库', [{ ...original, answer: '修正答案' }]) });
                const [{ id }] = (await f.api({ action: 'conflicts' })).conflicts;
                const { revision } = await f.api({ action: 'conflictDetail', id });
                assert((await f.api({ action: 'resolve', id, revision, decision: 'incoming' })).ok);
                await exam.evaluate(() => {
                    document.querySelector('#answerSave').disabled = false;
                    __cxUpstreamAI.setPaused(false, false);
                });
                if (duringSave) {
                    await exam.locator('#cef-deepseek-settings').getByText(/当前内容未保存/).first().waitFor();
                    assert.equal(await exam.evaluate(() => window.saved), undefined);
                    assert.deepEqual(calls, ['lookup', 'revision']);
                    await exam.evaluate(() => { __cxUpstreamAI.retryFailed(); });
                }
                await exam.waitForFunction(() => window.saved === '修正答案');
                assert.deepEqual(calls, ['lookup', 'revision', 'lookup']);
            } finally { release(); await exam.close(); }
        }
    } finally { await f.close(); }
});

test('import previews collect locations, cancel without writes and require confirmation', { timeout: 45000 }, async () => {
    const f = await fixture();
    try {
        await f.bank();
        const bad = payload('预检', [question('ok'), { ...question('bad'), answer: ['Z'] }, { ...question('bad2'), type: 'unsupported' }]);
        await f.file(bad); await f.statusIncludes('预检发现问题');
        assert.match(await f.panel.locator('#bankPreview').textContent(), /questions\[1\]/);
        assert.match(await f.panel.locator('#bankPreview').textContent(), /questions\[2\]/);
        assert(await f.panel.locator('#bankConfirm').isDisabled()); assert.equal((await f.api({ action: 'status' })).count, 0);
        const download = f.page.waitForEvent('download'); await f.panel.locator('#bankErrorExport').click(); assert.equal((await download).suggestedFilename(), '题库导入问题.txt');
        const valid = payload('预检', [{ ...question('q1', '测试题干[图片:x]'), images: [{ id: 'x', dataUrl: png }] }]);
        await f.file(valid); await f.waitEnabled('bankConfirm'); assert.equal((await f.api({ action: 'status' })).count, 0);
        await f.panel.locator('#bankCancelImport').click(); assert(await f.panel.locator('#bankConfirm').isDisabled());
        await f.file(valid); await f.waitEnabled('bankConfirm'); await f.panel.locator('#bankConfirm').click(); await f.statusIncludes('导入完成');
        assert.equal((await f.api({ action: 'status' })).count, 1);
        await f.panel.locator('#bankBrowseTab').click();
        await f.panel.locator('#bankSearch').click(); await f.statusIncludes('本页 1');
        await f.panel.locator('#bankResults > details > summary').click();
        const loadImage = f.panel.getByRole('button', { name: '加载 1 张图片' });
        await loadImage.waitFor();
        await f.page.evaluate(() => {
            window.bankInvalidations = 0;
            document.addEventListener('cef-ai-invalidated', () => window.bankInvalidations++);
        });
        await f.file(valid); await f.waitEnabled('bankConfirm'); await f.panel.locator('#bankConfirm').click();
        await f.statusIncludes('新增 0，重复跳过 1，待处理冲突 0');
        assert.equal(await f.page.evaluate(() => window.bankInvalidations), 0);
        await f.panel.locator('#bankBrowseTab').click();
        await loadImage.click(); await f.panel.locator('#bankResults img').waitFor();
        await f.file(valid); await f.waitEnabled('bankConfirm');
        await f.api({ action: 'import', payload: payload('外部变化', [question('external')]) });
        await f.panel.locator('#bankConfirm').click(); await f.statusIncludes('预览后已变化');
        await f.file('{"schemaVersion":1,\n"questions": [}'); await f.statusIncludes('预检失败'); assert(await f.panel.locator('#bankConfirm').isDisabled());
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('preflight rejects blank answers and locates native Word formulas before import', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        await f.bank();
        await f.file(payload('纯空白', [
            { type: 'text', stem: '简答题', answer: '\t　 ' },
            { type: 'blank', stem: '填空题', answer: [[' \t ']] }
        ]));
        await f.statusIncludes('预检发现问题');
        const preview = f.panel.locator('#bankPreview');
        assert.match(await preview.textContent(), /questions\[0\].*简答题答案必须是非空文字/);
        assert.match(await preview.textContent(), /questions\[1\].*填空答案必须是非空文字/);
        assert(await f.panel.locator('#bankConfirm').isDisabled());

        const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>' +
            '<w:p><w:r><w:t>8.【简答题】求 </w:t></w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath><w:r><w:t> 的值</w:t></w:r></w:p>' +
            '<w:p><w:r><w:t>答案：2</w:t></w:r></w:p></w:body></w:document>';
        const bytes = zipSync({ 'word/document.xml': strToU8(xml) });
        await f.panel.locator('#bankFile').setInputFiles({ name: '原生公式.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(bytes) });
        await f.statusIncludes('预检发现问题');
        assert.match(await preview.textContent(), /Word 第 8 题（段落 1）.*Word 原生公式/);
        assert(await f.panel.locator('#bankConfirm').isDisabled());
        assert.equal((await f.api({ action: 'status' })).count, 0);
    } finally { await f.close(); }
});

test('conflict decisions and review page use native results and preserve changed answers', { timeout: 45000 }, async () => {
    const f = await fixture();
    try {
        const original = question('q1'), incoming = { ...original, answer: ['B'], explanation: '<img src=x onerror=alert(1)>' };
        await f.api({ action: 'import', payload: payload('冲突课', [original]) });
        await f.api({ action: 'import', payload: payload('冲突课', [incoming]) });
        await f.bank(); assert.equal((await f.ask('测试题干')).code, 'BANK_AMBIGUOUS');
        await f.panel.locator('#bankReviewTab').click(); assert.match(await f.panel.locator('#bankReviews').textContent(), /答案冲突/);
        await f.panel.locator('#bankReviews > details > summary').click();
        await f.panel.locator('#bankReviews details details > summary').click();
        await f.panel.locator('#bankReviews').getByText('题库当前内容', { exact: true }).waitFor();
        await f.panel.locator('#bankConflictTab').click(); await f.statusIncludes('展开冲突');
        await f.panel.locator('#bankConflicts > details > summary').click();
        await f.panel.getByRole('button', { name: '采用新题', exact: true }).waitFor();
        assert.equal(await f.panel.locator('#bankConflicts img').count(), 0);
        assert((await f.api({ action: 'import', payload: payload('其他课', [question('unrelated', '另一题')]) })).ok);
        await f.panel.getByRole('button', { name: '采用新题', exact: true }).click(); await f.statusIncludes('冲突已处理');
        assert.equal((await f.api({ action: 'status' })).conflicts, 0);
        const result = await f.ask('测试题干'); assert.equal(result.success, true);
        await f.panel.locator('#bankReviewTab').click(); await f.panel.locator('#bankReviewFilter').selectOption('matched');
        assert.equal(await f.panel.locator('#bankReviews > details').count(), 1);
        await f.ask('测试题干', ['选项甲', '错误选项']); await f.panel.locator('#bankReviewFilter').selectOption('options-mismatch');
        assert.equal(await f.panel.locator('#bankReviews > details').count(), 1);
        await f.api({ action: 'import', payload: payload('冲突课', [original]) });
        await f.panel.locator('#bankConflictTab').click(); await f.statusIncludes('展开冲突');
        await f.panel.locator('#bankConflicts > details > summary').click();
        await f.panel.getByText('手动修正（保留原题图片）', { exact: true }).click();
        await f.panel.getByLabel('题干', { exact: true }).fill('修正题干');
        await f.panel.getByRole('radio', { name: 'A. 选项甲', exact: true }).check();
        await f.panel.getByRole('button', { name: '保存修正', exact: true }).click(); await f.statusIncludes('冲突已处理');
        assert.equal((await f.ask('修正题干')).success, true);
        await f.panel.locator('#bankReviewTab').click(); await f.panel.locator('#bankReviewFilter').selectOption('');
        const screenshot = path.join(root, 'out', 'question-bank-review.png'); await f.page.screenshot({ path: screenshot });
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('conflict navigation defers loading, preserves drafts and refreshes details after an actual change', { timeout: 30000 }, async () => {
    const f = await fixture();
    let release;
    try {
        const original = question('same', '冲突题干');
        await f.api({ action: 'import', payload: payload('冲突课', [original]) });
        await f.ask(original.stem);
        await f.bank(); await f.panel.locator('#bankReviewTab').click();
        const review = f.panel.locator('#bankReviews > details');
        await review.locator(':scope > summary').click();
        const candidate = review.locator('.bank-result');
        await candidate.locator('summary').click();
        await candidate.getByText('答案： A. 选项甲', { exact: true }).waitFor();

        await f.api({ action: 'import', payload: payload('冲突课', ['新解析一', '新解析二'].map(explanation => ({ ...original, answer: ['B'], explanation }))) });
        const held = new Promise(resolve => { release = resolve; });
        await f.page.route('**/__cef_cx_ai_proxy__/question-bank', async route => {
            if (route.request().postDataJSON().action === 'search') await held;
            await route.continue();
        });
        await f.panel.locator('#bankBrowseTab').click();
        const searched = f.page.waitForRequest(request => request.url().endsWith('/question-bank') && request.postDataJSON().action === 'search');
        await f.panel.locator('#bankSearch').click(); await searched;
        await f.panel.locator('#bankConflictTab').click(); release();
        const list = f.panel.locator('#bankConflicts > details');
        await list.last().waitFor(); assert.equal(await list.count(), 2);
        for (const item of [list.first(), list.last()]) {
            await item.locator(':scope > summary').click();
            await item.getByRole('button', { name: '采用新题', exact: true }).waitFor();
        }
        await list.last().getByText('手动修正（保留原题图片）', { exact: true }).click();
        await list.last().getByLabel('题干', { exact: true }).fill('未保存的手工修正');
        await f.panel.locator('#bankBrowseTab').click(); await f.panel.locator('#bankConflictTab').click();
        await f.waitEnabled('bankConflictRefresh');
        assert.equal(await list.last().getByLabel('题干', { exact: true }).inputValue(), '未保存的手工修正');

        await list.first().getByRole('button', { name: '采用新题', exact: true }).click(); await f.statusIncludes('冲突已处理');
        assert.equal(await list.count(), 1);
        await list.first().locator(':scope > summary').click();
        const current = list.first().locator(':scope > div > details').first();
        await current.getByText('答案： B. 选项乙', { exact: true }).waitFor();
        await list.first().getByRole('button', { name: '保留原题', exact: true }).click();
        await list.first().waitFor({ state: 'detached' });

        await f.panel.locator('#bankReviewTab').click();
        await candidate.locator('summary').click();
        await candidate.getByText('答案： B. 选项乙', { exact: true }).waitFor();
        assert.match(await review.textContent(), /匹配结果：\["B"\]/, 'the historical choice is still recorded in the original page order');
    } finally { if (release) release(); await f.close(); }
});

test('external conflict resolution refreshes reopened review and keeps edits through a rejected stale save', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const original = question('same', '冲突题干');
        const insert = q => f.api({ action: 'import', payload: payload('冲突课', [q]) });
        await insert(original); await f.ask(original.stem);
        await f.bank(); await f.panel.locator('#bankReviewTab').click();
        const review = f.panel.locator('#bankReviews > details'); await review.locator(':scope > summary').click();
        const card = review.locator('.bank-result'); await card.locator('summary').click();
        await card.getByText('答案： A. 选项甲', { exact: true }).waitFor();

        await insert({ ...original, answer: ['B'], explanation: '待修正' });
        await insert({ ...original, answer: ['B'], options: [original.options[0], { id: 'B', text: '另一页改过的选项' }] });
        await f.panel.locator('#bankConflictTab').click(); await f.statusIncludes('展开冲突');
        const rows = f.panel.locator('#bankConflicts > details');
        const edit = async () => {
            await rows.first().locator(':scope > summary').click();
            await rows.first().getByText('手动修正（保留原题图片）', { exact: true }).click();
        };
        await edit(); await rows.first().getByLabel('题干', { exact: true }).fill('本地草稿');
        const entries = (await f.api({ action: 'conflicts' })).conflicts;
        const external = await f.api({ action: 'conflictDetail', id: entries[1].id });
        assert((await f.api({ action: 'resolve', id: entries[1].id, revision: external.revision, decision: 'incoming' })).questionChanged);

        await f.panel.locator('#bankReviewTab').click();
        await card.locator('summary').click(); await card.locator('summary').click();
        await card.getByText('答案： B. 另一页改过的选项', { exact: true }).waitFor();
        await f.panel.locator('#bankConflictTab').click(); await f.waitEnabled('bankConflictRefresh');
        await rows.first().getByRole('button', { name: '保存修正', exact: true }).click(); await f.statusIncludes('原题已变化');
        await edit();
        assert.equal(await rows.first().getByLabel('题干', { exact: true }).inputValue(), '本地草稿');
        assert.equal(await rows.first().getByLabel('选项 B', { exact: true }).inputValue(), '另一页改过的选项');
        assert(await rows.first().getByRole('radio', { name: 'B. 另一页改过的选项', exact: true }).isChecked());
        await rows.first().getByRole('button', { name: '保存修正', exact: true }).click(); await f.statusIncludes('冲突已处理');
        const saved = (await f.api({ action: 'detail', id: entries[0].dbId })).question;
        assert.equal(saved.stem, '本地草稿'); assert.deepEqual(saved.answer, ['B']);
    } finally { await f.close(); }
});

test('a conflict draft on the second page survives a refresh after an unrelated import', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        f.page.setDefaultTimeout(5000);
        const originals = Array.from({ length: 21 }, (_, i) => ({ id: String(i), type: 'blank', stem: '冲突题目 ' + (i + 1), answer: [['原答案']] }));
        assert.equal((await f.api({ action: 'import', payload: payload('冲突课', originals) })).inserted, 21);
        assert.equal((await f.api({ action: 'import', payload: payload('冲突课', originals.map(q => ({ ...q, answer: [['新答案']] }))) })).importConflicts, 21);
        await f.bank(); await f.panel.locator('#bankConflictTab').click(); await f.statusIncludes('展开冲突');
        const list = f.panel.locator('#bankConflicts > details');
        async function editLastPage() {
            await f.panel.locator('#bankConflictMore').click(); await f.waitEnabled('bankConflictRefresh');
            assert.equal(await list.count(), 21);
            await list.last().locator(':scope > summary').click();
            await list.last().getByText('手动修正（保留原题图片）', { exact: true }).click();
        }
        await editLastPage();
        await list.last().getByLabel('题干', { exact: true }).fill('第 21 条草稿');
        await list.last().getByRole('button', { name: '添加可接受答案', exact: true }).click();
        await list.last().getByLabel('可接受答案', { exact: true }).last().fill('另一个答案');
        assert.equal((await f.api({ action: 'import', payload: payload('其他课', [question('unrelated', '无关新增')]) })).inserted, 1);
        await f.panel.locator('#bankBrowseTab').click(); await f.panel.locator('#bankConflictTab').click();
        await f.waitEnabled('bankConflictRefresh');
        await editLastPage();
        assert.equal(await list.last().getByLabel('题干', { exact: true }).inputValue(), '第 21 条草稿');
        assert.deepEqual(await list.last().getByLabel('可接受答案', { exact: true }).evaluateAll(fields => fields.map(field => field.value)), ['原答案', '另一个答案']);

        const previousId = Number(await list.last().getAttribute('data-conflict-id'));
        const previous = await f.api({ action: 'conflictDetail', id: previousId });
        assert((await f.api({ action: 'resolve', decision: 'keep', id: previousId, revision: previous.revision })).ok);
        assert.equal((await f.api({ action: 'import', payload: payload('冲突课', [{ ...originals.at(-1), answer: [['另一版答案']] }]) })).importConflicts, 1);
        await list.last().getByRole('button', { name: '保存修正', exact: true }).click();
        await f.statusIncludes('该冲突已处理，请刷新列表');
        await f.panel.locator('#bankConflictRefresh').click(); await f.waitEnabled('bankConflictRefresh');
        await editLastPage();
        assert(Number(await list.last().getAttribute('data-conflict-id')) > previousId);
        assert.equal(await list.last().getByLabel('题干', { exact: true }).inputValue(), originals.at(-1).stem);
        assert.deepEqual(await list.last().getByLabel('可接受答案', { exact: true }).evaluateAll(fields => fields.map(field => field.value)), ['原答案']);
    } finally { await f.close(); }
});

test('loading more after another page resolves a conflict refreshes the first page and preserves its draft', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const originals = Array.from({ length: 21 }, (_, i) => question(String(i), '冲突分页题 ' + i));
        assert.equal((await f.api({ action: 'import', payload: payload('冲突课', originals) })).inserted, 21);
        assert.equal((await f.api({ action: 'import', payload: payload('冲突课', originals.map(q => ({ ...q, answer: ['B'] }))) })).importConflicts, 21);
        await f.bank(); await f.panel.locator('#bankConflictTab').click(); await f.statusIncludes('展开冲突');
        const list = f.panel.locator('#bankConflicts > details');
        const removedId = Number(await list.first().getAttribute('data-conflict-id'));
        await list.nth(1).locator(':scope > summary').click();
        await list.nth(1).getByText('手动修正（保留原题图片）', { exact: true }).click();
        await list.nth(1).getByLabel('题干', { exact: true }).fill('分页前的草稿');
        const { revision } = await f.api({ action: 'conflictDetail', id: removedId });
        assert((await f.api({ action: 'resolve', id: removedId, revision, decision: 'keep' })).ok);
        await f.panel.locator('#bankConflictMore').click(); await f.statusIncludes('已从第一页更新冲突');
        assert.equal(await list.count(), 20);
        assert.match(await f.panel.locator('#bankSummary').textContent(), /20 条待处理冲突/);
        assert.notEqual(Number(await list.first().getAttribute('data-conflict-id')), removedId);
        assert(await f.panel.locator('#bankConflictMore').isDisabled());
        await list.first().locator(':scope > summary').click();
        await list.first().getByText('手动修正（保留原题图片）', { exact: true }).click();
        assert.equal(await list.first().getByLabel('题干', { exact: true }).inputValue(), '分页前的草稿');
    } finally { await f.close(); }
});

test('lookup keeps initials in either option position and surfaces a match beyond the review limit', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const stem = 'Which author wrote the essay?';
        const unrelated = Array.from({ length: 9 }, (_, i) => {
            const other = question('other-' + i, stem);
            other.options[0].text = 'Other author ' + i;
            return other;
        });
        assert.equal((await f.api({ action: 'import', payload: payload('其他版本', unrelated) })).inserted, 9);
        const q = question('authors', stem);
        q.options[0].text = 'A. Smith'; q.options[1].text = 'C. Brown';
        assert.equal((await f.api({ action: 'import', payload: payload('作者题库', [q]) })).inserted, 1);
        assert.deepEqual((await f.ask(stem, ['A. Smith', 'C. Brown'])).list, [['A']]);
        assert.deepEqual((await f.ask(stem, ['C. Brown', 'A. Smith'])).list, [['B']]);
        assert.deepEqual(f.requests.filter(r => r.action === 'lookup').map(r => r.options), [['A. Smith', 'C. Brown'], ['C. Brown', 'A. Smith']]);
        await f.bank(); await f.panel.locator('#bankReviewTab').click();
        await f.panel.locator('#bankReviews > details > summary').first().click();
        const entries = f.panel.locator('#bankReviews > details').first().locator('.bank-result');
        assert.equal(await entries.count(), 8);
        assert.match(await entries.first().locator('summary').textContent(), /命中.*作者题库/);
        await entries.first().locator('summary').click();
        await entries.first().getByText('✓ A. Smith', { exact: true }).waitFor();
    } finally { await f.close(); }
});

test('image preflight rejects damaged attachments and a readable candidate can still match in an older bank', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const image = await f.page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 12; return canvas.toDataURL(); });
        const stem = '题面有八张图片';
        const broken = question('bad', stem + '[图片:x]'.repeat(8));
        broken.images = [{ id: 'x', dataUrl: 'data:image/png;base64,AAAA' }];
        await f.bank(); await f.file(payload('图片课', [broken]));
        await f.statusIncludes('预检发现问题');
        assert.match(await f.panel.locator('#bankPreview').textContent(), /图片无法解码.*图片:x/);
        assert(await f.panel.locator('#bankConfirm').isDisabled());
        assert.equal((await f.api({ action: 'status' })).count, 0);

        const good = { ...broken, id: 'good', answer: ['B'], images: [{ id: 'x', dataUrl: image }] };
        assert.equal((await f.api({ action: 'import', payload: payload('旧题库', [broken, good]) })).inserted, 2);
        const result = await f.page.evaluate(async ({ image, stem }) => {
            const root = document.createElement('div'); document.body.append(root);
            for (let i = 0; i < 8; i++) {
                const img = document.createElement('img'); img.src = image; root.append(img); await img.decode();
            }
            return __cefDeepSeek.answer({ question: stem, options: ['选项甲', '选项乙'], type: 0, root });
        }, { image, stem });
        assert.deepEqual(result.list, [['B']]); assert.equal(result.needsReview, true);
        await f.panel.locator('#bankReviewTab').click();
        assert.match(await f.panel.locator('#bankReviews').textContent(), /候选题图无法读取.*旧题库/);
    } finally { await f.close(); }
});

test('review keeps distinct image questions and leaves loaded candidate details open', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const images = await f.page.evaluate(() => ['red', 'blue'].map(color => {
            const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 12;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 20, 12); return canvas.toDataURL();
        }));
        const stem = '请选择图示设备';
        const questions = images.map((dataUrl, i) => ({ ...question(String(i), stem + '[图片:x]'), answer: [i ? 'B' : 'A'], images: [{ id: 'x', dataUrl }] }));
        await f.api({ action: 'import', payload: payload('图题', questions) });
        const answer = image => f.page.evaluate(({ stem, image }) => __cefDeepSeek.answer({ type: 0, question: stem, options: ['选项甲', '选项乙'], images: [image] }), { stem, image });
        assert.deepEqual((await answer(images[0])).list, [['A']]);
        await f.bank(); await f.panel.locator('#bankReviewTab').click();
        const rows = f.panel.locator('#bankReviews > details');
        await rows.first().locator(':scope > summary').click();
        await rows.first().locator('.bank-result summary').first().click();
        await rows.first().getByText('题库当前内容', { exact: true }).waitFor();
        assert.deepEqual((await answer(images[1])).list, [['B']]);
        assert.equal(await rows.count(), 2);
        assert.equal(await rows.last().locator('.bank-result[open]').count(), 1);
        assert(await rows.last().getByText('题库当前内容', { exact: true }).isVisible());
    } finally { await f.close(); }
});

test('importing and changing the bank scope leave an active chat request running', { timeout: 30000 }, async () => {
    const f = await fixture();
    let release;
    try {
        await f.page.evaluate(() => __cefDeepSeek.configure({ enabled: true, bankAnswerMode: 'only', apiKey: 'fixture', baseUrl: location.origin + '/v1' }));
        const held = new Promise(resolve => { release = resolve; });
        const opened = f.page.waitForRequest('**/v1/chat/completions', { timeout: 5000 });
        await f.page.route('**/__cef_cx_ai_proxy__/health', route => route.fulfill({ json: { cefCxAiProxy: 1 } }));
        await f.page.route('**/v1/chat/completions', async route => {
            await held;
            await route.fulfill({ json: { choices: [{ message: { content: '对话继续' } }] } });
        });
        await f.page.evaluate(() => {
            window.chatOutcome = __cefDeepSeek.chat([{ role: 'user', content: '继续解释' }]).then(value => value, error => error.code);
        });
        await opened;
        await f.bank(); await f.file(payload('新题库', [question('new')]));
        await f.waitEnabled('bankConfirm'); await f.panel.locator('#bankConfirm').click(); await f.statusIncludes('新增 1');
        await f.panel.locator('#bankBrowseTab').click();
        await f.panel.getByText('题库答题设置', { exact: true }).click();
        await f.panel.locator('#bankScope').selectOption('新题库');
        assert.equal(await f.page.evaluate(() => __cefDeepSeek.status().chatRequest.state), 'waiting');
        release();
        assert.equal(await f.page.evaluate(() => chatOutcome), '对话继续');
        assert.deepEqual((await f.ask('测试题干')).list, [['B']]);
    } finally { if (release) release(); await f.close(); }
});

test('manual conflict answers use the selected option ID verbatim', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const q = question('id');
        q.options[0].id = 'A,1'; q.options[1].id = 'B,2'; q.answer = ['A,1'];
        await f.api({ action: 'import', payload: payload('编号', [q]) });
        await f.api({ action: 'import', payload: payload('编号', [{ ...q, answer: ['B,2'] }]) });
        await f.bank(); await f.panel.locator('#bankConflictTab').click(); await f.panel.locator('#bankConflicts > details > summary').click();
        await f.panel.getByText('手动修正（保留原题图片）', { exact: true }).click();
        await f.panel.getByRole('radio', { name: 'B,2. 选项乙', exact: true }).check();
        await f.panel.getByRole('button', { name: '保存修正', exact: true }).click(); await f.statusIncludes('冲突已处理');
        assert.deepEqual(f.requests.find(r => r.action === 'resolve').question.answer, ['B,2']);
        assert.deepEqual((await f.ask('测试题干')).list, [['A']]);
    } finally { await f.close(); }
});

test('editing a conflict preserves literal pipes and line breaks in untouched blank answers', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const answer = [['cat log | wc -l', 'cat log\r\nwc -l'], ['done']];
        const original = { id: 'pipe', type: 'blank', stem: '填写两段命令', answer };
        await f.api({ action: 'import', payload: payload('命令课', [original]) });
        await f.api({ action: 'import', payload: payload('命令课', [{ ...original, explanation: '新解析' }]) });
        await f.bank(); await f.panel.locator('#bankConflictTab').click();
        await f.panel.locator('#bankConflicts > details > summary').click();
        await f.panel.getByText('手动修正（保留原题图片）', { exact: true }).click();
        assert.equal(await f.panel.getByLabel('可接受答案', { exact: true }).count(), 3);
        await f.panel.getByLabel('解析', { exact: true }).fill('只修改解析');
        await f.panel.getByRole('button', { name: '保存修正', exact: true }).click(); await f.statusIncludes('冲突已处理');
        const row = (await f.api({ action: 'search', bank: '命令课' })).questions[0];
        const detail = (await f.api({ action: 'detail', id: row.dbId })).question;
        assert.deepEqual(detail.answer, answer);
        assert.equal(detail.explanation, '只修改解析');
    } finally { await f.close(); }
});

test('Word preview reports multiple original question numbers and paragraphs', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const paragraphs = ['10.【判断题】缺少答案的题', '21.【单选题】答案错误的题', 'A.选项甲', 'B.选项乙', '答案：Z', '30.【判断题】有效题目', '答案：对'];
        const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs.map(p => '<w:p><w:r><w:t>' + p + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>';
        const bytes = zipSync({ 'word/document.xml': strToU8(xml) });
        await f.bank(); await f.panel.locator('#bankImportTab').click();
        await f.panel.locator('#bankFile').setInputFiles({ name: '定位.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(bytes) });
        await f.statusIncludes('预检发现问题');
        const text = await f.panel.locator('#bankPreview').textContent(); assert.match(text, /Word 第 10 题（段落 1）/); assert.match(text, /Word 第 21 题（段落 2）/);
        assert(await f.panel.locator('#bankConfirm').isDisabled()); assert.equal((await f.api({ action: 'status' })).count, 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('Word and page headings can differ while the question body still identifies the answer', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const paragraphs = ['87.【简答题】【案例背景】某管道工程，计划 9 月 1 日开工。', '答案：按合同计划执行',
            '88.【简答题】【IPv4】地址长度是多少？', '答案：32 位'];
        const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs.map(p => '<w:p><w:r><w:t>' + p + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>';
        const bytes = zipSync({ 'word/document.xml': strToU8(xml) });
        await f.bank(); await f.panel.locator('#bankImportTab').click();
        await f.panel.locator('#bankFile').setInputFiles({ name: '案例.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(bytes) });
        await f.waitEnabled('bankConfirm'); await f.panel.locator('#bankConfirm').click(); await f.statusIncludes('导入完成');

        const stem = '89.（简答题，5．0 分）\n【背景资料】：【材料】某管道工程,计划9月1日开工?';
        assert.deepEqual((await f.ask(stem, [], 4)).list, [['按合同计划执行']]);
        assert.equal((await f.ask(stem.replace('9月1日', '9月2日'), [], 4)).code, 'BANK_MISS');
        assert.deepEqual((await f.ask('90.（简答题，5 分）【IPv4】地址长度是多少?', [], 4)).list, [['32 位']]);
        assert.equal((await f.ask('90.（简答题，5 分）【IPv6】地址长度是多少?', [], 4)).code, 'BANK_MISS');

        assert((await f.api({ action: 'import', payload: payload('另一套题', [{ type: 'text', stem: '【背景资料】：【材料】某管道工程，计划 9 月 1 日开工。', answer: '另行报审' }]) })).ok);
        assert.equal((await f.ask(stem, [], 4)).code, 'BANK_AMBIGUOUS');
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('Word preserves code indentation and distinguishes formula parentheses from blank labels', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const paragraphs = [
            '1.【填空题】填写两个函数 __ __', '答案：f(2);g(3)',
            '2.【填空题】填写带编号的条款 __ __', '答案：(1) (1) 第一条；(2) (2) 第二条',
            '3.【填空题】填写编号函数 __ __', '答案：(1) f (2)；(2) g(3)',
            '4.【简答题】附有题图的题目'
        ];
        const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
            '<w:p><w:r><w:drawing><a:blip r:link="cover"/></w:drawing></w:r></w:p>' +
            paragraphs.map(text => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>').join('') +
            '<w:p><w:r><w:drawing><a:blip r:embed="diagram"/></w:drawing></w:r></w:p><w:p><w:r><w:t>答案：示意图</w:t></w:r></w:p>' +
            ['5.【编程题】输出两个数字', '答案：', 'for i in range(2):', '    print(i)', '', 'print("done")', ''].map(text => '<w:p><w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>').join('') +
            '</w:body></w:document>';
        const bytes = zipSync({
            'word/document.xml': strToU8(xml),
            'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="diagram" Target="media/diagram.png"/></Relationships>'),
            'word/media/diagram.png': Buffer.from(png.split(',')[1], 'base64')
        });
        await f.bank(); await f.panel.locator('#bankImportTab').click();
        await f.panel.locator('#bankFile').setInputFiles({ name: '公式.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(bytes) });
        await f.waitEnabled('bankConfirm'); await f.panel.locator('#bankConfirm').click(); await f.statusIncludes('新增 5');
        const search = await f.api({ action: 'search', bank: '公式' });
        assert.equal(search.questions.find(q => q.stem.startsWith('附有题图的题目')).imageCount, 1);
        const formulas = await f.api({ action: 'lookup', type: 'blank', stem: '填写两个函数 __ __', blanks: 2 });
        const numbered = await f.api({ action: 'lookup', type: 'blank', stem: '填写带编号的条款 __ __', blanks: 2 });
        const numberedFormulas = await f.api({ action: 'lookup', type: 'blank', stem: '填写编号函数 __ __', blanks: 2 });
        assert.deepEqual(formulas.answer.answers, ['f(2)', 'g(3)']);
        assert.deepEqual(numbered.answer.answers, ['(1) 第一条', '(2) 第二条']);
        assert.deepEqual(numberedFormulas.answer.answers, ['f (2)', 'g(3)']);
        assert.deepEqual((await f.ask('输出两个数字', [], 4)).list, [['for i in range(2):\n    print(i)\n\nprint("done")']]);
    } finally { await f.close(); }
});

test('two Word questions can import the same large image with one attachment in the request', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const image = await f.page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1050;
            const ctx = canvas.getContext('2d'), data = ctx.createImageData(canvas.width, canvas.height), pixels = new Uint32Array(data.data.buffer);
            let seed = 123456789;
            for (let i = 0; i < pixels.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = seed | 0xff000000; }
            ctx.putImageData(data, 0, 0); return canvas.toDataURL();
        });
        const paragraph = text => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';
        const drawing = '<w:p><w:r><w:drawing><a:blip r:embed="diagram"/></w:drawing></w:r></w:p>';
        const body = [1, 2].map(i => paragraph(i + '.【简答题】观察图示 ' + i) + drawing + paragraph('答案：图示说明')).join('');
        const bytes = zipSync({
            'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' + body + '</w:body></w:document>'),
            'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="diagram" Target="media/diagram.png"/></Relationships>'),
            'word/media/diagram.png': Buffer.from(image.split(',')[1], 'base64')
        }, { level: 0 });
        assert(bytes.length < 4 * 1024 * 1024 && 2 * image.length > 9 * 1024 * 1024);
        await f.bank(); await f.panel.locator('#bankImportTab').click();
        await f.panel.locator('#bankFile').setInputFiles({ name: '共用题图.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(bytes) });
        await f.waitEnabled('bankConfirm'); await f.panel.locator('#bankConfirm').click(); await f.statusIncludes('新增 2');
        for (const { payload } of f.requests.filter(r => ['preview', 'import'].includes(r.action))) {
            assert.deepEqual(Object.keys(payload.sharedImages), ['img1']);
            assert.deepEqual(payload.questions.map(q => q.images), [[{ id: 'img1' }], [{ id: 'img1' }]]);
        }
        const result = await f.api({ action: 'search', bank: '共用题图' });
        assert.deepEqual(result.questions.map(q => q.imageCount), [1, 1]);
        const stored = await f.api({ action: 'images', id: result.questions[0].dbId });
        assert.equal(stored.images[0].dataUrl, image);
    } finally { await f.close(); }
});

test('long answers accepted by the bank reach the answer workflow in full', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const answer = 'x'.repeat(16001);
        const q = { type: 'text', stem: '填写完整的长文本', answer };
        assert.equal((await f.api({ action: 'import', payload: payload('长答案', [q]) })).inserted, 1);
        const result = await f.ask(q.stem, [], 4);
        assert.equal(result.success, true);
        assert.equal(result.list[0][0], answer);
    } finally { await f.close(); }
});

test('a failed one-blank lookup does not block a two-blank question with the same stem', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const q = { type: 'blank', stem: '相同题干', answer: [['第一空'], ['第二空']] };
        assert.equal((await f.api({ action: 'import', payload: payload('填空题', [q]) })).inserted, 1);
        const answers = await f.page.evaluate(async stem => {
            const results = [];
            for (const length of [1, 2]) {
                try { results.push((await __cefDeepSeek.answer({ question: stem, type: 2, $options: { length } })).list); }
                catch (error) { results.push(error.code); }
            }
            return results;
        }, q.stem);
        assert.deepEqual(answers, ['BANK_MISS', [['第一空', '第二空']]]);
        assert.deepEqual(f.requests.filter(request => request.action === 'lookup').map(request => request.blanks), [1, 2]);
    } finally { await f.close(); }
});

test('image candidates filter unrelated options before fetching pixels through the native route', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const image = await f.page.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 24; const x = c.getContext('2d'); x.fillStyle = '#1479bc'; x.fillRect(0, 0, 40, 24); return c.toDataURL(); });
        const q = question('image', '图片匹配[图片:x]'); q.images = [{ id: 'x', dataUrl: image }];
        q.options[0].text = 'A. Smith';
        const unrelated = Array.from({ length: 105 }, (_, i) => {
            const other = question('other-' + i, q.stem);
            other.images = q.images;
            other.options[0].text = '其他选项 ' + i;
            return other;
        });
        assert.equal((await f.api({ action: 'import', payload: payload('其他图片课程', unrelated) })).inserted, 105);
        await f.api({ action: 'import', payload: payload('图片课程', [q]) });
        for (const stem of ['', '图片匹配']) {
            const options = stem ? ['选项乙', 'A. Smith'] : ['A. Smith', '选项乙'];
            const result = await f.page.evaluate(async ({ image, stem, options }) => __cefDeepSeek.answer({ question: stem, options, type: 0, images: [image] }), { image, stem, options });
            assert.equal(result.success, true);
            assert.deepEqual(result.list, [[stem ? 'B' : 'A']]);
        }
        assert.deepEqual(f.requests.filter(r => ['lookup', 'images'].includes(r.action)).map(r => r.action), ['lookup', 'images', 'lookup', 'images']);
        await f.bank(); await f.panel.locator('#bankReviewTab').click();
        await f.panel.locator('#bankReviews > details > summary').first().click();
        assert.match(await f.panel.locator('#bankReviews .bank-result summary').first().textContent(), /命中.*图片课程/);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('a matching fill-in image with the wrong number of blanks appears under blank count differences', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const stem = '填空示意图';
        const q = { id: 'blank', type: 'blank', stem: stem + '[图片:x]', answer: [['甲'], ['乙']], images: [{ id: 'x', dataUrl: png }] };
        assert.equal((await f.api({ action: 'import', payload: payload('图形填空', [q]) })).inserted, 1);
        const result = await f.page.evaluate(async ({ stem, png }) => {
            try { return await __cefDeepSeek.answer({ question: stem, type: 2, images: [png], $options: [null] }); }
            catch (error) { return error.message; }
        }, { stem, png });
        assert.match(result, /答案组数与可填写位置不一致/);
        await f.bank(); await f.panel.locator('#bankReviewTab').click();
        await f.panel.locator('#bankReviewFilter').selectOption('blank-count-mismatch');
        assert.equal(await f.panel.locator('#bankReviews > details').count(), 1);
    } finally { await f.close(); }
});

test('image answers are skipped in bank-first mode with or without a stem image', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const images = [{ id: 'x', dataUrl: png }];
        const questions = ['画出电路', '画出示意图[图片:x]'].map(stem => ({ type: 'text', stem, answer: '[图片:x]', images }));
        assert.equal((await f.api({ action: 'import', payload: payload('图形答案', questions) })).inserted, 2);
        await f.page.evaluate(() => __cefDeepSeek.configure({ enabled: true, apiKey: 'fixture', baseUrl: location.origin, bankAnswerMode: 'first' }));
        for (const [question, images] of [['画出电路', []], ['画出示意图', [png]]]) {
            const error = await f.page.evaluate(async ({ question, images }) => {
                try { await __cefDeepSeek.answer({ question, images, type: 4 }); }
                catch (error) { return error.message; }
            }, { question, images });
            assert.match(error, /题库答案含图片/);
        }
    } finally { await f.close(); }
});

test('image matching keeps inline positions and mixed DOM order and excludes answer editor media', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const [red, blue] = await f.page.evaluate(() => ['red', 'blue'].map(color => {
            const c = document.createElement('canvas'); c.width = 20; c.height = 12;
            const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 20, 12); return c.toDataURL();
        }));
        const assets = [{ id: 'r', dataUrl: red }, { id: 'b', dataUrl: blue }];
        const questions = [
            { ...question('inline', '计算 2x[图片:r] + y 的值'), images: assets.slice(0, 1) },
            { ...question('option', '请选择正确表达式'), options: [{ id: 'A', text: 'x[图片:r] + y' }, { id: 'B', text: '其他' }], images: assets.slice(0, 1) },
            { ...question('ordered', '比较上面画布和下面图片[图片:r][图片:b]'), images: assets },
            { type: 'text', stem: '概括原理', answer: '电路实现' }
        ];
        await f.api({ action: 'import', payload: payload('题图课', questions) });
        const result = await f.page.evaluate(async ({ red, blue }) => {
            const img = async src => { const node = new Image(); node.src = src; await node.decode(); return node; };
            const ask = (root, stem, type = 0, $options = []) => __cefDeepSeek.answer({ root, question: stem, options: ['选项甲', '选项乙'], type, $options }).then(x => x.list, e => e.code);
            const h3 = document.createElement('h3'); document.body.append(h3);
            const exponent = await img(red); h3.append('计算 2x', exponent, ' + y 的值');
            const correct = await ask(h3, h3.textContent);
            h3.replaceChildren('计算 2x + y', exponent, ' 的值');
            const moved = await ask(h3, h3.textContent);
            const root = document.createElement('div'); document.body.append(root);
            const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 12;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 20, 12);
            root.append(canvas, await img(blue));
            const ordered = await ask(root, '比较上面画布和下面图片');
            const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.append(await img(red)); root.replaceChildren(editor);
            const text = await ask(root, '概括原理', 4, [editor]);
            const a = document.createElement('div'), b = document.createElement('div'); a.className = b.className = 'answerBg';
            const option = document.createElement('span'), marker = document.createElement('span'), power = await img(red);
            option.className = 'answer_p'; marker.className = 'mark_letter'; marker.textContent = 'A.';
            option.append(marker, 'x', power, ' + y'); a.append(option); b.textContent = '其他'; root.replaceChildren(a, b);
            const askOption = () => __cefDeepSeek.answer({ root, question: '请选择正确表达式', type: 0, options: ['x + y', '其他'], $options: [a, b] }).then(x => x.list, e => e.code);
            const optionCorrect = await askOption(); option.replaceChildren(marker, 'x + y', power);
            const optionMoved = await askOption();
            return { correct, moved, ordered, text, optionCorrect, optionMoved };
        }, { red, blue });
        assert.deepEqual(result, { correct: [['A']], moved: 'BANK_MISS', ordered: [['A']], text: [['电路实现']], optionCorrect: [['A']], optionMoved: 'BANK_MISS' });
    } finally { await f.close(); }
});

test('image-only options keep text candidate filtering and a revision change retries the lookup once', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const image = await f.page.evaluate(() => { const c = document.createElement('canvas'); c.width = 20; c.height = 12; return c.toDataURL(); });
        const stem = '选择合适的设备';
        const questions = Array.from({ length: 22 }, (_, i) => ({ ...question(String(i), stem),
            options: [{ id: 'A', text: '[图片:x]' }, { id: 'B', text: '设备 ' + i }], images: [{ id: 'x', dataUrl: image }] }));
        await f.api({ action: 'import', payload: payload('图片选项', questions) });
        let changed = false;
        await f.page.route('**/__cef_cx_ai_proxy__/question-bank', async route => {
            if (route.request().postDataJSON().action === 'images' && !changed) {
                changed = true;
                await f.api({ action: 'import', payload: payload('另一门课', [question('other', '无关题目')]) });
            }
            await route.continue();
        });
        const result = await f.page.evaluate(async ({ image, stem }) => {
            const img = new Image(); img.src = image; await img.decode();
            const a = document.createElement('div'), b = document.createElement('div'), root = document.createElement('div');
            a.append(img); b.textContent = '设备 21'; root.append(a, b); document.body.append(root);
            return __cefDeepSeek.answer({ root, question: stem, type: 0, options: ['', '设备 21'], $options: [a, b] });
        }, { image, stem });
        assert.deepEqual(result.list, [['A']]);
        assert.deepEqual(f.requests.filter(r => ['lookup', 'images'].includes(r.action)).map(r => r.action), ['lookup', 'images', 'lookup', 'images']);
    } finally { await f.close(); }
});

test('inserting an earlier image in Word still imports a revision as a conflict', { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
        const paragraph = text => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';
        const image = id => '<w:p><w:r><w:drawing><a:blip r:embed="' + id + '"/></w:drawing></w:r></w:p>';
        const wordQuestion = (number, stem, id, answer) => paragraph(number + '.【简答题】' + stem) + image(id) + paragraph('答案：' + answer);
        for (const edited of [false, true]) {
            const body = (edited ? wordQuestion(1, '新增题目', 'new', '新答案') : '') + wordQuestion(2, '旧题目', 'old', edited ? '修订答案' : '原答案');
            const bytes = zipSync({
                'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' + body + '</w:body></w:document>'),
                'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="new" Target="media/new.png"/><Relationship Id="old" Target="media/old.png"/></Relationships>'),
                'word/media/new.png': Buffer.from(png.split(',')[1], 'base64'),
                'word/media/old.png': Buffer.from(png.split(',')[1], 'base64')
            });
            const parsed = await f.page.evaluate(bytes => __cefParseBankDocx(new Uint8Array(bytes), '同一套题.docx').payload, [...bytes]);
            const result = await f.api({ action: 'import', format: 'docx', payload: parsed });
            assert.equal(result.inserted, 1);
            assert.equal(result.importConflicts, edited ? 1 : 0);
        }
        const conflicts = await f.api({ action: 'conflicts', bank: '同一套题' });
        const detail = await f.api({ action: 'conflictDetail', id: conflicts.conflicts[0].id });
        assert.equal(detail.current.answer, '原答案');
        assert.equal(detail.incoming.answer, '修订答案');
    } finally { await f.close(); }
});

test('large explanation media stays available for review and does not consume the question image budget', { timeout: 45000 }, async () => {
    const f = await fixture();
    try {
        const images = await f.page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 24;
            const ctx = canvas.getContext('2d');
            const solid = color => { ctx.fillStyle = color; ctx.fillRect(0, 0, 24, 24); return canvas.toDataURL(); };
            const blue = solid('blue'), red = solid('red');
            canvas.width = 1120; canvas.height = 1100;
            const noise = ctx.createImageData(canvas.width, canvas.height), pixels = new Uint32Array(noise.data.buffer);
            let state = 17;
            for (let i = 0; i < pixels.length; i++) {
                state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
                pixels[i] = state | 0xff000000;
            }
            ctx.putImageData(noise, 0, 0);
            return { blue, red, large: canvas.toDataURL() };
        });
        assert(images.large.length * 3 > 16 * 1024 * 1024 && images.large.length < 6 * 1024 * 1024);
        const makeQuestion = color => ({
            ...question(color, '选择对应题图[图片:q]'), explanation: '解析[图片:e]',
            images: [{ id: 'q', dataUrl: images[color] }, { id: 'e', dataUrl: images.large }]
        });
        for (const color of ['blue', 'red']) {
            const result = await f.api({ action: 'import', payload: payload(color, [makeQuestion(color)]) });
            assert.equal(result.inserted, 1, result.error);
        }
        const result = await f.page.evaluate(image => __cefDeepSeek.answer({ question: '选择对应题图', options: ['选项乙', '选项甲'], type: 0, images: [image] }), images.blue);
        assert.deepEqual(result.list, [['B']]);
        assert(f.requests.filter(r => r.action === 'images').every(r => r.questionOnly === true));
        const blue = (await f.api({ action: 'search', bank: 'blue' })).questions[0];
        assert.equal((await f.api({ action: 'detail', id: blue.dbId, images: true })).question.images.length, 2);
        const incoming = { ...makeQuestion('blue'), explanation: '更新解析[图片:e]' };
        assert.equal((await f.api({ action: 'import', payload: payload('blue', [incoming]) })).importConflicts, 1);
        const id = (await f.api({ action: 'conflicts', bank: 'blue' })).conflicts[0].id;
        const detail = await f.api({ action: 'conflictDetail', id });
        const kept = await f.api({ action: 'resolve', id, revision: detail.revision, decision: 'keep' });
        assert.equal(kept.ok, true, kept.error);
        assert.equal(kept.conflicts, 0);
    } finally { await f.close(); }
});
