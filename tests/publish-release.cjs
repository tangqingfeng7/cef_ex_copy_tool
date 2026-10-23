const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const scenario of ['existing', 'new', 'stale', 'hash', 'download', 'extra']) {
    test('offline release publisher guards: ' + scenario, { timeout: 20000 }, () => {
        const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(__dirname, 'publish-release-fixture.ps1'), '-ScriptPath', path.resolve(__dirname, '../tools/publish-release.ps1'), '-Scenario', scenario], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, new RegExp('PASS scenario=' + scenario));
    });
}
