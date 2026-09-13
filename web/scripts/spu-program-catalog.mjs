import { createHash } from 'node:crypto';

// RPCS3's fmt::base57, including its padded final eight-byte group.
export function spuCodeHash(bytes) {
  const digest = createHash('sha1').update(bytes).digest();
  const alphabet = '0123456789ACEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const tails = [0, 2, 3, 5, 6, 7, 9, 10];
  let result = '';
  for (let offset = 0; offset < digest.length; offset += 8) {
    const group = Buffer.alloc(8);
    const length = Math.min(8, digest.length - offset);
    digest.copy(group, 0, offset, offset + length);
    let value = group.readBigUInt64BE();
    const digits = new Array(11);
    for (let i = 10; i >= 0; --i) { digits[i] = alphabet[Number(value % 57n)]; value /= 57n; }
    result += digits.slice(0, length === 8 ? 11 : tails[length]).join('');
  }
  return result;
}

export function spuProgramCatalog(bytes) {
  const programs = new Map();
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('truncated SPU cache header');
    const instructions = bytes.readUInt16BE(offset + 2);
    const pc = bytes.readUInt32BE(offset + 4);
    const end = offset + 8 + instructions * 4;
    if (!instructions || (pc & 3) || pc + instructions * 4 > 262144 || end > bytes.length) throw new Error('invalid or truncated SPU cache program');
    const codeHash = spuCodeHash(bytes.subarray(offset + 8, end));
    const symbol = `__spu-0x${pc.toString(16).padStart(5, '0')}-${codeHash}`;
    programs.set(symbol, { symbol, pc, codeHash, instructions, codeRanges: [[pc, pc + instructions * 4]] });
    offset = end;
  }
  return programs;
}
