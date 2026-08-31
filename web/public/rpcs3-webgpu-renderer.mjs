import { PacketFlag, PacketKind, SectionKind } from "./rpcs3-webgpu-packet.mjs";

let activePresentation;

export function stopWebGPUPresentation() {
  if (!activePresentation) return;
  activePresentation.cancelled = true;
  if (activePresentation.animationFrame !== undefined) cancelAnimationFrame(activePresentation.animationFrame);
  activePresentation.resources.forEach(({ buffer, textureResource }) => {
    buffer.destroy();
    textureResource?.texture.destroy();
  });
  activePresentation.depthTexture?.destroy();
  activePresentation = undefined;
}

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
  }
  return btoa(binary);
}

const VertexType = Object.freeze({ snorm16: 1, float32: 2, float16: 3, unorm8: 4, sint16: 5, cmp32: 6, uint8: 7 });

function bits(value, offset, count) {
  return (value >>> offset) & (count === 32 ? 0xffffffff : (2 ** count) - 1);
}

function vector(value = 0, w = value) {
  return [value, value, value, w];
}

function swizzle(value, code) {
  return [value[bits(code, 6, 2)], value[bits(code, 4, 2)], value[bits(code, 2, 2)], value[bits(code, 0, 2)]];
}

function readVertexDescriptors(packet) {
  const bytes = packet.sections[SectionKind.vertexLayout].bytes;
  if (bytes.byteLength < 144) throw new Error("RPCS3 vertex-layout packet is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const descriptors = new Map();
  for (let index = 0; index < 16; index += 1) {
    const low = view.getUint32(16 + index * 8, true);
    const high = view.getUint32(20 + index * 8, true);
    if (!low && !high) continue;
    descriptors.set(index, {
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
  return descriptors;
}

function readAttribute(packet, descriptor, vertex) {
  const bytes = packet.sections[descriptor.volatile ? SectionKind.volatileVertices : SectionKind.persistentVertices].bytes;
  const index = descriptor.frequency === 0 ? 0 : descriptor.modulo
    ? vertex % descriptor.frequency
    : Math.floor(vertex / descriptor.frequency);
  let offset = descriptor.offset + index * descriptor.stride;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = vector(0, 1);
  for (let component = 0; component < descriptor.components; component += 1) {
    if (descriptor.type === VertexType.float32) {
      result[component] = view.getFloat32(offset, !descriptor.bigEndian);
      offset += 4;
    } else if (descriptor.type === VertexType.unorm8 || descriptor.type === VertexType.uint8) {
      result[component] = view.getUint8(offset) / (descriptor.type === VertexType.unorm8 ? 255 : 1);
      offset += 1;
    } else if (descriptor.type === VertexType.snorm16 || descriptor.type === VertexType.sint16) {
      const raw = view.getInt16(offset, !descriptor.bigEndian);
      result[component] = descriptor.type === VertexType.snorm16 ? Math.max(-1, raw / 32767) : raw;
      offset += 2;
    } else {
      throw new Error(`WebGPU vertex fetch does not yet support RSX type ${descriptor.type}`);
    }
  }
  return result;
}

function readConstant(packet, index) {
  const bytes = packet.sections[SectionKind.vertexConstants].bytes;
  const offset = index * 16;
  if (offset + 16 > bytes.byteLength) throw new Error(`RSX vertex constant ${index} is outside the packet`);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
  return [0, 4, 8, 12].map((component) => view.getFloat32(component, true));
}

function decodeVertexSource(words, sourceIndex, d0, d1, d3, inputs, temps, packet) {
  let source;
  let absolute;
  if (sourceIndex === 0) {
    source = (bits(words[1], 0, 8) << 9) | bits(words[2], 23, 9);
    absolute = Boolean(bits(words[0], 21, 1));
  } else if (sourceIndex === 1) {
    source = bits(words[2], 6, 17);
    absolute = Boolean(bits(words[0], 22, 1));
  } else {
    source = (bits(words[2], 0, 6) << 11) | bits(words[3], 21, 11);
    absolute = Boolean(bits(words[0], 23, 1));
  }
  const type = bits(source, 0, 2);
  let value;
  if (type === 1) value = temps[bits(source, 2, 6)];
  else if (type === 2) value = inputs.get(d1.inputSource) ?? vector(0, 1);
  else if (type === 3) {
    if (d3.indexConstant) throw new Error("indexed RSX vertex constants are not yet translated");
    value = readConstant(packet, d1.constantSource);
  } else throw new Error("undefined RSX vertex source register");
  value = [...value];
  const swizzleCode = bits(source, 8, 8);
  if (swizzleCode !== 0x1b) value = swizzle(value, swizzleCode);
  if (absolute) value = value.map(Math.abs);
  if (bits(source, 16, 1)) value = value.map((component) => -component);
  return value;
}

// This follows RPCS3's existing GLSLInterpreter/VertexInterpreter.glsl decode
// and execution rules. The first closure intentionally supports the numeric
// vector instructions needed by the upstream basic-triangle test; unsupported
// shader behavior fails closed instead of manufacturing a frame.
function executeVertexProgram(packet, inputs) {
  const program = packet.sections[SectionKind.vertexProgram].bytes;
  if (program.byteLength % 16 !== 0) throw new Error("unaligned RSX vertex program");
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const temps = Array.from({ length: 32 }, () => vector());
  const destinations = Array.from({ length: 16 }, () => vector(0, 1));
  const opcodes = [];
  for (let instruction = packet.vertexProgramEntry; instruction * 16 < program.byteLength; instruction += 1) {
    const base = instruction * 16;
    const words = [0, 4, 8, 12].map((offset) => view.getUint32(base + offset, true));
    const d0 = {
      destinationTemp: bits(words[0], 15, 6),
      saturate: Boolean(bits(words[0], 26, 1)),
      vectorResult: Boolean(bits(words[0], 30, 1)),
    };
    const d1 = {
      inputSource: bits(words[1], 8, 4),
      constantSource: bits(words[1], 12, 10),
      vectorOpcode: bits(words[1], 22, 5),
      scalarOpcode: bits(words[1], 27, 5),
    };
    const d3 = {
      end: Boolean(bits(words[3], 0, 1)),
      indexConstant: Boolean(bits(words[3], 1, 1)),
      destination: bits(words[3], 2, 5),
      mask: [16, 15, 14, 13].map((bit) => Boolean(bits(words[3], bit, 1))),
    };
    if (d1.scalarOpcode !== 0) throw new Error(`RSX scalar vertex opcode ${d1.scalarOpcode} is not yet translated`);
    if (d1.vectorOpcode !== 0) {
      const a = decodeVertexSource(words, 0, d0, d1, d3, inputs, temps, packet);
      let value;
      if (d1.vectorOpcode === 1) value = a;
      else if (d1.vectorOpcode === 2) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        value = a.map((component, index) => component * b[index]);
      } else if (d1.vectorOpcode === 3) {
        const b = decodeVertexSource(words, 2, d0, d1, d3, inputs, temps, packet);
        value = a.map((component, index) => component + b[index]);
      } else if (d1.vectorOpcode === 4) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        const c = decodeVertexSource(words, 2, d0, d1, d3, inputs, temps, packet);
        value = a.map((component, index) => component * b[index] + c[index]);
      } else if (d1.vectorOpcode === 5) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        const dot = a.slice(0, 3).reduce((sum, component, index) => sum + component * b[index], 0);
        value = vector(dot);
      } else if (d1.vectorOpcode === 6) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        const dot = a.slice(0, 3).reduce((sum, component, index) => sum + component * b[index], b[3]);
        value = vector(dot);
      } else if (d1.vectorOpcode === 7) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        const dot = a.reduce((sum, component, index) => sum + component * b[index], 0);
        value = vector(dot);
      } else if (d1.vectorOpcode === 8) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        value = [1, a[1] * b[1], a[2], b[3]];
      } else if (d1.vectorOpcode === 9 || d1.vectorOpcode === 10) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        value = a.map((component, index) => d1.vectorOpcode === 9 ? Math.min(component, b[index]) : Math.max(component, b[index]));
      } else if ([11, 12, 16, 18, 19, 20].includes(d1.vectorOpcode)) {
        const b = decodeVertexSource(words, 1, d0, d1, d3, inputs, temps, packet);
        value = a.map((component, index) => Number(
          d1.vectorOpcode === 11 ? component < b[index]
            : d1.vectorOpcode === 12 ? component >= b[index]
              : d1.vectorOpcode === 16 ? component === b[index]
                : d1.vectorOpcode === 18 ? component > b[index]
                  : d1.vectorOpcode === 19 ? component <= b[index]
                    : component !== b[index],
        ));
      } else if (d1.vectorOpcode === 14) {
        value = a.map((component) => component - Math.floor(component));
      } else if (d1.vectorOpcode === 15) {
        value = a.map(Math.floor);
      } else if (d1.vectorOpcode === 17 || d1.vectorOpcode === 21) {
        value = vector(d1.vectorOpcode === 17 ? 0 : 1);
      } else if (d1.vectorOpcode === 22) {
        value = a.map(Math.sign);
      } else {
        throw new Error(`RSX vector vertex opcode ${d1.vectorOpcode} is not yet translated`);
      }
      if (d0.saturate) value = value.map((component) => Math.max(0, Math.min(1, component)));
      const write = (target) => d3.mask.forEach((enabled, component) => { if (enabled) target[component] = value[component]; });
      if (d0.destinationTemp !== 0x3f) write(temps[d0.destinationTemp]);
      if (d0.vectorResult && d3.destination < destinations.length) write(destinations[d3.destination]);
      opcodes.push(d1.vectorOpcode);
    }
    if (d3.end) break;
  }
  return { destinations, opcodes };
}

