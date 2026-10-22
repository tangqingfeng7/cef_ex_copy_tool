const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readResource } = require('../tools/embedded-resources.cjs');
const { decodeResource } = require('../tools/resource-codec.cjs');
const crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const root = path.resolve(__dirname, '..');
test('DLL contains the exact paired Babel output, including non-ASCII UTF-8', () => {
    const binary = fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll'));
    for (const [name, id] of [['gm_shim.js', 201], ['dat.js', 202]]) {
        const stored = readResource(binary, 10, id);
        assert.equal(stored.toString('ascii', 0, 4), 'CXZ1');
        assert.equal(hash(decodeResource(stored)), hash(fs.readFileSync(path.join(root, 'out/js', name))));
    }
    assert.throws(() => readResource(binary, 10, 65535), /Missing resource/);
    const cpp = fs.readFileSync(path.join(root, 'src/thread.cpp'), 'utf8');
    assert(!cpp.includes('shimCache.load('));
    assert(!cpp.includes('datCache.load('));
});

test('compressed resource header, size and SHA256 damage fail closed', () => {
    const binary = fs.readFileSync(path.join(root, 'out/build/x86-integrated/src/Release/winmm.dll'));
    const packet = Buffer.from(readResource(binary, 10, 202));
    packet[8] ^= 1;
    assert.throws(() => decodeResource(packet));
    packet.writeUInt32LE(0xffffffff, 4);
    assert.throws(() => decodeResource(packet));
});
