export const DRAW_PACKET_MAGIC = 0x52444757;
export const DRAW_PACKET_ABI = 5;
export const DRAW_PACKET_SECTION_COUNT = 14;
export const DRAW_PACKET_HEADER_SIZE = 104 + DRAW_PACKET_SECTION_COUNT * 8;
export const TEXTURE_PACKET_RECORD_SIZE = 64;
export const RESOLVED_STATE_SIZE = 256;

// RSX_GCM_CLEAR_* bits as RPCS3 defines them.
export const ClearMask = Object.freeze({
  depth: 0x01,
  stencil: 0x02,
  red: 0x10,
  green: 0x20,
  blue: 0x40,
  alpha: 0x80,
  colorRgba: 0xf0,
  depthStencil: 0x03,
});

export const PacketKind = Object.freeze({ draw: 1, clear: 2, flip: 3 });
export const PacketFlag = Object.freeze({
  indexed: 1 << 0,
  primitiveExpanded: 1 << 1,
  usesFragmentTextures: 1 << 2,
  usesVertexTextures: 1 << 3,
  texturePayloadPending: 1 << 4,
  skipped: 1 << 5,
  primitiveRestart: 1 << 6,
  indexRestartSentinel: 1 << 7,
});
export const SectionKind = Object.freeze({
  resolvedState: 0,
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
  rasterEnvironment: 11,
  fragmentConstants: 12,
  rawRegisters: 13,
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
      contentHash: u32(view, offset + 48),
      remap: u32(view, offset + 52),
      addressModes: u32(view, offset + 56),
      filterModes: u32(view, offset + 60),
      texelControls: u32(view, offset + 60) >>> 16,
      bytes: bytes.subarray(dataOffset, dataOffset + dataSize),
    });
  }
  return textures;
}

