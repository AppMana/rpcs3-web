function readLeb(bytes, offset) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, offset];
    shift += 7;
  }
}

// wasm-ld --shared records the memory and table space a module needs in dylink.0.
export function dylinkInfo(module) {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  const info = { memorySize: 0, memoryAlign: 0, tableSize: 0, tableAlign: 0 };
  if (!sections.length) return info;
  const bytes = new Uint8Array(sections[0]);
  let offset = 0;
  while (offset < bytes.length) {
    const type = bytes[offset++];
    let size;
    [size, offset] = readLeb(bytes, offset);
    if (type === 1) {
      let cursor = offset;
      [info.memorySize, cursor] = readLeb(bytes, cursor);
      [info.memoryAlign, cursor] = readLeb(bytes, cursor);
      [info.tableSize, cursor] = readLeb(bytes, cursor);
      [info.tableAlign, cursor] = readLeb(bytes, cursor);
    }
    offset += size;
  }
  return info;
}

