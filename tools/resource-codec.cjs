const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
function decodeResource(packet) {
    // Backward-compatible inspection of pre-compression builds.
    if (packet.toString('ascii', 0, 4) !== 'CXZ1') return packet;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-resource-'));
    try {
        const input = path.join(dir, 'input.bin'), output = path.join(dir, 'output.js');
        fs.writeFileSync(input, packet);
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(__dirname, 'resource-codec.ps1'), '-Mode', 'Decode', '-InputPath', input, '-OutputPath', output],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        return fs.readFileSync(output);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { decodeResource };
