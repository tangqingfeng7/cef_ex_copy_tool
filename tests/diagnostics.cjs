const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/diagnostics.js'), 'utf8');

test('diagnostics show current states, tolerate missing CEF and return isolated snapshots', () => {
    const page = { document: {}, console: { log() {} } };
    page.window = page; vm.createContext(page); vm.runInContext(source, page);
    assert.equal(page.__cefGetDiagnostics().runtime.cef, 'unknown');
    assert.equal(page.__cefGetDiagnostics().native.lifecycle.status, 'unknown');
    assert.equal(page.__cefGetDiagnostics().userscript.status, 'idle');
    page.__cefBuildInfo = { version: '1.0.0', commit: 'test', dirty: true };
    page.__cefRuntimeInfo = { cef: '75.1.4', chromium: '75.0.3770.100' };
    page.__cefNativeInfo = {
        host: { process: 'CXExam.exe', pid: 42, architecture: 'x86' },
        lifecycle: { status: 'running', stopRequested: false, lastError: 0 },
        hooks: { status: 'installed', phase: 'commit', lastError: 0 },
        crashDump: { status: 'installed', directory: 'local', lastError: 0 }
    };
    page.__cefPasteFixDocument = page.document;
    page.__cefUserScriptMetadata = { script: { version: '5.4.2' }, build: { id: 'one' } };
    for (const status of ['loading', 'ready', 'failed', 'skipped', 'disabled']) {
        page.__cefUserScriptState = { status, phase: 'boot', attempts: 2, reason: 'test', error: 'private URL' };
        const snapshot = page.__cefGetDiagnostics();
        assert.equal(snapshot.dll.version, '1.0.0');
        assert.equal(snapshot.runtime.cef, '75.1.4');
        assert.equal(snapshot.native.hooks.status, 'installed');
        assert.equal(snapshot.native.crashDump.status, 'installed');
        assert.equal(snapshot.clipboard, 'installed');
        assert.equal(snapshot.userscript.status, status);
        assert.equal(snapshot.userscript.version, '5.4.2');
        assert.equal(JSON.stringify(snapshot).includes('private URL'), false);
        snapshot.dll.version = 'modified';
        snapshot.native.lifecycle.status = 'modified';
        assert.equal(page.__cefBuildInfo.version, '1.0.0');
        assert.equal(page.__cefNativeInfo.lifecycle.status, 'running');
    }
    vm.runInContext(source, page);
    assert.equal(page.__cefGetDiagnostics().userscript.status, 'disabled');
});