// Layout of rsx::webgpu::resolved_state_packet (WebGPUCommand.h). Values are
// resolved by RPCS3's common RSX code; enum fields carry CELL_GCM values.
export function decodeResolvedState(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== RESOLVED_STATE_SIZE) {
    throw new Error(`invalid WebGPU resolved-state section (${bytes?.byteLength ?? 0} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f32 = (offset) => view.getFloat32(offset, true);
  let offset = 0;
  const next = () => { const value = u32(view, offset); offset += 4; return value; };
  const nextF32 = () => { const value = f32(offset); offset += 4; return value; };
  const state = {};
  state.clearMask = next();
  state.clearColor = [nextF32(), nextF32(), nextF32(), nextF32()];
  state.clearDepth = nextF32();
  state.clearStencil = next();
  state.surfaceColorFormat = next();
  state.surfaceDepthFormat = next();
  state.drawBufferCount = next();
  state.depthTestEnabled = Boolean(next());
  state.depthWriteEnabled = Boolean(next());
  state.depthFunc = next();
  state.depthClampEnabled = Boolean(next());
  state.depthClipEnabled = Boolean(next());
  state.depthBoundsTestEnabled = Boolean(next());
  state.depthBoundsMin = nextF32();
  state.depthBoundsMax = nextF32();
  state.stencilTestEnabled = Boolean(next());
  state.twoSidedStencilTestEnabled = Boolean(next());
  state.stencilFunc = next();
  state.stencilOpFail = next();
  state.stencilOpZFail = next();
  state.stencilOpZPass = next();
  state.stencilFuncRef = next();
  state.stencilFuncMask = next();
  state.stencilMask = next();
  state.backStencilFunc = next();
  state.backStencilOpFail = next();
  state.backStencilOpZFail = next();
  state.backStencilOpZPass = next();
  state.backStencilFuncRef = next();
  state.backStencilFuncMask = next();
  state.backStencilMask = next();
  state.logicOpEnabled = Boolean(next());
  state.logicOperation = next();
  state.blendEnabledMask = next();
  state.blendSfactorRgb = next();
  state.blendSfactorA = next();
  state.blendDfactorRgb = next();
  state.blendDfactorA = next();
  state.blendEquationRgb = next();
  state.blendEquationA = next();
  state.blendColor = [nextF32(), nextF32(), nextF32(), nextF32()];
  state.colorWriteMask = [next(), next(), next(), next()];
  state.alphaTestEnabled = Boolean(next());
  state.alphaFunc = next();
  state.alphaRef = nextF32();
  state.cullFaceEnabled = Boolean(next());
  state.cullFaceMode = next();
  state.frontFaceMode = next();
  state.lineWidth = nextF32();
  state.polyOffsetFillEnabled = Boolean(next());
  state.polyOffsetScale = nextF32();
  state.polyOffsetBias = nextF32();
  state.shaderControl = next();
  if (offset !== RESOLVED_STATE_SIZE - 8) throw new Error("resolved-state decoder is out of sync with the packet ABI");
  return state;
}

export function decodeDrawPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < DRAW_PACKET_HEADER_SIZE) {
    throw new Error(`truncated WebGPU packet (${bytes?.byteLength ?? 0} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteSize = u32(view, 8);
  if (u32(view, 0) !== DRAW_PACKET_MAGIC || u32(view, 4) !== DRAW_PACKET_ABI || byteSize !== bytes.byteLength) {
    throw new Error(`invalid WebGPU packet header (magic=0x${u32(view, 0).toString(16)}, ABI=${u32(view, 4)}, declared=${byteSize}, actual=${bytes.byteLength})`);
  }
  const sections = [];
  for (let index = 0; index < DRAW_PACKET_SECTION_COUNT; index += 1) {
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
  packet.resolvedState = decodeResolvedState(sections[SectionKind.resolvedState].bytes);
  return packet;
}

// One copy: straight from the queue's own storage into a transferable
// JavaScript buffer. The host guarantees the front packet's address stays
// valid until this (only) consumer pops it.
export function copyFrontPacket(module) {
  const size = module.ccall("rpcs3_webgpu_front_size", "number", [], []) >>> 0;
  if (!size) return undefined;
  const pointer = module.ccall("rpcs3_webgpu_front_data", "number", [], []) >>> 0;
  if (!pointer) throw new Error("WebGPU packet disappeared before copy");
  if (pointer + size > module.HEAPU8.byteLength) {
    // Any ccall refreshes Emscripten's heap views after shared-memory growth.
    module.ccall("rpcs3_web_ppu_last_function", "string", [], []);
    if (pointer + size > module.HEAPU8.byteLength) {
      throw new Error(`Wasm heap view did not grow for a ${size}-byte WebGPU packet`);
    }
  }
  const bytes = new Uint8Array(size);
  bytes.set(module.HEAPU8.subarray(pointer, pointer + size));
  if (module.ccall("rpcs3_webgpu_pop_front", "number", [], []) !== 1) {
    throw new Error("WebGPU packet disappeared before pop");
  }
  return decodeDrawPacket(bytes);
}

export function discardFrontPacket(module) {
  const kind = module.ccall("rpcs3_webgpu_front_kind", "number", [], []) >>> 0;
  if (!kind) return undefined;
  if (module.ccall("rpcs3_webgpu_pop_front", "number", [], []) !== 1) {
    throw new Error("WebGPU packet disappeared before discard");
  }
  return kind;
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
  const state = packet.resolvedState;
  summary.clearMask = state.clearMask;
  summary.clearColor = state.clearColor;
  summary.clearDepth = state.clearDepth;
  summary.shaderControl = state.shaderControl;
  summary.depthFunction = state.depthFunc;
  summary.depthWriteEnabled = state.depthWriteEnabled;
  summary.depthTestEnabled = state.depthTestEnabled;
  summary.blendEnabledMask = state.blendEnabledMask;
  summary.colorWriteMask = state.colorWriteMask;
  const registers = packet.sections[SectionKind.rawRegisters].bytes;
  if (registers.byteLength >= 0x1d90 + 4) {
    const registerView = new DataView(registers.buffer, registers.byteOffset, registers.byteLength);
    summary.rawClearColor = registerView.getUint32(0x1d90, true);
    summary.rawShaderControl = registerView.getUint32(0x1d60, true);
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
    const rasterEnvironment = packet.sections[SectionKind.rasterEnvironment].bytes;
    if (rasterEnvironment.byteLength === 16) {
      const rasterView = new DataView(rasterEnvironment.buffer, rasterEnvironment.byteOffset, rasterEnvironment.byteLength);
      summary.scissor = {
        x: rasterView.getUint32(0, true),
        y: rasterView.getUint32(4, true),
        width: rasterView.getUint32(8, true),
        height: rasterView.getUint32(12, true),
      };
    }
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
      hash: texture.contentHash.toString(16).padStart(8, "0"),
      remap: `0x${texture.remap.toString(16).padStart(4, "0")}`,
      addressModes: `0x${texture.addressModes.toString(16).padStart(6, "0")}`,
      filterModes: `0x${texture.filterModes.toString(16).padStart(4, "0")}`,
      texelControls: `0x${texture.texelControls.toString(16).padStart(4, "0")}`,
      nonzeroBytes: texture.bytes.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0),
      bytes: hex(texture.bytes, 64),
    }));
  }
  return summary;
}
