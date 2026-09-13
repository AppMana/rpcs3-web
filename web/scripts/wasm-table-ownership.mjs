// Conservative check for LLVM/wasm-ld active element segments. A span is safe for
// same-instance tail calls only when every table entry references a defined function.
// Unrecognized encodings disable the optimization; they do not invalidate the module.
export function tableEntriesAreLocal(bytes, importedFunctions) {
  let cursor = 8;
  const leb = () => {
    let value = 0, shift = 0;
    for (let count = 0; count < 5 && cursor < bytes.length; count++) {
      const byte = bytes[cursor++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error("invalid LEB");
  };
  try {
    while (cursor < bytes.length) {
      const kind = bytes[cursor++], size = leb(), end = cursor + size;
      if (end > bytes.length) return false;
      if (kind !== 9) { cursor = end; continue; }
      const segments = leb();
      for (let segment = 0; segment < segments; segment++) {
        const flags = leb();
        if (flags !== 0 && flags !== 2) return false;
        if (flags === 2 && leb() !== 0) return false;
        const opcode = bytes[cursor++];
        if (opcode !== 0x41 && opcode !== 0x23) return false; // i32.const / global.get
        leb();
        if (bytes[cursor++] !== 0x0b) return false;
        if (flags === 2 && bytes[cursor++] !== 0) return false;
        const count = leb();
        for (let entry = 0; entry < count; entry++) if (leb() < importedFunctions) return false;
      }
      if (cursor !== end) return false;
    }
    return true;
  } catch { return false; }
}
