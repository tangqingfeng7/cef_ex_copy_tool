const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const entry = fs.readFileSync(path.join(root, 'tools/test-js.cjs'), 'utf8');

for (const [label, env, concurrency] of [['CI', { CI: 'true' }, 1], ['local', {}, 4]]) {
    test('test entry bounds ' + label + ' browser concurrency without reordering packaging', () => {
        const calls = [];
        vm.runInNewContext(entry, {
            __dirname: path.join(root, 'tools'),
            process: { execPath: process.execPath, env, exit(code) { assert.fail('unexpected exit ' + code); } },
            require(name) {
                if (name === 'node:child_process') return {
                    spawnSync(exe, args, options) {
                        calls.push({ exe, args: Array.from(args), options });
                        return { status: 0 };
                    }
                };
                return require(name);
            }
        });
        assert.equal(calls.length, 4);
        assert.deepEqual(calls[0].args, ['--test', '--test-concurrency=' + concurrency,
            ...fs.readdirSync(__dirname).filter(n => n.endsWith('.cjs')).sort().map(n => path.join(__dirname, n))]);
        assert.deepEqual(calls.slice(1).map(call => call.args), [
            [path.join(root, 'tools/test-clipboard.cjs'), path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')],
            ['--test', path.join(root, 'tests/build-incremental.test.js')],
            ['--test', path.join(root, 'tests/release.test.js')]
        ]);
        for (const call of calls) {
            assert.equal(call.exe, process.execPath);
            assert.equal(call.options.cwd, root);
            assert.equal(call.options.stdio, 'inherit');
        }
    });
}
