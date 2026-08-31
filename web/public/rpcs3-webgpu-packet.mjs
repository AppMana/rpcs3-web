export const DRAW_PACKET_MAGIC = 0x52444757;
export const DRAW_PACKET_ABI = 1;
export const DRAW_PACKET_HEADER_SIZE = 192;
export const TEXTURE_PACKET_RECORD_SIZE = 48;

export const PacketKind = Object.freeze({ draw: 1, clear: 2, flip: 3 });
export const SectionKind = Object.freeze({
  registers: 0,
  vertexProgram: 1,
  fragmentProgram: 2,
  vertexConstants: 3,
  vertexLayout: 4,
  vertexEnvironment: 5,
  fragmentEnvironment: 6,
  persistentVertices: 7,
  volatileVertices: 8,
  indices: 9,
  textures: 10,
});

function u32(view, offset) {
  return view.getUint32(offset, true);
}

export function fnv1a32(bytes) {
  let hash = 2166136261;
  for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
  return hash >>> 0;
}

export function decodeTextureRecords(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return [];
  if (bytes.byteLength < TEXTURE_PACKET_RECORD_SIZE) throw new Error("truncated WebGPU texture section");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstDataOffset = u32(view, 40);
  if (firstDataOffset < TEXTURE_PACKET_RECORD_SIZE || firstDataOffset % TEXTURE_PACKET_RECORD_SIZE !== 0 || firstDataOffset > bytes.byteLength) {
    throw new Error("invalid WebGPU texture record table");
  }
  const count = firstDataOffset / TEXTURE_PACKET_RECORD_SIZE;
  const textures = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * TEXTURE_PACKET_RECORD_SIZE;
    const dataOffset = u32(view, offset + 40);
    const dataSize = u32(view, offset + 44);
    const stage = u32(view, offset);
    const slot = u32(view, offset + 4);
    if (stage > 1 || slot >= (stage === 0 ? 16 : 4) || dataOffset < firstDataOffset || dataOffset + dataSize > bytes.byteLength) {
      throw new Error(`invalid WebGPU texture record ${index}`);
    }
    textures.push({
      stage,
      slot,
      address: u32(view, offset + 8),
      format: u32(view, offset + 12),
      width: u32(view, offset + 16),
      height: u32(view, offset + 20),
      depth: u32(view, offset + 24),
      pitch: u32(view, offset + 28),
      mipCount: u32(view, offset + 32),
      dimension: u32(view, offset + 36),
      dataOffset,
      dataSize,
      bytes: bytes.subarray(dataOffset, dataOffset + dataSize),
    });
  }
  return textures;
}

