// Read PE resources without loading/executing the DLL (also works on non-Windows).
function readResource(binary, type, id) {
    const u16 = o => binary.readUInt16LE(o), u32 = o => binary.readUInt32LE(o);
    if (binary.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a PE file');
    const pe = u32(0x3c);
    if (u32(pe) !== 0x4550) throw new Error('Invalid PE signature');
    const optional = pe + 24;
    const directory = optional + (u16(optional) === 0x20b ? 112 : 96);
    const sectionTable = optional + u16(pe + 20);
    function offset(rva) {
        for (let i = 0; i < u16(pe + 6); i++) {
            const s = sectionTable + i * 40, va = u32(s + 12);
            if (rva >= va && rva - va < Math.max(u32(s + 8), u32(s + 16))) {
                const delta = rva - va, size = u32(s + 16);
                if (delta >= size) throw new Error('Resource RVA outside raw section');
                return u32(s + 20) + delta;
            }
        }
        throw new Error('Unmapped resource RVA');
    }
    const rva = u32(directory + 16);
    if (!rva) throw new Error('Missing resource directory');
    const base = offset(rva);
    function entry(relative, wanted) {
        const dir = base + relative, count = u16(dir + 12) + u16(dir + 14);
        for (let i = 0; i < count; i++) {
            const e = dir + 16 + i * 8;
            if (wanted === null || u32(e) === wanted) return u32(e + 4);
        }
        throw new Error('Missing resource ' + wanted);
    }
    const typ = entry(0, type), item = entry(typ & 0x7fffffff, id);
    if (!(typ & 0x80000000) || !(item & 0x80000000)) throw new Error('Invalid resource directory');
    const language = entry(item & 0x7fffffff, null);
    if (language & 0x80000000) throw new Error('Invalid resource data');
    const data = base + language, start = offset(u32(data)), size = u32(data + 4);
    if (start + size > binary.length) throw new Error('Truncated resource');
    return binary.subarray(start, start + size);
}
module.exports = { readResource };
