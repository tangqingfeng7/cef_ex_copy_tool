const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const boot = fs.readFileSync(path.join(root, 'scripts/userscript_boot.js'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'out/js/gm_shim.js'), 'utf8');
const flush = () => new Promise(setImmediate);
function environment(fetch) {
    const timers = new Map(); let next = 0;
    const pageJQ = () => 'page';
    const w = { console: { log() {}, warn() {}, error() {} }, Promise, AbortController, fetch,
        $: pageJQ, jQuery: pageJQ, localStorage: {},
        setTimeout(fn, ms) { timers.set(++next, { fn, ms }); return next; },
        clearTimeout(id) { timers.delete(id); } };
    w.window = w;
    vm.createContext(w);
    vm.runInContext(shim, w); vm.runInContext(boot, w);
    function fire(ms) {
        const item = [...timers].find(([, t]) => t.ms === ms);
        assert(item, 'expected timer ' + ms);
        timers.delete(item[0]); item[1].fn();
    }
    return { w, timers, fire, pageJQ };
}
test('failed resources retry, duplicated load shares boot, metadata stays current', async () => {
    let requests = 0, runs = 0;
    const { w, fire, pageJQ } = environment(async () => {
        ++requests;
        return { ok: true, text: async () => requests === 1 ? 'broken json' : '{}' };
    });
    const run = () => ++runs;
    const first = w.__cefRunUserScript(run);
    assert.equal(first, w.__cefRunUserScript(run));
    await first;
    assert.equal(w.__cefUserScriptState.status, 'failed');
    assert.equal(runs, 0);
    fire(1000); await flush();
    assert.equal(w.__cefUserScriptState.status, 'ready');
    assert.equal(runs, 1); assert.equal(requests, 2);
    assert.equal(w.$, pageJQ); assert.equal(w.jQuery, pageJQ);
    assert.equal(w.GM_info.script.version, '5.4.2');
    await w.__cefRunUserScript(run); assert.equal(runs, 1);
});
test('network failure caps automatic retries at three', async () => {
    const { w, fire, timers } = environment(async () => { throw new Error('offline'); });
    await w.__cefRunUserScript(() => assert.fail('entry cannot run'));
    fire(1000); await flush(); fire(2000); await flush();
    assert.equal(w.__cefUserScriptState.attempts, 3);
    assert.equal(w.__cefUserScriptState.status, 'failed');
    assert.equal(timers.size, 0);
});
test('a hanging resource times out, and a failed script entry is not auto-reexecuted', async () => {
    const stalled = environment(() => new Promise(() => {}));
    const task = stalled.w.__cefRunUserScript(() => {});
    await flush(); stalled.fire(10000); await task;
    assert.equal(stalled.w.__cefUserScriptState.status, 'failed');
    const { w, timers } = environment(async () => ({ ok: true, text: async () => '{}' }));
    await w.__cefRunUserScript(() => { throw new Error('partial entry'); });
    assert.equal(w.__cefUserScriptState.status, 'failed');
    assert.equal(w.__cefUserScriptState.phase, 'run');
    assert.equal(timers.size, 0);
    await w.__cefRunUserScript(() => {});
    assert.equal(w.__cefUserScriptState.status, 'ready');
});

test('generated script guard rejects mixed files and diagnostics report the failure', async () => {
    const guard = fs.readFileSync(path.join(root, 'out/js/dat.js'), 'utf8').split('\n')[0];
    const { w } = environment(async () => ({ ok: true, text: async () => '{}' }));
    vm.runInContext(fs.readFileSync(path.join(root, 'scripts/diagnostics.js'), 'utf8'), w);
    w.__cefUserScriptMetadata.build.id = 'wrong-pair';
    let entryRan = false;
    await w.__cefRunUserScript(() => { vm.runInContext(guard, w); entryRan = true; });
    assert.equal(entryRan, false);
    assert.equal(w.__cefGetDiagnostics().userscript.reason, 'script-pair-mismatch');
    assert.equal(w.__cefGetDiagnostics().userscript.status, 'failed');
    w.__cefUserScriptMetadata.build.id = w.__cefDatBuild.id;
    await w.__cefRunUserScript(() => { vm.runInContext(guard, w); entryRan = true; });
    assert.equal(entryRan, true);
    assert.equal(w.__cefGetDiagnostics().userscript.status, 'ready');
    assert.equal(w.__cefGetDiagnostics().userscript.reason, null);
});