export function decodeDrawPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < DRAW_PACKET_HEADER_SIZE) {
    throw new Error(`truncated WebGPU packet (${bytes?.byteLength ?? 0} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteSize = u32(view, 8);
  if (u32(view, 0) !== DRAW_PACKET_MAGIC || u32(view, 4) !== DRAW_PACKET_ABI || byteSize !== bytes.byteLength) {
    throw new Error("invalid WebGPU packet header");
  }
  const sections = [];
  for (let index = 0; index < 11; index += 1) {
    const offset = u32(view, 104 + index * 8);
    const size = u32(view, 108 + index * 8);
    if ((size === 0 && offset !== 0) || (size !== 0 && (offset < DRAW_PACKET_HEADER_SIZE || offset + size > byteSize))) {
      throw new Error(`invalid WebGPU packet section ${index}`);
    }
    sections.push({ offset, size, bytes: size === 0 ? new Uint8Array() : bytes.subarray(offset, offset + size) });
  }
  const packet = {
    bytes,
    view,
    magic: u32(view, 0),
    abi: u32(view, 4),
    byteSize,
    kind: u32(view, 12),
    sequence: view.getBigUint64(16, true),
    primitive: u32(view, 24),
    drawCommand: u32(view, 28),
    indexType: u32(view, 32),
    flags: u32(view, 36),
    firstVertex: u32(view, 40),
    vertexCount: u32(view, 44),
    indexCount: u32(view, 48),
    instanceCount: u32(view, 52),
    width: u32(view, 56),
    height: u32(view, 60),
    colorFormat: u32(view, 64),
    depthFormat: u32(view, 68),
    colorTarget: u32(view, 72),
    antialiasMode: u32(view, 76),
    vertexProgramControl: u32(view, 80),
    vertexProgramOutputMask: u32(view, 84),
    vertexProgramEntry: u32(view, 88),
    fragmentProgramControl: u32(view, 92),
    drawCount: u32(view, 96),
    subdraw: u32(view, 100),
    sections,
  };
  packet.textures = decodeTextureRecords(sections[SectionKind.textures].bytes);
  return packet;
}

export function copyFrontPacket(module) {
  const size = module.ccall("rpcs3_webgpu_front_size", "number", [], []) >>> 0;
  if (!size) return undefined;
  const pointer = module._malloc(size);
  if (!pointer) throw new Error(`could not allocate ${size} bytes for a WebGPU packet`);
  try {
    const copied = module.ccall("rpcs3_webgpu_copy_front", "number", ["number", "number"], [pointer, size]) >>> 0;
    if (copied !== size) throw new Error(`WebGPU packet changed while copying (${size} -> ${copied})`);
    const bytes = module.HEAPU8.slice(pointer, pointer + size);
    if (module.ccall("rpcs3_webgpu_pop_front", "number", [], []) !== 1) {
      throw new Error("WebGPU packet disappeared before pop");
    }
    return decodeDrawPacket(bytes);
  } finally {
    module._free(pointer);
  }
}

export function packetSummary(packet) {
  const summary = {
    kind: packet.kind,
    sequence: Number(packet.sequence),
    byteSize: packet.byteSize,
    primitive: packet.primitive,
    flags: packet.flags,
    firstVertex: packet.firstVertex,
    vertexCount: packet.vertexCount,
    indexCount: packet.indexCount,
    drawCount: packet.drawCount,
    width: packet.width,
    height: packet.height,
    colorFormat: packet.colorFormat,
    depthFormat: packet.depthFormat,
    vertexProgramControl: packet.vertexProgramControl,
    vertexProgramOutputMask: packet.vertexProgramOutputMask,
    fragmentProgramControl: packet.fragmentProgramControl,
    sectionSizes: packet.sections.map((section) => section.size),
  };
  const registers = packet.sections[SectionKind.registers].bytes;
  if (registers.byteLength >= 0x1d90 + 4) {
    const registerView = new DataView(registers.buffer, registers.byteOffset, registers.byteLength);
    summary.clearColor = registerView.getUint32(0x1d90, true);
    summary.shaderControl = registerView.getUint32(0x1d60, true);
    summary.depthFunction = registerView.getUint32(0x0a6c, true);
    summary.depthWriteEnabled = Boolean(registerView.getUint32(0x0a70, true));
    summary.depthTestEnabled = Boolean(registerView.getUint32(0x0a74, true));
  }
  if (packet.kind === PacketKind.draw) {
    const layout = packet.sections[SectionKind.vertexLayout].bytes;
    const attributes = [];
    if (layout.byteLength >= 144) {
      const view = new DataView(layout.buffer, layout.byteOffset, layout.byteLength);
      for (let index = 0; index < 16; index += 1) {
        const low = view.getUint32(16 + index * 8, true);
        const high = view.getUint32(20 + index * 8, true);
        if (low || high) {
          attributes.push({
            index,
            stride: low & 0xff,
            frequency: (low >>> 8) & 0xffff,
            type: (low >>> 24) & 7,
            components: (low >>> 27) & 7,
            offset: high & 0x1fffffff,
            bigEndian: Boolean(high & 0x20000000),
            volatile: Boolean(high & 0x40000000),
            modulo: Boolean(high & 0x80000000),
          });
        }
      }
    }
    const hex = (data, limit) => Array.from(data.subarray(0, limit), (value) => value.toString(16).padStart(2, "0")).join("");
    summary.vertexAttributes = attributes;
    summary.vertexBytes = hex(packet.sections[SectionKind.persistentVertices].bytes, 128);
    summary.volatileVertexBytes = hex(packet.sections[SectionKind.volatileVertices].bytes, 128);
    summary.vertexProgramBytes = hex(packet.sections[SectionKind.vertexProgram].bytes, 128);
    summary.fragmentProgramBytes = hex(packet.sections[SectionKind.fragmentProgram].bytes, 128);
    summary.vertexConstantBytes = hex(packet.sections[SectionKind.vertexConstants].bytes, 128);
    summary.vertexConstant256Bytes = hex(packet.sections[SectionKind.vertexConstants].bytes.subarray(256 * 16), 64);
    summary.vertexEnvironmentBytes = hex(packet.sections[SectionKind.vertexEnvironment].bytes, 96);
    summary.textures = packet.textures.map((texture) => ({
      stage: texture.stage,
      slot: texture.slot,
      address: texture.address,
      format: texture.format,
      width: texture.width,
      height: texture.height,
      depth: texture.depth,
      pitch: texture.pitch,
      mipCount: texture.mipCount,
      dimension: texture.dimension,
      dataSize: texture.dataSize,
      hash: fnv1a32(texture.bytes).toString(16).padStart(8, "0"),
      nonzeroBytes: texture.bytes.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0),
      bytes: hex(texture.bytes, 64),
    }));
  }
  return summary;
}