function applyVertexEnvironment(packet, position) {
  const bytes = packet.sections[SectionKind.vertexEnvironment].bytes;
  if (bytes.byteLength < 64) throw new Error("RPCS3 vertex environment is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const columns = Array.from({ length: 4 }, (_, column) =>
    Array.from({ length: 4 }, (_, row) => view.getFloat32(column * 16 + row * 4, true)));
  return columns.map((column) => position.reduce((sum, component, index) => sum + component * column[index], 0));
}

function fragmentWord(view, offset) {
  const raw = view.getUint32(offset, true);
  return (((raw & 0x00ff00ff) << 8) | ((raw & 0xff00ff00) >>> 8)) >>> 0;
}

function floatLiteral(word) {
  const bitsView = new DataView(new ArrayBuffer(4));
  bitsView.setUint32(0, word, true);
  const value = bitsView.getFloat32(0, true);
  if (!Number.isFinite(value)) throw new Error("non-finite RSX inline constants are not yet translated");
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

function fragmentSource(words, sourceIndex, inlineConstant) {
  const word = words[sourceIndex + 1];
  const type = bits(word, 0, 2);
  let source;
  if (type === 0) {
    const registerFile = bits(word, 8, 1) ? "r16" : "r32";
    source = `${registerFile}[${bits(word, 2, 6)}]`;
  } else if (type === 1) {
    const attribute = bits(words[0], 13, 4);
    if (attribute === 1) source = "input.color";
    else if (attribute >= 4 && attribute <= 11) source = `input.texcoord${attribute - 4}`;
    else throw new Error(`RSX fragment input attribute ${attribute} is not yet translated`);
  } else if (type === 2) {
    if (!inlineConstant) throw new Error("missing RSX fragment inline constant");
    source = inlineConstant;
  } else {
    throw new Error("undefined RSX fragment source register");
  }
  const swizzleCode = bits(word, 9, 8);
  if (swizzleCode !== 0xe4) {
    const channels = [0, 2, 4, 6].map((shift) => "xyzw"[bits(swizzleCode, shift, 2)]).join("");
    source = `${source}.${channels}`;
  }
  const absolute = sourceIndex === 0 ? bits(words[1], 29, 1) : bits(word, 18, 1);
  if (absolute) source = `abs(${source})`;
  if (bits(word, 17, 1)) source = `-(${source})`;
  return source;
}

// Compile the RSX fragment instruction stream into WGSL using the same bit
// fields and execution rules as RPCS3's existing GLSL fragment interpreter.
// The closure is intentionally strict: unsupported instructions fail instead
// of silently manufacturing a plausible frame.
function compileFragmentProgram(packet) {
  const bytes = packet.sections[SectionKind.fragmentProgram].bytes;
  if (bytes.byteLength < 16 || bytes.byteLength % 16 !== 0) throw new Error("invalid RSX fragment program");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines = ["var r16: array<vec4f, 48>;", "var r32: array<vec4f, 48>;"];
  const opcodes = [];
  let textured = false;
  for (let offset = 0; offset < bytes.byteLength;) {
    const words = [0, 4, 8, 12].map((wordOffset) => fragmentWord(view, offset + wordOffset));
    const opcode = bits(words[0], 24, 6);
    const end = Boolean(bits(words[0], 0, 1));
    if (opcode === 0 || opcode === 0x3d || opcode === 0x3e) {
      opcodes.push(opcode);
      offset += 16;
      if (end) break;
      continue;
    }

    const operandCounts = new Map([[1, 1], [2, 2], [3, 2], [4, 3], [5, 2], [6, 2], [8, 2], [9, 2], [0x17, 1]]);
    const operandCount = operandCounts.get(opcode);
    if (!operandCount) throw new Error(`RSX fragment opcode ${opcode} is not yet translated`);
    const hasConstant = Array.from({ length: operandCount }, (_, index) => bits(words[index + 1], 0, 2)).includes(2);
    let inlineConstant;
    if (hasConstant) {
      if (offset + 32 > bytes.byteLength) throw new Error("truncated RSX fragment inline constant");
      inlineConstant = `vec4f(${[0, 4, 8, 12].map((wordOffset) => floatLiteral(fragmentWord(view, offset + 16 + wordOffset))).join(", ")})`;
    }
    if (bits(words[1], 18, 3) !== 7) throw new Error("conditional RSX fragment execution is not yet translated");
    const sources = Array.from({ length: operandCount }, (_, index) => fragmentSource(words, index, inlineConstant));
    let value;
    if (opcode === 1) value = sources[0];
    else if (opcode === 2) value = `(${sources[0]} * ${sources[1]})`;
    else if (opcode === 3) value = `(${sources[0]} + ${sources[1]})`;
    else if (opcode === 4) value = `fma(${sources[0]}, ${sources[1]}, ${sources[2]})`;
    else if (opcode === 5) value = `vec4f(dot(${sources[0]}.xyz, ${sources[1]}.xyz))`;
    else if (opcode === 6) value = `vec4f(dot(${sources[0]}, ${sources[1]}))`;
    else if (opcode === 8) value = `min(${sources[0]}, ${sources[1]})`;
    else if (opcode === 9) value = `max(${sources[0]}, ${sources[1]})`;
    else if (opcode === 0x17) {
      const textureSlot = bits(words[0], 17, 4);
      if (textureSlot !== 0) throw new Error(`RSX fragment texture slot ${textureSlot} is not yet translated`);
      value = `textureSample(rsxTexture0, rsxSampler0, ${sources[0]}.xy)`;
      textured = true;
    }
    const scale = [1, 2, 4, 8, 1, 0.5, 0.25, 0.125][bits(words[2], 28, 3)];
    if (scale !== 1) value = `(${value} * ${scale})`;
    if (bits(words[0], 31, 1)) value = `clamp(${value}, vec4f(0.0), vec4f(1.0))`;
    if (!bits(words[0], 30, 1)) {
      const destination = bits(words[0], 1, 6);
      const registerFile = bits(words[0], 7, 1) ? "r16" : "r32";
      for (let component = 0; component < 4; component += 1) {
        if (bits(words[0], 9 + component, 1)) lines.push(`${registerFile}[${destination}].${"xyzw"[component]} = (${value}).${"xyzw"[component]};`);
      }
    }
    opcodes.push(opcode);
    offset += hasConstant ? 32 : 16;
    if (end) break;
  }
  lines.push(`return ${(packet.fragmentProgramControl & 0x40) !== 0 ? "r32" : "r16"}[0];`);
  return { code: lines.join("\n"), textured, opcodes };
}

function drawVertexOrder(packet) {
  if (packet.indexCount === 0) return Array.from({ length: packet.vertexCount }, (_, index) => index);
  const bytes = packet.sections[SectionKind.indices].bytes;
  const elementSize = packet.indexType === 0 ? 4 : 2;
  if (bytes.byteLength < packet.indexCount * elementSize) throw new Error("RPCS3 index packet is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layout = packet.sections[SectionKind.vertexLayout].bytes;
  const vertexIndexBase = new DataView(layout.buffer, layout.byteOffset, layout.byteLength).getUint32(0, true);
  return Array.from({ length: packet.indexCount }, (_, index) => {
    const value = elementSize === 4 ? view.getUint32(index * 4, true) : view.getUint16(index * 2, true);
    if (value < vertexIndexBase || value - vertexIndexBase >= packet.vertexCount) throw new Error("RPCS3 index is outside the uploaded vertex range");
    return value - vertexIndexBase;
  });
}

function primitiveTopology(packet) {
  const expanded = Boolean(packet.flags & PacketFlag.primitiveExpanded);
  switch (packet.primitive) {
  case 1: return "point-list";
  case 2: return "line-list";
  case 3:
    if (!expanded) throw new Error("RSX line loops must include their closing index");
    return "line-strip";
  case 4: return "line-strip";
  case 5: return "triangle-list";
  case 6: return "triangle-strip";
  case 7:
  case 8:
  case 10:
    if (!expanded) throw new Error(`RSX primitive ${packet.primitive} must be expanded to triangles`);
    return "triangle-list";
  case 9:
    // RPCS3's native GL path lowers quad strips to the equivalent triangle
    // strip ordering, which WebGPU supports directly.
    return "triangle-strip";
  default:
    throw new Error(`unsupported RSX primitive ${packet.primitive}`);
  }
}

function translateDraw(packet) {
  if (packet.kind !== PacketKind.draw) throw new Error(`packet ${packet.sequence} is not an RSX draw`);
  // RPCS3's shared BufferUtils has already expanded line loops, fans, quads,
  // and polygons. Select the WebGPU topology for that mature output instead
  // of independently rebuilding guest primitive winding here.
  const topology = primitiveTopology(packet);
  const allowedFlags = PacketFlag.indexed | PacketFlag.primitiveExpanded | PacketFlag.usesFragmentTextures;
  if (packet.flags & ~allowedFlags) throw new Error(`WebGPU draw closure cannot translate packet flags 0x${packet.flags.toString(16)}`);
  const descriptors = readVertexDescriptors(packet);
  const vertexOrder = drawVertexOrder(packet);
  const output = new Float32Array(vertexOrder.length * 12);
  const vertexOpcodeSet = new Set();
  for (let outputVertex = 0; outputVertex < vertexOrder.length; outputVertex += 1) {
    const vertex = vertexOrder[outputVertex];
    const inputs = new Map();
    for (const [index, descriptor] of descriptors) inputs.set(index, readAttribute(packet, descriptor, vertex));
    const executed = executeVertexProgram(packet, inputs);
    executed.opcodes.forEach((opcode) => vertexOpcodeSet.add(opcode));
    const position = applyVertexEnvironment(packet, executed.destinations[0]);
    // RPCS3's Vulkan backend uses a positive-height viewport, whose framebuffer
    // Y mapping is the inverse of WebGPU's clip-space mapping. Preserve the
    // native backend's orientation after applying the shared RSX viewport
    // scale/offset matrix.
    position[1] = -position[1];
    const color = executed.destinations[1];
    const texcoord0 = executed.destinations[7];
    output.set([...position, ...color, ...texcoord0], outputVertex * 12);
  }
  const fragment = compileFragmentProgram(packet);
  if (fragment.textured && packet.textures.length === 0) throw new Error("RSX fragment program samples a texture without a payload");
  return { output, fragment, topology, vertexOpcodes: [...vertexOpcodeSet].sort((a, b) => a - b), fragmentOpcodes: fragment.opcodes };
}

function clearValue(packet) {
  const registers = packet.sections[SectionKind.registers].bytes;
  const word = registers.byteLength >= 0x1d94
    ? new DataView(registers.buffer, registers.byteOffset, registers.byteLength).getUint32(0x1d90, true)
    : 0;
  return {
    r: ((word >>> 16) & 0xff) / 255,
    g: ((word >>> 8) & 0xff) / 255,
    b: (word & 0xff) / 255,
    a: ((word >>> 24) & 0xff) / 255,
    bytes: [(word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff, (word >>> 24) & 0xff],
  };
}

function depthState(packet) {
  const registers = packet.sections[SectionKind.registers].bytes;
  if (registers.byteLength < 0x0a78) throw new Error("RPCS3 register packet is missing depth state");
  const view = new DataView(registers.buffer, registers.byteOffset, registers.byteLength);
  const enabled = Boolean(view.getUint32(0x0a74, true));
  const writeEnabled = Boolean(view.getUint32(0x0a70, true));
  const comparison = new Map([
    [0x200, "never"], [0x201, "less"], [0x202, "equal"], [0x203, "less-equal"],
    [0x204, "greater"], [0x205, "not-equal"], [0x206, "greater-equal"], [0x207, "always"],
  ]).get(view.getUint32(0x0a6c, true));
  if (!comparison) throw new Error(`unsupported RSX depth comparison 0x${view.getUint32(0x0a6c, true).toString(16)}`);
  return { enabled, writeEnabled: enabled && writeEnabled, comparison: enabled ? comparison : "always" };
}

function renderTargetState(packet) {
  const registers = packet.sections[SectionKind.registers].bytes;
  if (registers.byteLength < 0x0328) throw new Error("RPCS3 register packet is missing render-target state");
  const view = new DataView(registers.buffer, registers.byteOffset, registers.byteLength);
  const factor = (value) => {
    const result = new Map([
      [0, "zero"], [1, "one"], [0x300, "src"], [0x301, "one-minus-src"],
      [0x302, "src-alpha"], [0x303, "one-minus-src-alpha"], [0x304, "dst-alpha"],
      [0x305, "one-minus-dst-alpha"], [0x306, "dst"], [0x307, "one-minus-dst"],
      [0x308, "src-alpha-saturated"], [0x8001, "constant"], [0x8002, "one-minus-constant"],
      [0x8003, "constant"], [0x8004, "one-minus-constant"],
    ]).get(value);
    if (!result) throw new Error(`unsupported RSX blend factor 0x${value.toString(16)}`);
    return result;
  };
  const operation = (value) => {
    const result = new Map([
      [0x8006, "add"], [0x8007, "min"], [0x8008, "max"], [0x800a, "subtract"],
      [0x800b, "reverse-subtract"], [0xf005, "reverse-subtract"], [0xf006, "add"],
    ]).get(value);
    if (!result) throw new Error(`unsupported RSX blend equation 0x${value.toString(16)}`);
    return result;
  };
  const blendEnabled = Boolean(view.getUint32(0x0310, true));
  const source = view.getUint32(0x0314, true);
  const destination = view.getUint32(0x0318, true);
  const equation = view.getUint32(0x0320, true);
  const colorMask = view.getUint32(0x0324, true);
  let writeMask = 0;
  if (colorMask & 0x000000ff) writeMask |= GPUColorWrite.BLUE;
  if (colorMask & 0x0000ff00) writeMask |= GPUColorWrite.GREEN;
  if (colorMask & 0x00ff0000) writeMask |= GPUColorWrite.RED;
  if (colorMask & 0xff000000) writeMask |= GPUColorWrite.ALPHA;
  const blend = blendEnabled ? {
    color: { srcFactor: factor(source & 0xffff), dstFactor: factor(destination & 0xffff), operation: operation(equation & 0xffff) },
    alpha: { srcFactor: factor(source >>> 16), dstFactor: factor(destination >>> 16), operation: operation(equation >>> 16) },
  } : undefined;
  const blendColor = view.getUint32(0x031c, true);
  return {
    blend,
    blendEnabled,
    writeMask,
    blendConstant: {
      r: ((blendColor >>> 16) & 0xff) / 255,
      g: ((blendColor >>> 8) & 0xff) / 255,
      b: (blendColor & 0xff) / 255,
      a: ((blendColor >>> 24) & 0xff) / 255,
    },
  };
}

export async function prepareWebGPU(canvas) {
  if (!canvas || typeof canvas.getContext !== "function" || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)) {
    throw new Error("an HTMLCanvasElement or OffscreenCanvas is required for WebGPU presentation");
  }
  if (!("gpu" in navigator)) throw new Error("WebGPU is unavailable in this execution context");
  let adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  // Some Dawn/Vulkan combinations expose the discrete device while ignoring
  // the preference hint in dedicated workers. Match RPCS3 Web's capability
  // probe and retry without a hint before declaring WebGPU unavailable.
  if (!adapter) adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU requestAdapter returned null");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("OffscreenCanvas WebGPU context is unavailable");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  return { canvas, adapter, device, context, format };
}

function uploadTexture2D(device, descriptor) {
  const baseFormat = descriptor.format & ~(0x20 | 0x40);
  const bytesPerTexel = baseFormat === 0x85 ? 4 : baseFormat === 0x81 ? 1 : 0;
  if (!bytesPerTexel || !(descriptor.format & 0x20) || descriptor.depth !== 1 || descriptor.mipCount !== 1) {
    throw new Error(`current WebGPU texture closure requires linear B8 or A8R8G8B8 2D level zero (format=0x${descriptor.format.toString(16)})`);
  }
  const sourcePitch = descriptor.pitch || descriptor.width * bytesPerTexel;
  if (sourcePitch < descriptor.width * bytesPerTexel || descriptor.bytes.byteLength < sourcePitch * descriptor.height) {
    throw new Error("RPCS3 texture payload is truncated");
  }
  const bytesPerRow = Math.ceil((descriptor.width * 4) / 256) * 256;
  const rgba = new Uint8Array(bytesPerRow * descriptor.height);
  const channelMin = [255, 255, 255, 255];
  const channelMax = [0, 0, 0, 0];
  const channelSum = [0, 0, 0, 0];
  for (let y = 0; y < descriptor.height; y += 1) {
    for (let x = 0; x < descriptor.width; x += 1) {
      const source = y * sourcePitch + x * 4;
      const destination = y * bytesPerRow + x * 4;
      if (baseFormat === 0x85) {
        // Guest A8R8G8B8 words remain big-endian in the packet: A,R,G,B.
        // RPCS3's native upload converts the word before exposing BGRA host
        // bytes; upload RGBA directly here for the same sampled channels.
        rgba[destination] = descriptor.bytes[source + 1];
        rgba[destination + 1] = descriptor.bytes[source + 2];
        rgba[destination + 2] = descriptor.bytes[source + 3];
        rgba[destination + 3] = descriptor.bytes[source];
      } else {
        // Match VKFormats::get_component_mapping(B8): the native view exposes
        // the sole channel as G/B/A and forces R=1. Font shaders use the
        // sampled alpha as glyph coverage.
        const value = descriptor.bytes[y * sourcePitch + x];
        rgba[destination] = 255;
        rgba[destination + 1] = value;
        rgba[destination + 2] = value;
        rgba[destination + 3] = value;
      }
      for (let channel = 0; channel < 4; channel += 1) {
        channelMin[channel] = Math.min(channelMin[channel], rgba[destination + channel]);
        channelMax[channel] = Math.max(channelMax[channel], rgba[destination + channel]);
        channelSum[channel] += rgba[destination + channel];
      }
    }
  }
  const texture = device.createTexture({
    label: `RPCS3 RSX texture ${descriptor.stage}:${descriptor.slot}`,
    size: { width: descriptor.width, height: descriptor.height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow, rowsPerImage: descriptor.height },
    { width: descriptor.width, height: descriptor.height },
  );
  const sampler = device.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear" });
  return {
    texture,
    sampler,
    diagnostics: {
      width: descriptor.width,
      height: descriptor.height,
      channelMin,
      channelMax,
      channelMean: channelSum.map((sum) => sum / (descriptor.width * descriptor.height)),
    },
  };
}

function drawDiagnostics(draw) {
  const result = {
    clipBounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    texcoord0Bounds: { min: [Infinity, Infinity], max: [-Infinity, -Infinity] },
  };
  for (let offset = 0; offset < draw.output.length; offset += 12) {
    const w = draw.output[offset + 3];
    for (let component = 0; component < 3; component += 1) {
      const value = draw.output[offset + component] / w;
      result.clipBounds.min[component] = Math.min(result.clipBounds.min[component], value);
      result.clipBounds.max[component] = Math.max(result.clipBounds.max[component], value);
    }
    for (let component = 0; component < 2; component += 1) {
      const value = draw.output[offset + 8 + component];
      result.texcoord0Bounds.min[component] = Math.min(result.texcoord0Bounds.min[component], value);
      result.texcoord0Bounds.max[component] = Math.max(result.texcoord0Bounds.max[component], value);
    }
  }
  return result;
}

export async function renderPacketsToWebGPU(prepared, packets, options = {}) {
  const renderStartedAt = performance.now();
  stopWebGPUPresentation();
  const { canvas, adapter, device, context, format } = prepared;
  const clearPacket = packets.find((packet) => packet.kind === PacketKind.clear);
  const drawPackets = packets.filter((packet) => packet.kind === PacketKind.draw);
  if (!clearPacket || drawPackets.length === 0) throw new Error("RPCS3 did not emit a clear and draw packet");
  const clear = clearValue(clearPacket);
  const translated = drawPackets.map(translateDraw);
  const depthStates = drawPackets.map(depthState);
  const targetStates = drawPackets.map(renderTargetState);
  const translatedAt = performance.now();
  const pipelineCache = prepared.pipelineCache ??= new Map();
  let pipelineCacheHits = 0;
  let pipelineCacheMisses = 0;
  const resources = translated.map((draw, index) => {
    const declarations = draw.fragment.textured
      ? "@group(0) @binding(0) var rsxTexture0: texture_2d<f32>; @group(0) @binding(1) var rsxSampler0: sampler;"
      : "";
    const shaderCode = `
      ${declarations}
      struct VertexOut {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
        @location(1) texcoord0: vec4f,
      };
      @vertex fn vertex_main(
        @location(0) position: vec4f,
        @location(1) color: vec4f,
        @location(2) texcoord0: vec4f,
      ) -> VertexOut {
        var result: VertexOut;
        result.position = position;
        result.color = color;
        result.texcoord0 = texcoord0;
        return result;
      }
      @fragment fn fragment_main(input: VertexOut) -> @location(0) vec4f {
        ${draw.fragment.code}
      }
    `;
    const pipelineKey = JSON.stringify([
      shaderCode,
      format,
      draw.topology,
      depthStates[index],
      targetStates[index].blend,
      targetStates[index].writeMask,
    ]);
    let pipeline = pipelineCache.get(pipelineKey);
    if (pipeline) {
      pipelineCacheHits += 1;
    } else {
      pipelineCacheMisses += 1;
      const shader = device.createShaderModule({ label: `RPCS3 translated RSX program ${index}`, code: shaderCode });
      pipeline = device.createRenderPipeline({
        label: `RPCS3 RSX WebGPU pipeline ${index}`,
        layout: "auto",
        vertex: {
          module: shader,
          entryPoint: "vertex_main",
          buffers: [{
            arrayStride: 48,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
            ],
          }],
        },
        fragment: {
          module: shader,
          entryPoint: "fragment_main",
          targets: [{ format, blend: targetStates[index].blend, writeMask: targetStates[index].writeMask }],
        },
        primitive: { topology: draw.topology, cullMode: "none" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: depthStates[index].writeEnabled,
          depthCompare: depthStates[index].comparison,
        },
      });
      pipelineCache.set(pipelineKey, pipeline);
    }
    const buffer = device.createBuffer({ size: draw.output.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, draw.output.buffer, draw.output.byteOffset, draw.output.byteLength);
    let textureResource;
    let bindGroup;
    if (draw.fragment.textured) {
      const descriptor = drawPackets[index].textures.find((texture) => texture.stage === 0 && texture.slot === 0);
      if (!descriptor) throw new Error("RPCS3 fragment texture zero is missing");
      textureResource = uploadTexture2D(device, descriptor);
      bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: textureResource.texture.createView() },
          { binding: 1, resource: textureResource.sampler },
        ],
      });
    }
    return { pipeline, buffer, bindGroup, textureResource };
  });
  const depthTexture = device.createTexture({
    label: "RPCS3 RSX depth target",
    size: { width: canvas.width, height: canvas.height },
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const resourcesReadyAt = performance.now();
  const texture = context.getCurrentTexture();
  const encoder = device.createCommandEncoder({ label: "RPCS3 RSX packet frame" });
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: texture.createView(), clearValue: clear, loadOp: "clear", storeOp: "store",
  }], depthStencilAttachment: {
    view: depthTexture.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
  } });
  for (let index = 0; index < translated.length; index += 1) {
    pass.setPipeline(resources[index].pipeline);
    pass.setVertexBuffer(0, resources[index].buffer);
    if (targetStates[index].blendEnabled) pass.setBlendConstant(targetStates[index].blendConstant);
    if (resources[index].bindGroup) pass.setBindGroup(0, resources[index].bindGroup);
    pass.draw(translated[index].output.length / 12);
  }
  pass.end();
  const readbackEnabled = options.readback !== false;
  const bytesPerRow = readbackEnabled ? Math.ceil((canvas.width * 4) / 256) * 256 : 0;
  const readback = readbackEnabled ? device.createBuffer({
    size: bytesPerRow * canvas.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  }) : undefined;
  if (readback) {
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow, rowsPerImage: canvas.height },
      { width: canvas.width, height: canvas.height });
  }
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  if (readback) await readback.mapAsync(GPUMapMode.READ);
  const readbackReadyAt = performance.now();
  const pixels = readback ? new Uint8Array(readback.getMappedRange()) : undefined;
  const bgra = format.startsWith("bgra");
  const rgba = readback && options.captureRgba ? new Uint8Array(canvas.width * canvas.height * 4) : undefined;
  let changedPixels;
  let clearPixels;
  let frameHash;
  let changedMinX = canvas.width;
  let changedMinY = canvas.height;
  let changedMaxX = -1;
  let changedMaxY = -1;
  if (pixels) {
    changedPixels = 0;
    clearPixels = 0;
    frameHash = 2166136261;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = y * bytesPerRow + x * 4;
        const red = pixels[offset + (bgra ? 2 : 0)];
        const green = pixels[offset + 1];
        const blue = pixels[offset + (bgra ? 0 : 2)];
        const alpha = pixels[offset + 3];
        const isClear = red === clear.bytes[0] && green === clear.bytes[1] && blue === clear.bytes[2] && alpha === clear.bytes[3];
        clearPixels += isClear ? 1 : 0;
        changedPixels += isClear ? 0 : 1;
        if (!isClear) {
          changedMinX = Math.min(changedMinX, x);
          changedMinY = Math.min(changedMinY, y);
          changedMaxX = Math.max(changedMaxX, x);
          changedMaxY = Math.max(changedMaxY, y);
        }
        if (rgba) rgba.set([red, green, blue, alpha], (y * canvas.width + x) * 4);
        frameHash = Math.imul(frameHash ^ red, 16777619);
        frameHash = Math.imul(frameHash ^ green, 16777619);
        frameHash = Math.imul(frameHash ^ blue, 16777619);
        frameHash = Math.imul(frameHash ^ alpha, 16777619);
      }
    }
    readback.unmap();
    readback.destroy();
    frameHash >>>= 0;
  }
  const readbackScannedAt = performance.now();

  if (options.replayPresentation !== false && typeof globalThis.requestAnimationFrame === "function") {
    // WebGPU canvas textures are not retained bitmaps. Keep presenting the
    // most recent RSX frame until a newer frame replaces it, just as the live
    // emulator loop will. This is presentation scheduling only: guest/RSX
    // execution above is neither delayed nor paced by requestAnimationFrame.
    const presentation = { cancelled: false, animationFrame: undefined, resources, depthTexture };
    const present = () => {
      if (presentation.cancelled) return;
      presentation.animationFrame = globalThis.requestAnimationFrame(present);
      const presentationEncoder = device.createCommandEncoder({ label: "RPCS3 RSX compositor frame" });
      const presentationPass = presentationEncoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(), clearValue: clear, loadOp: "clear", storeOp: "store",
      }], depthStencilAttachment: {
        view: depthTexture.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
      } });
      for (let index = 0; index < translated.length; index += 1) {
        presentationPass.setPipeline(resources[index].pipeline);
        presentationPass.setVertexBuffer(0, resources[index].buffer);
        if (targetStates[index].blendEnabled) presentationPass.setBlendConstant(targetStates[index].blendConstant);
        if (resources[index].bindGroup) presentationPass.setBindGroup(0, resources[index].bindGroup);
        presentationPass.draw(translated[index].output.length / 12);
      }
      presentationPass.end();
      device.queue.submit([presentationEncoder.finish()]);
    };
    activePresentation = presentation;
    presentation.animationFrame = globalThis.requestAnimationFrame(present);
  } else if (options.retainResources === false) {
    resources.forEach(({ buffer, textureResource }) => {
      buffer.destroy();
      textureResource?.texture.destroy();
    });
    depthTexture.destroy();
  } else {
    // Interactive presentation submits once per actual guest flip. Retain the
    // resources until the next guest frame replaces them, without a browser
    // animation timer or a texture readback in the hot path.
    activePresentation = { cancelled: false, animationFrame: undefined, resources, depthTexture };
  }
  const info = adapter.info ?? {};
  return {
    presented: true,
    format,
    adapter: [info.vendor, info.architecture, info.device, info.description, info.backend, info.type].filter(Boolean).join(" · "),
    width: canvas.width,
    height: canvas.height,
    draws: translated.length,
    vertices: translated.reduce((sum, draw) => sum + draw.output.length / 12, 0),
    vertexOpcodes: [...new Set(translated.flatMap((draw) => draw.vertexOpcodes))].sort((a, b) => a - b),
    fragmentOpcodes: [...new Set(translated.flatMap((draw) => draw.fragmentOpcodes))].sort((a, b) => a - b),
    depthStates,
    targetStates,
    drawDiagnostics: translated.map((draw, index) => ({
      ...drawDiagnostics(draw),
      texture: resources[index].textureResource?.diagnostics,
    })),
    changedPixels,
    clearPixels,
    frameHash,
    changedBounds: !pixels || changedMaxX < 0 ? null : { minX: changedMinX, minY: changedMinY, maxX: changedMaxX, maxY: changedMaxY },
    timings: {
      translateMs: translatedAt - renderStartedAt,
      resourceAndPipelineMs: resourcesReadyAt - translatedAt,
      submitAndMappedReadbackMs: readbackReadyAt - resourcesReadyAt,
      readbackScanMs: readbackScannedAt - readbackReadyAt,
      totalMs: readbackScannedAt - renderStartedAt,
    },
    pipelineCache: { hits: pipelineCacheHits, misses: pipelineCacheMisses, size: pipelineCache.size },
    rgbaBase64: rgba ? base64(rgba) : undefined,
  };
}
