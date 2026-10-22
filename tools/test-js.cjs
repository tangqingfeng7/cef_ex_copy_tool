// One ordered JS entrypoint: no packaging/build fixture writes during browser tests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
run(['--test', ...fs.readdirSync(path.join(root, 'tests')).filter(n => n.endsWith('.cjs')).sort().map(n => path.join(root, 'tests', n))]);
run([path.join(root, 'tools/test-clipboard.cjs'), path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll')]);
run(['--test', path.join(root, 'tests/build-incremental.test.js')]);
run(['--test', path.join(root, 'tests/release.test.js')]);
