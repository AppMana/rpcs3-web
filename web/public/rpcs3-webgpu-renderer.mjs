import { ClearMask, PacketFlag, PacketKind, SectionKind, fnv1a32, SurfaceOpKind } from "./rpcs3-webgpu-packet.mjs";

let activePresentation;

// Stops re-presenting the last frame. GPU resources (rings, frame target,
// texture cache, pipelines) persist on the prepared device; see releaseWebGPU.
export function stopWebGPUPresentation() {
  if (!activePresentation) return;
  activePresentation.cancelled = true;
  if (activePresentation.animationFrame !== undefined) cancelAnimationFrame(activePresentation.animationFrame);
  activePresentation = undefined;
}

// Releases every GPU resource the renderer keeps on a prepared device.
export function releaseWebGPU(prepared) {
  if (!prepared) return;
  stopWebGPUPresentation();
  for (const name of ["uniformRing", "vertexRing", "streamRing", "indexRing"]) {
    prepared[name]?.buffer?.destroy();
    prepared[name] = undefined;
  }
  prepared.frameTarget?.color.destroy();
  prepared.frameTarget?.depth.destroy();
  prepared.frameTarget = undefined;
  prepared.textureCache?.forEach((resource) => resource.texture.destroy());
  prepared.textureCache = undefined;
  prepared.textureCacheBytes = 0;
  prepared.surfaceTable?.forEach((surface) => { surface.texture.destroy(); surface.scratch?.destroy(); surface.regions?.forEach((region) => region.texture.destroy()); });
  prepared.surfaceTable = undefined;
  prepared.bindGroupCache = undefined;
  prepared.pipelineCache = undefined;
  prepared.programCache = undefined;
  prepared.clearPipelineCache = undefined;
  prepared.clearBindGroup = undefined;
  prepared.lastClear = undefined;
  prepared.nullTexture?.texture.destroy();
  prepared.nullTexture = undefined;
}

// Uniform layout shared by every translated program: RPCS3's vertex
// environment and 468-entry constant bank, then the fragment environment
// (fill_fragment_state_buffer) and the program's inline constants as
// write_fragment_constants_to_buffer emits them.
const VERTEX_LAYOUT_BYTES = 144;
const VERTEX_STATE_BYTES = 96 + 468 * 16 + VERTEX_LAYOUT_BYTES;
const FRAGMENT_CONSTANT_SLOTS = 256;
const FRAGMENT_STATE_BYTES = 32 + FRAGMENT_CONSTANT_SLOTS * 16;
const UNIFORM_ALIGNMENT = 256;
const alignTo = (value, alignment) => Math.ceil(value / alignment) * alignment;
const VERTEX_STATE_STRIDE = alignTo(VERTEX_STATE_BYTES, UNIFORM_ALIGNMENT);
const FRAGMENT_STATE_STRIDE = alignTo(FRAGMENT_STATE_BYTES, UNIFORM_ALIGNMENT);
const PROGRAM_CACHE_LIMIT = 256;
const PIPELINE_CACHE_LIMIT = 512;
const BIND_GROUP_CACHE_LIMIT = 1024;

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
  }
  return btoa(binary);
}

const VertexType = Object.freeze({ snorm16: 1, float32: 2, float16: 3, unorm8: 4, sint16: 5, cmp32: 6, uint8: 7 });
const VertexVaryings = Object.freeze([
  "frontColor", "frontSpecular", "backColor", "backSpecular", "fog",
  "texcoord0", "texcoord1", "texcoord2", "texcoord3", "texcoord4",
  "texcoord5", "texcoord6", "texcoord7", "texcoord8", "texcoord9",
]);
const VertexVaryingDestinations = Object.freeze([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 6]);
const VertexOutputStrideFloats = 64;

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

const VertexElementSize = Object.freeze([0, 2, 4, 2, 1, 2, 4, 1]);
const VertexScale = Object.freeze([1, 32767.5, 1, 1, 255, 1, 32767, 1]);

function bitsToFloat32(word) {
  return new Float32Array(new Uint32Array([word >>> 0]).buffer)[0];
}

function halfToFloat32(half) {
  const sign = (half & 0x8000) ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

// Signed 16-bit interpretation of a 16-bit field, as RSXVertexFetch.glsl's sext.
function sext16(value) {
  return value < 0x8000 ? value : value - 65536;
}

// CPU oracle of RPCS3's RSXVertexFetch.glsl read_location/fetch_attribute:
// the same descriptor fields, vertex id rule, byte assembly, type decode and
// scaling, so the GPU fetch below can be checked against it bit for bit.
function readAttribute(packet, descriptor, vertexIndex, vertexBaseIndex, vertexIndexOffset) {
  const bytes = packet.sections[descriptor.volatile ? SectionKind.volatileVertices : SectionKind.persistentVertices].bytes;
  let vertexId;
  if (descriptor.frequency === 0) vertexId = 0;
  else if (descriptor.modulo) vertexId = ((vertexIndex + vertexIndexOffset) | 0) % descriptor.frequency;
  else vertexId = Math.trunc(((vertexIndex - vertexBaseIndex) | 0) / descriptor.frequency);
  const elementSize = VertexElementSize[descriptor.type];
  const scale = VertexScale[descriptor.type];
  let i = vertexId * descriptor.stride + descriptor.offset;
  const byte = (index) => (index >= 0 && index < bytes.byteLength ? bytes[index] : 0);
  const result = [0, 0, 0, 0];
  for (let n = 0; n < descriptor.components; n += 1) {
    let x = byte(i++);
    if (elementSize === 2) {
      const y = byte(i++);
      x = descriptor.bigEndian ? (y | (x << 8)) : (x | (y << 8));
    } else if (elementSize === 4) {
      const y = byte(i++);
      const z = byte(i++);
      const w = byte(i++);
      x = descriptor.bigEndian
        ? ((w | (z << 8) | (y << 16) | (x << 24)) >>> 0)
        : ((x | (y << 8) | (z << 16) | (w << 24)) >>> 0);
    }
    result[n] = x >>> 0;
  }
  let ret;
  if (descriptor.type === VertexType.snorm16 || descriptor.type === VertexType.sint16) {
    ret = result.map((value) => sext16(value) + (descriptor.type === VertexType.snorm16 ? 0.5 : 0));
  } else if (descriptor.type === VertexType.float32) {
    ret = result.map(bitsToFloat32);
  } else if (descriptor.type === VertexType.float16) {
    const a = ((result[0] & 0xffff) | ((result[1] & 0xffff) << 16)) >>> 0;
    const b = ((result[2] & 0xffff) | ((result[3] & 0xffff) << 16)) >>> 0;
    ret = [halfToFloat32(a & 0xffff), halfToFloat32(a >>> 16), halfToFloat32(b & 0xffff), halfToFloat32(b >>> 16)];
  } else if (elementSize === 1) {
    ret = result.map((value) => value);
  } else {
    const packed = result[0];
    const fields = [packed & 0x7ff, (packed >>> 11) & 0x7ff, (packed >>> 22) & 0x3ff, scale >>> 0];
    ret = [sext16((fields[0] << 5) & 0xffff), sext16((fields[1] << 5) & 0xffff), sext16((fields[2] << 6) & 0xffff), sext16(fields[3] & 0xffff)];
  }
  if (descriptor.components < 4) ret[3] = scale;
  return ret.map((value) => value / scale);
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

function compileVertexSource(words, sourceIndex, d1, d3, referencedInputs) {
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
  let expression;
  if (type === 1) expression = `temporary[${bits(source, 2, 6)}]`;
  else if (type === 2) {
    referencedInputs?.add(d1.inputSource);
    expression = `input.attribute${d1.inputSource}`;
  }
  else if (type === 3) {
    if (d3.indexConstant) throw new Error("indexed RSX vertex constants are not yet translated");
    expression = `rsxVertexState.constants[${d1.constantSource}]`;
  } else throw new Error("undefined RSX vertex source register");
  const swizzleCode = bits(source, 8, 8);
  if (swizzleCode !== 0x1b) {
    const channels = [6, 4, 2, 0].map((shift) => "xyzw"[bits(swizzleCode, shift, 2)]).join("");
    expression = `${expression}.${channels}`;
  }
  if (absolute) expression = `abs(${expression})`;
  if (bits(source, 16, 1)) expression = `-(${expression})`;
  return expression;
}

function compileVertexProgram(packet) {
  const program = packet.sections[SectionKind.vertexProgram].bytes;
  if (program.byteLength % 16 !== 0) throw new Error("unaligned RSX vertex program");
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const lines = [
    "var temporary: array<vec4f, 32>;",
    "var destination: array<vec4f, 16>;",
    ...Array.from({ length: 16 }, (_, index) => `destination[${index}] = vec4f(0.0, 0.0, 0.0, 1.0);`),
  ];
  const opcodes = [];
  const scalarOpcodes = [];
  const referencedInputs = new Set();
  let emitted = 0;
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
      scalarDestinationTemp: bits(words[3], 7, 6),
      vectorMask: [16, 15, 14, 13].map((bit) => Boolean(bits(words[3], bit, 1))),
      scalarMask: [20, 19, 18, 17].map((bit) => Boolean(bits(words[3], bit, 1))),
    };
    if (d1.vectorOpcode !== 0) {
      const a = compileVertexSource(words, 0, d1, d3, referencedInputs);
      let value;
      if (d1.vectorOpcode === 1) value = a;
      else if (d1.vectorOpcode === 2) value = `(${a} * ${compileVertexSource(words, 1, d1, d3, referencedInputs)})`;
      else if (d1.vectorOpcode === 3) value = `(${a} + ${compileVertexSource(words, 2, d1, d3, referencedInputs)})`;
      else if (d1.vectorOpcode === 4) value = `fma(${a}, ${compileVertexSource(words, 1, d1, d3, referencedInputs)}, ${compileVertexSource(words, 2, d1, d3, referencedInputs)})`;
      else if (d1.vectorOpcode === 5) value = `vec4f(dot(${a}.xyz, ${compileVertexSource(words, 1, d1, d3, referencedInputs)}.xyz))`;
      else if (d1.vectorOpcode === 6) {
        const b = compileVertexSource(words, 1, d1, d3, referencedInputs);
        value = `vec4f(dot(${a}.xyz, ${b}.xyz) + ${b}.w)`;
      } else if (d1.vectorOpcode === 7) value = `vec4f(dot(${a}, ${compileVertexSource(words, 1, d1, d3, referencedInputs)}))`;
      else if (d1.vectorOpcode === 8) {
        const b = compileVertexSource(words, 1, d1, d3, referencedInputs);
        value = `vec4f(1.0, ${a}.y * ${b}.y, ${a}.z, ${b}.w)`;
      } else if (d1.vectorOpcode === 9) value = `min(${a}, ${compileVertexSource(words, 1, d1, d3, referencedInputs)})`;
      else if (d1.vectorOpcode === 10) value = `max(${a}, ${compileVertexSource(words, 1, d1, d3, referencedInputs)})`;
      else if ([11, 12, 16, 18, 19, 20].includes(d1.vectorOpcode)) {
        const comparison = new Map([[11, "<"], [12, ">="], [16, "=="], [18, ">"], [19, "<="], [20, "!="]]).get(d1.vectorOpcode);
        value = `select(vec4f(0.0), vec4f(1.0), ${a} ${comparison} ${compileVertexSource(words, 1, d1, d3, referencedInputs)})`;
      } else if (d1.vectorOpcode === 14) value = `fract(${a})`;
      else if (d1.vectorOpcode === 15) value = `floor(${a})`;
      else if (d1.vectorOpcode === 17) value = "vec4f(0.0)";
      else if (d1.vectorOpcode === 21) value = "vec4f(1.0)";
      else if (d1.vectorOpcode === 22) value = `sign(${a})`;
      else throw new Error(`RSX vector vertex opcode ${d1.vectorOpcode} is not yet translated`);
      if (d0.saturate) value = `clamp(${value}, vec4f(0.0), vec4f(1.0))`;
      const result = `vertexVectorValue${emitted++}`;
      lines.push(`let ${result} = ${value};`);
      for (let component = 0; component < 4; component += 1) {
        if (!d3.vectorMask[component]) continue;
        const channel = "xyzw"[component];
        if (d0.destinationTemp !== 0x3f) lines.push(`temporary[${d0.destinationTemp}].${channel} = ${result}.${channel};`);
        if (d0.vectorResult && d3.destination < 16) lines.push(`destination[${d3.destination}].${channel} = ${result}.${channel};`);
      }
      opcodes.push(d1.vectorOpcode);
    }
    if (d1.scalarOpcode !== 0) {
      const source = compileVertexSource(words, 2, d1, d3, referencedInputs);
      let value;
      if (d1.scalarOpcode === 1) value = `vec4f(${source}.x)`;
      else if (d1.scalarOpcode === 2) value = `vec4f(1.0 / ${source}.x)`;
      else if (d1.scalarOpcode === 3) value = `vec4f(clamp(1.0 / ${source}.x, 5.42101e-20, 1.884467e19))`;
      else if (d1.scalarOpcode === 4) value = `vec4f(inverseSqrt(${source}.x))`;
      else if (d1.scalarOpcode === 5) value = `vec4f(exp(${source}.x))`;
      else if (d1.scalarOpcode === 6) value = `vec4f(log(${source}.x))`;
      else if (d1.scalarOpcode === 7) value = `vec4f(1.0, max(${source}.x, 0.0), select(0.0, exp2(${source}.w * log2(max(${source}.y, 1e-10))), ${source}.x > 0.0), 1.0)`;
      else if (d1.scalarOpcode === 13) value = `vec4f(log2(${source}.x))`;
      else if (d1.scalarOpcode === 14) value = `vec4f(exp2(${source}.x))`;
      else if (d1.scalarOpcode === 15) value = `vec4f(sin(${source}.x))`;
      else if (d1.scalarOpcode === 16) value = `vec4f(cos(${source}.x))`;
      else throw new Error(`RSX scalar vertex opcode ${d1.scalarOpcode} is not yet translated`);
      if (d0.saturate) value = `clamp(${value}, vec4f(0.0), vec4f(1.0))`;
      const result = `vertexScalarValue${emitted++}`;
      lines.push(`let ${result} = ${value};`);
      for (let component = 0; component < 4; component += 1) {
        if (!d3.scalarMask[component]) continue;
        const channel = "xyzw"[component];
        if (d3.scalarDestinationTemp !== 0x3f) lines.push(`temporary[${d3.scalarDestinationTemp}].${channel} = ${result}.${channel};`);
        else if (!d0.vectorResult && d3.destination < 16) lines.push(`destination[${d3.destination}].${channel} = ${result}.${channel};`);
      }
      scalarOpcodes.push(d1.scalarOpcode);
    }
    if (d3.end) break;
  }
  if (packet.vertexProgramControl === 0) lines.push("destination[3] = destination[1];", "destination[4] = destination[2];");
  lines.push(
    "let rsxPosition = destination[0];",
    "var transformedPosition = vec4f(",
    "  dot(rsxVertexState.environment[0], rsxPosition),",
    "  dot(rsxVertexState.environment[1], rsxPosition),",
    "  dot(rsxVertexState.environment[2], rsxPosition),",
    "  dot(rsxVertexState.environment[3], rsxPosition),",
    ");",
    "transformedPosition.y = -transformedPosition.y;",
    // RPCS3's Vulkan backend sets the viewport depth range to the RSX clip min/max registers
    // (VKGSRender::set_viewport, VK_EXT_depth_range_unrestricted): z_window = min + z_ndc * (max - min).
    // WebGPU viewports cannot express an inverted range, so the same transform is applied to clip z.
    "let rsxDepthRange = vec2f(rsxVertexState.environment[4].w, rsxVertexState.environment[5].x);",
    "transformedPosition.z = transformedPosition.z * (rsxDepthRange.y - rsxDepthRange.x) + rsxDepthRange.x * transformedPosition.w;",
    "result.position = transformedPosition;",
    ...VertexVaryings.map((name, index) => `result.${name} = destination[${VertexVaryingDestinations[index]}];`),
  );
  return {
    code: lines.join("\n"),
    opcodes: [...new Set(opcodes)].sort((a, b) => a - b),
    scalarOpcodes: [...new Set(scalarOpcodes)].sort((a, b) => a - b),
    inputs: [...referencedInputs].sort((a, b) => a - b),
  };
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
  const scalarOpcodes = [];
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
      scalarDestinationTemp: bits(words[3], 7, 6),
      vectorMask: [16, 15, 14, 13].map((bit) => Boolean(bits(words[3], bit, 1))),
      scalarMask: [20, 19, 18, 17].map((bit) => Boolean(bits(words[3], bit, 1))),
    };
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
      const write = (target) => d3.vectorMask.forEach((enabled, component) => { if (enabled) target[component] = value[component]; });
      if (d0.destinationTemp !== 0x3f) write(temps[d0.destinationTemp]);
      if (d0.vectorResult && d3.destination < destinations.length) write(destinations[d3.destination]);
      opcodes.push(d1.vectorOpcode);
    }
    if (d1.scalarOpcode !== 0) {
      const source = decodeVertexSource(words, 2, d0, d1, d3, inputs, temps, packet);
      let value;
      if (d1.scalarOpcode === 1) value = vector(source[0]);
      else if (d1.scalarOpcode === 2) value = vector(1 / source[0]);
      else if (d1.scalarOpcode === 3) value = vector(Math.max(5.42101e-20, Math.min(1.884467e19, 1 / source[0])));
      else if (d1.scalarOpcode === 4) value = vector(1 / Math.sqrt(source[0]));
      else if (d1.scalarOpcode === 5) value = vector(Math.exp(source[0]));
      else if (d1.scalarOpcode === 6) value = vector(Math.log(source[0]));
      else if (d1.scalarOpcode === 7) {
        const x = Math.max(source[0], 0);
        const y = Math.max(source[1], 1e-10);
        value = [1, x, x > 0 ? 2 ** (source[3] * Math.log2(y)) : 0, 1];
      } else if (d1.scalarOpcode === 13) value = vector(Math.log2(source[0]));
      else if (d1.scalarOpcode === 14) value = vector(2 ** source[0]);
      else if (d1.scalarOpcode === 15) value = vector(Math.sin(source[0]));
      else if (d1.scalarOpcode === 16) value = vector(Math.cos(source[0]));
      else throw new Error(`RSX scalar vertex opcode ${d1.scalarOpcode} is not yet translated`);
      if (d0.saturate) value = value.map((component) => Math.max(0, Math.min(1, component)));
      const write = (target) => d3.scalarMask.forEach((enabled, component) => { if (enabled) target[component] = value[component]; });
      if (d3.scalarDestinationTemp !== 0x3f) write(temps[d3.scalarDestinationTemp]);
      else if (!d0.vectorResult && d3.destination < destinations.length) write(destinations[d3.destination]);
      scalarOpcodes.push(d1.scalarOpcode);
    }
    if (d3.end) break;
  }
  if (packet.vertexProgramControl === 0) {
    destinations[3] = [...destinations[1]];
    destinations[4] = [...destinations[2]];
  }
  return { destinations, opcodes, scalarOpcodes };
}

function applyVertexEnvironment(packet, position) {
  const bytes = packet.sections[SectionKind.vertexEnvironment].bytes;
  if (bytes.byteLength < 64) throw new Error("RPCS3 vertex environment is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const columns = Array.from({ length: 4 }, (_, column) =>
    Array.from({ length: 4 }, (_, row) => view.getFloat32(column * 16 + row * 4, true)));
  const transformed = columns.map((column) => position.reduce((sum, component, index) => sum + component * column[index], 0));
  // Viewport depth range from the RSX clip min/max registers (floats 19 and 20), as the WGSL epilogue applies it.
  const clipMin = view.getFloat32(76, true);
  const clipMax = view.getFloat32(80, true);
  transformed[2] = transformed[2] * (clipMax - clipMin) + clipMin * transformed[3];
  return transformed;
}

function fragmentWord(view, offset) {
  const raw = view.getUint32(offset, true);
  return (((raw & 0x00ff00ff) << 8) | ((raw & 0xff00ff00) >>> 8)) >>> 0;
}

// RPCS3's fill_fragment_state_buffer stores the window-position scale at
// float 5 and the biases at floats 6 and 7 of the fragment environment.
function fragmentWindowPosition() {
  return "vec4f(input.position.x * abs(rsxFragmentState.environment[1].y) + rsxFragmentState.environment[1].z, "
    + "input.position.y * rsxFragmentState.environment[1].y + rsxFragmentState.environment[1].w, input.position.z, input.position.w)";
}

function fragmentSource(packet, words, sourceIndex, inlineConstant) {
  const word = words[sourceIndex + 1];
  const type = bits(word, 0, 2);
  let source;
  if (type === 0) {
    const registerFile = bits(word, 8, 1) ? "r16" : "r32";
    source = `${registerFile}[${bits(word, 2, 6)}]`;
  } else if (type === 1) {
    const attribute = bits(words[0], 13, 4);
    if (attribute === 0) source = fragmentWindowPosition();
    else if (attribute === 1) source = "select(input.backColor, input.frontColor, frontFacing)";
    else if (attribute === 2) source = "select(input.backSpecular, input.frontSpecular, frontFacing)";
    else if (attribute === 3) source = "input.fog";
    else if (attribute >= 4 && attribute <= 13) source = `input.texcoord${attribute - 4}`;
    else if (attribute === 14) source = "vec4f(select(-1.0, 1.0, frontFacing))";
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

// rsx::texture_dimension_extended of the fragment texture bound to a slot: 0 = 1D, 1 = 2D,
// 2 = cube, 3 = 3D. A disabled sampler binds RPCS3's 2D null image.
function textureDimension(packet, slot) {
  const descriptor = packet.textures.find((texture) => texture.stage === 0 && texture.slot === slot);
  return descriptor ? descriptor.dimension : 1;
}

const WGSL_TEXTURE_TYPES = ["texture_1d<f32>", "texture_2d<f32>", "texture_cube<f32>", "texture_3d<f32>"];
const TEXTURE_VIEW_DIMENSIONS = ["1d", "2d", "cube", "3d"];

// Compile the RSX fragment instruction stream into WGSL using the same bit
// fields and execution rules as RPCS3's existing GLSL fragment interpreter.
// The closure is intentionally strict: unsupported instructions fail instead
// of silently manufacturing a plausible frame.
function compileFragmentProgram(packet) {
  const bytes = packet.sections[SectionKind.fragmentProgram].bytes;
  if (bytes.byteLength < 16 || bytes.byteLength % 16 !== 0) throw new Error("invalid RSX fragment program");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines = ["var r16: array<vec4f, 48>;", "var r32: array<vec4f, 48>;", "var cc: array<vec4f, 2>;", "var rsxDiscard = false;"];
  const opcodes = [];
  const textureSlots = new Set();
  const textureDimensions = new Map();
  let constantIndex = 0;
  for (let offset = 0; offset < bytes.byteLength;) {
    const words = [0, 4, 8, 12].map((wordOffset) => fragmentWord(view, offset + wordOffset));
    const opcode = bits(words[0], 24, 6);
    const end = Boolean(bits(words[0], 0, 1));
    // Any source of type 2 means the next 16 bytes are an inline constant,
    // regardless of opcode (fragment_program_utils::is_any_src_constant).
    // RPCS3 uploads those constants in instruction order; the packet's
    // fragment_constants section is indexed the same way.
    const hasConstant = [1, 2, 3].some((index) => bits(words[index], 0, 2) === 2);
    if (hasConstant && offset + 32 > bytes.byteLength) throw new Error("truncated RSX fragment inline constant");
    const inlineConstant = hasConstant ? `rsxFragmentState.constants[${constantIndex++}]` : undefined;
    if (opcode === 0 || opcode === 0x3d || opcode === 0x3e) {
      opcodes.push(opcode);
      offset += hasConstant ? 32 : 16;
      if (end) break;
      continue;
    }

    const operandCounts = new Map([
      [1, 1], [2, 2], [3, 2], [4, 3], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2],
      [0x0a, 2], [0x0b, 2], [0x0c, 2], [0x0d, 2], [0x0e, 2], [0x0f, 2],
      [0x10, 1], [0x11, 1], [0x12, 0], [0x13, 1], [0x14, 1], [0x15, 1], [0x16, 1], [0x17, 1], [0x18, 1], [0x19, 3],
      [0x24, 1], [0x25, 1], [0x27, 1], [0x28, 1], [0x29, 1], [0x2a, 1], [0x2b, 3],
      [0x2f, 2], [0x31, 2], [0x33, 3], [0x34, 3], [0x36, 2],
      [0x1a, 1], [0x1b, 1], [0x1c, 1], [0x1d, 1], [0x1e, 1], [0x1f, 3],
      [0x20, 0], [0x21, 0], [0x22, 1], [0x23, 1], [0x2e, 3],
      [0x38, 2], [0x39, 1], [0x3a, 2], [0x3b, 2], [0x3c, 1],
    ]);
    const operandCount = operandCounts.get(opcode);
    if (operandCount === undefined) throw new Error(`RSX fragment opcode ${opcode} is not yet translated`);
    const execution = bits(words[1], 18, 3);
    const conditionRegister = bits(words[1], 31, 1);
    const conditionSwizzle = bits(words[1], 21, 8);
    const conditionChannels = [0, 2, 4, 6].map((shift) => "xyzw"[bits(conditionSwizzle, shift, 2)]).join("");
    const condition = `cc[${conditionRegister}].${conditionChannels}`;
    if (opcode === 0x12) {
      // KIL: RPCS3's AddFlowOp gates _kill() on the instruction's condition
      // (unconditional for an all-set execution mask, dropped for a clear
      // one, otherwise `if (any(cond))`); the ROP epilogue discards after
      // the program completes.
      const flowComparisons = [undefined, "<", "==", "<=", ">", "!=", ">=", undefined];
      if (execution === 7) lines.push("rsxDiscard = true;");
      else if (execution !== 0) lines.push(`if (any(${condition} ${flowComparisons[execution]} vec4f(0.0))) { rsxDiscard = true; }`);
      opcodes.push(opcode);
      offset += hasConstant ? 32 : 16;
      if (end) break;
      continue;
    }
    const sources = Array.from({ length: operandCount }, (_, index) => fragmentSource(packet, words, index, inlineConstant));
    let value;
    if (opcode === 1) value = sources[0];
    else if (opcode === 2) value = `(${sources[0]} * ${sources[1]})`;
    else if (opcode === 3) value = `(${sources[0]} + ${sources[1]})`;
    else if (opcode === 4) value = `fma(${sources[0]}, ${sources[1]}, ${sources[2]})`;
    else if (opcode === 5) value = `vec4f(dot(${sources[0]}.xyz, ${sources[1]}.xyz))`;
    else if (opcode === 6) value = `vec4f(dot(${sources[0]}, ${sources[1]}))`;
    else if (opcode === 8) value = `min(${sources[0]}, ${sources[1]})`;
    else if (opcode === 9) value = `max(${sources[0]}, ${sources[1]})`;
    else if (opcode === 7) value = `vec4f(1.0, ${sources[0]}.y * ${sources[1]}.y, ${sources[0]}.z, ${sources[1]}.w)`;
    else if (opcode >= 0x0a && opcode <= 0x0f) {
      const comparison = ["<", ">=", "<=", ">", "!=", "=="][opcode - 0x0a];
      value = `select(vec4f(0.0), vec4f(1.0), ${sources[0]} ${comparison} ${sources[1]})`;
    } else if (opcode === 0x10) value = `fract(${sources[0]})`;
    else if (opcode === 0x11) value = `floor(${sources[0]})`;
    else if (opcode === 0x15) value = `dpdx(${sources[0]})`;
    else if (opcode === 0x16) value = `dpdy(${sources[0]})`;
    else if (opcode === 0x13) value = `vec4f(bitcast<f32>(pack4x8snorm(${sources[0]})))`;
    else if (opcode === 0x14) value = `unpack4x8snorm(bitcast<u32>(${sources[0]}.x))`;
    else if (opcode === 0x24) value = `vec4f(bitcast<f32>(pack2x16float(${sources[0]}.xy)))`;
    else if (opcode === 0x25) value = `unpack2x16float(bitcast<u32>(${sources[0]}.x)).xyxy`;
    else if (opcode === 0x27) value = `vec4f(bitcast<f32>(pack4x8unorm(${sources[0]})))`;
    else if (opcode === 0x28) value = `unpack4x8unorm(bitcast<u32>(${sources[0]}.x))`;
    else if (opcode === 0x29) value = `vec4f(bitcast<f32>(pack2x16unorm(${sources[0]}.xy)))`;
    else if (opcode === 0x2a) value = `unpack2x16unorm(bitcast<u32>(${sources[0]}.x)).xyxy`;
    else if (opcode === 0x2b) value = `(${sources[0]}.xyxy + ${sources[1]}.xxxx * ${sources[2]}.xzxz + ${sources[1]}.yyyy * ${sources[2]}.ywyw)`;
    else if (opcode === 0x36) value = `reflect(${sources[0]}, ${sources[1]})`;
    else if (opcode === 0x17 || opcode === 0x18 || opcode === 0x19 || opcode === 0x2f || opcode === 0x31 || opcode === 0x33 || opcode === 0x34) {
      // TEX/TXP/TXD/TXL/TXB follow RPCS3's TEX2D, TEX2D_PROJ, TEX2D_GRAD, TEX2D_LOD and TEX2D_BIAS
      // (RSXFragmentTextureOps.glsl): source 0 carries the coordinate, TXP divides by w, TXD takes
      // the derivatives from sources 1 and 2, TXL the level and TXB the bias from source 1.x.
      // TEXBEM/TXPBEM first form the bump-mapped coordinate x2d (RSX_FP_OPCODE_BEM) from sources
      // 0..2 and then sample like TEX/TXP (FragmentProgramDecompiler.cpp).
      // The coordinate width follows the bound texture's dimension the way RPCS3 picks the
      // TEX1D/TEX2D/TEX3D (cube) function family from get_texture_dimension().
      const textureSlot = bits(words[0], 17, 4);
      const dimension = textureDimension(packet, textureSlot);
      const coord = dimension === 0 ? "x" : dimension === 1 ? "xy" : "xyz";
      const texture = `rsxTexture${textureSlot}, rsxSampler${textureSlot}`;
      const x2d = `(${sources[0]}.xyxy + ${sources[1]}.xxxx * ${sources[2]}.xzxz + ${sources[1]}.yyyy * ${sources[2]}.ywyw)`;
      if (opcode === 0x17) value = `textureSample(${texture}, ${sources[0]}.${coord})`;
      else if (opcode === 0x18) value = `textureSample(${texture}, ${sources[0]}.${coord} / ${sources[0]}.w)`;
      else if (opcode === 0x19) value = `textureSampleGrad(${texture}, ${sources[0]}.${coord}, ${sources[1]}.${coord}, ${sources[2]}.${coord})`;
      else if (opcode === 0x2f) value = `textureSampleLevel(${texture}, ${sources[0]}.${coord}, ${sources[1]}.x)`;
      else if (opcode === 0x31) value = `textureSampleBias(${texture}, ${sources[0]}.${coord}, ${sources[1]}.x)`;
      else if (opcode === 0x33) value = `textureSample(${texture}, ${x2d}.${coord})`;
      else value = `textureSample(${texture}, ${x2d}.${coord} / ${x2d}.w)`;
      // Render targets sampled as textures go through the surface's native component map
      // composed with the guest remap (vk::apply_swizzle_remap); uploads bake the remap.
      value = `rsxTexel${textureSlot}(${value})`;
      textureSlots.add(textureSlot);
      textureDimensions.set(textureSlot, dimension);
    } else if (opcode === 0x1a) value = `vec4f(1.0 / ${sources[0]}.x)`;
    else if (opcode === 0x1b) value = `vec4f(inverseSqrt(abs(${sources[0]}.x)))`;
    else if (opcode === 0x1c) value = `vec4f(exp2(${sources[0]}.x))`;
    else if (opcode === 0x1d) value = `vec4f(log2(${sources[0]}.x))`;
    else if (opcode === 0x1e) value = `vec4f(1.0, max(${sources[0]}.x, 0.0), select(0.0, exp2(${sources[0]}.w * log2(max(${sources[0]}.y, 1e-10))), ${sources[0]}.x > 0.0), 1.0)`;
    else if (opcode === 0x1f) value = `mix(${sources[2]}, ${sources[1]}, ${sources[0]})`;
    else if (opcode === 0x20) value = "vec4f(1.0)";
    else if (opcode === 0x21) value = "vec4f(0.0)";
    else if (opcode === 0x22) value = `vec4f(cos(${sources[0]}.x))`;
    else if (opcode === 0x23) value = `vec4f(sin(${sources[0]}.x))`;
    else if (opcode === 0x2e) value = `vec4f(dot(${sources[0]}.xy, ${sources[1]}.xy) + ${sources[2]}.x)`;
    else if (opcode === 0x38) value = `vec4f(dot(${sources[0]}.xy, ${sources[1]}.xy))`;
    else if (opcode === 0x39) value = `(select(${sources[0]}.xyz, normalize(${sources[0]}.xyz), length(${sources[0]}.xyz) > 0.0)).xyzz`;
    else if (opcode === 0x3a) value = `(${sources[0]} / ${sources[1]}.xxxx)`;
    else if (opcode === 0x3b) value = `select(${sources[0]}, ${sources[0]} / vec4f(sqrt(abs(${sources[1]}.x))), abs(${sources[0]}) > vec4f(0.0))`;
    else if (opcode === 0x3c) value = `vec4f(1.0, ${sources[0]}.y, select(0.0, exp2(${sources[0]}.w), ${sources[0]}.y > 0.0), 1.0)`;
    const scale = [1, 2, 4, 8, 1, 0.5, 0.25, 0.125][bits(words[2], 28, 3)];
    if (scale !== 1) value = `(${value} * ${scale})`;
    if (bits(words[0], 31, 1)) value = `clamp(${value}, vec4f(0.0), vec4f(1.0))`;
    const noDestination = Boolean(bits(words[0], 30, 1));
    const setCondition = Boolean(bits(words[0], 8, 1));
    const destination = bits(words[0], 1, 6);
    const registerFile = bits(words[0], 7, 1) ? "r16" : "r32";
    const conditionDestination = bits(words[1], 30, 1);
    const comparisons = [undefined, "<", "==", "<=", ">", "!=", ">=", undefined];
    const writtenComponents = Array.from({ length: 4 }, (_, component) => component)
      .filter((component) => bits(words[0], 9 + component, 1) && execution !== 0);
    const instructionValue = `instructionValue${opcodes.length}`;
    const instructionCondition = `instructionCondition${opcodes.length}`;
    if (writtenComponents.length > 0) {
      lines.push(`let ${instructionValue} = ${value};`);
      if (execution !== 7) lines.push(`let ${instructionCondition} = ${condition};`);
    }
    for (const component of writtenComponents) {
      const channel = "xyzw"[component];
      const writes = [];
      if (!noDestination) writes.push(`${registerFile}[${destination}].${channel} = ${instructionValue}.${channel};`);
      if (setCondition) {
        writes.push(`cc[${conditionDestination}].${channel} = ${instructionValue}.${channel};`);
      }
      if (writes.length === 0) continue;
      if (execution === 7) lines.push(...writes);
      else lines.push(`if (${instructionCondition}.${channel} ${comparisons[execution]} 0.0) { ${writes.join(" ")} }`);
    }
    opcodes.push(opcode);
    offset += hasConstant ? 32 : 16;
    if (end) break;
  }
  lines.push("if (rsxDiscard) { discard; }");
  lines.push(`return ${(packet.fragmentProgramControl & 0x40) !== 0 ? "r32" : "r16"}[0];`);
  if (constantIndex > FRAGMENT_CONSTANT_SLOTS) throw new Error(`RSX fragment program uses ${constantIndex} inline constants; the uniform holds ${FRAGMENT_CONSTANT_SLOTS}`);
  return {
    code: lines.join("\n"),
    textured: textureSlots.size > 0,
    textureSlots: [...textureSlots].sort((a, b) => a - b),
    textureDimensions,
    opcodes,
    constantCount: constantIndex,
  };
}

// Raw vertex index values of the draw, as the GPU sees them: 0..n-1 for
// arrays, the index buffer contents for indexed draws.
function drawVertexOrder(packet) {
  if (!(packet.flags & PacketFlag.indexed)) return Array.from({ length: packet.drawCount }, (_, index) => index);
  const bytes = packet.sections[SectionKind.indices].bytes;
  const elementSize = packet.indexType === 0 ? 4 : 2;
  if (bytes.byteLength < packet.drawCount * elementSize) throw new Error("RPCS3 index packet is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: packet.drawCount }, (_, index) =>
    elementSize === 4 ? view.getUint32(index * 4, true) : view.getUint16(index * 2, true));
}

function vertexIndexing(packet) {
  const layout = packet.sections[SectionKind.vertexLayout].bytes;
  const view = new DataView(layout.buffer, layout.byteOffset, layout.byteLength);
  return { vertexBaseIndex: view.getUint32(0, true), vertexIndexOffset: view.getUint32(4, true) };
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

function translateDraw(packet, program, vertexDiagnostics = false, vertexBackend = "webgpu-wgsl") {
  if (packet.kind !== PacketKind.draw) throw new Error(`packet ${packet.sequence} is not an RSX draw`);
  // RPCS3's shared BufferUtils has already expanded line loops, fans, quads,
  // and polygons. Select the WebGPU topology for that mature output instead
  // of independently rebuilding guest primitive winding here.
  const topology = primitiveTopology(packet);
  const allowedFlags = PacketFlag.indexed | PacketFlag.primitiveExpanded | PacketFlag.usesFragmentTextures | PacketFlag.primitiveRestart | PacketFlag.indexRestartSentinel;
  if (packet.flags & ~allowedFlags) throw new Error(`WebGPU draw closure cannot translate packet flags 0x${packet.flags.toString(16)}`);
  const indexed = Boolean(packet.flags & PacketFlag.indexed);
  const primitiveRestart = Boolean(packet.flags & PacketFlag.primitiveRestart);
  const indexFormat = packet.indexType === 0 ? "uint32" : "uint16";
  // WebGPU treats the maximum index value as a restart marker on every
  // indexed strip draw. RPCS3 reports when the stream contains that value; if
  // the guest did not enable restart, the draw cannot be reproduced exactly.
  if (indexed && topology.endsWith("-strip") && !primitiveRestart && (packet.flags & PacketFlag.indexRestartSentinel)) {
    throw new Error("RSX strip index stream contains the restart sentinel without primitive restart enabled");
  }
  const needsCpuVertices = vertexBackend === "cpu-oracle" || vertexDiagnostics;
  let input;
  let oracleOutput;
  if (needsCpuVertices) {
    if (primitiveRestart && vertexBackend === "cpu-oracle") throw new Error("the CPU vertex oracle cannot expand a primitive-restart index stream");
    const descriptors = readVertexDescriptors(packet);
    const { vertexBaseIndex, vertexIndexOffset } = vertexIndexing(packet);
    // Diagnostics only need the transformed vertices, so restart markers are dropped.
    const restartSentinel = packet.indexType === 0 ? 0xffffffff : 0xffff;
    const vertexOrder = drawVertexOrder(packet).filter((vertex) => !(primitiveRestart && vertex === restartSentinel));
    input = new Float32Array(vertexOrder.length * VertexOutputStrideFloats);
    oracleOutput = new Float32Array(vertexOrder.length * VertexOutputStrideFloats);
    for (let outputVertex = 0; outputVertex < vertexOrder.length; outputVertex += 1) {
      const vertex = vertexOrder[outputVertex];
      const inputs = new Map(Array.from({ length: 16 }, (_, index) => [index, vector(0, 1)]));
      for (const [index, descriptor] of descriptors) inputs.set(index, readAttribute(packet, descriptor, vertex, vertexBaseIndex, vertexIndexOffset));
      input.set(Array.from({ length: 16 }).flatMap((_, index) => inputs.get(index)), outputVertex * VertexOutputStrideFloats);
      const executed = executeVertexProgram(packet, inputs);
      const position = applyVertexEnvironment(packet, executed.destinations[0]);
      // RPCS3's Vulkan backend uses a positive-height viewport, whose framebuffer
      // Y mapping is the inverse of WebGPU's clip-space mapping.
      position[1] = -position[1];
      oracleOutput.set([
        ...position,
        ...VertexVaryingDestinations.flatMap((destination) => executed.destinations[destination]),
      ], outputVertex * VertexOutputStrideFloats);
    }
  }
  return {
    input,
    gpuInput: vertexBackend === "cpu-oracle" ? oracleOutput : undefined,
    oracleOutput,
    program,
    vertexCount: packet.drawCount,
    indexed,
    indexFormat,
    primitiveRestart,
    topology,
    vertexOpcodes: program.vertex.opcodes,
    scalarVertexOpcodes: program.vertex.scalarOpcodes,
    fragmentOpcodes: program.fragment.opcodes,
  };
}

// WGSL port of RPCS3's RSXVertexFetch.glsl (fetch_desc, fetch_attribute,
// read_location). The attribute descriptors and index base/offset are the
// 64-bit words fill_vertex_layout_state writes into the packet's vertex
// layout section; the streams are RPCS3's persistent/volatile uploads bound
// as byte arrays.
const RSX_VERTEX_FETCH_WGSL = `
fn rsxPersistentByte(index: u32) -> u32 {
  return (rsxPersistentStream[index >> 2u] >> ((index & 3u) * 8u)) & 0xffu;
}
fn rsxVolatileByte(index: u32) -> u32 {
  return (rsxVolatileStream[index >> 2u] >> ((index & 3u) * 8u)) & 0xffu;
}
fn rsxStreamByte(useVolatile: bool, index: u32) -> u32 {
  if (useVolatile) { return rsxVolatileByte(index); }
  return rsxPersistentByte(index);
}
fn rsxGenBits4(x: u32, y: u32, z: u32, w: u32, swap: bool) -> u32 {
  if (swap) { return insertBits(insertBits(insertBits(w, z, 8u, 8u), y, 16u, 8u), x, 24u, 8u); }
  return insertBits(insertBits(insertBits(x, y, 8u, 8u), z, 16u, 8u), w, 24u, 8u);
}
fn rsxGenBits2(x: u32, y: u32, swap: bool) -> u32 {
  if (swap) { return insertBits(y, x, 8u, 8u); }
  return insertBits(x, y, 8u, 8u);
}
fn rsxSext(bits: vec4i) -> vec4f {
  return vec4f(select(bits - vec4i(65536), bits, bits < vec4i(0x8000)));
}
fn rsxFetchAttribute(attribType: u32, attributeSize: u32, startingOffset: u32, stride: u32, swapBytes: bool, useVolatile: bool, vertexId: i32) -> vec4f {
  var elemSizeTable = array<i32, 8>(0, 2, 4, 2, 1, 2, 4, 1);
  var scalingTable = array<f32, 8>(1.0, 32767.5, 1.0, 1.0, 255.0, 1.0, 32767.0, 1.0);
  let elemSize = elemSizeTable[attribType];
  let scale = vec4f(scalingTable[attribType]);
  var result = vec4u(0u);
  var i = u32(vertexId * i32(stride) + i32(startingOffset));
  for (var n = 0u; n < attributeSize; n = n + 1u) {
    var tmp = vec4u(0u);
    tmp.x = rsxStreamByte(useVolatile, i); i = i + 1u;
    if (elemSize == 2) {
      tmp.y = rsxStreamByte(useVolatile, i); i = i + 1u;
      tmp.x = rsxGenBits2(tmp.x, tmp.y, swapBytes);
    } else if (elemSize == 4) {
      tmp.y = rsxStreamByte(useVolatile, i); i = i + 1u;
      tmp.z = rsxStreamByte(useVolatile, i); i = i + 1u;
      tmp.w = rsxStreamByte(useVolatile, i); i = i + 1u;
      tmp.x = rsxGenBits4(tmp.x, tmp.y, tmp.z, tmp.w, swapBytes);
    }
    result[n] = tmp.x;
  }
  var ret: vec4f;
  if (attribType == 1u || attribType == 5u) {
    ret = rsxSext(vec4i(result));
    ret = fma(vec4f(0.5), vec4f(select(0.0, 1.0, attribType == 1u)), ret);
  } else if (attribType == 2u) {
    ret = bitcast<vec4f>(result);
  } else if (attribType == 3u) {
    let a = insertBits(result.x, result.y, 16u, 16u);
    let b = insertBits(result.z, result.w, 16u, 16u);
    ret = vec4f(unpack2x16float(a), unpack2x16float(b));
  } else if (elemSize == 1) {
    ret = vec4f(result);
  } else {
    let packed = vec4u(extractBits(result.x, 0u, 11u), extractBits(result.x, 11u, 11u), extractBits(result.x, 22u, 10u), u32(scale.x));
    ret = rsxSext(vec4i(packed) << vec4u(5u, 5u, 6u, 0u));
  }
  if (attributeSize < 4u) { ret.w = scale.x; }
  return ret / scale;
}
fn rsxReadLocation(location: u32, vertexIndex: u32) -> vec4f {
  let wordIndex = 4u + location * 2u;
  let attrib = vec2u(rsxVertexState.attributeLayout[wordIndex >> 2u][wordIndex & 3u], rsxVertexState.attributeLayout[(wordIndex + 1u) >> 2u][(wordIndex + 1u) & 3u]);
  let stride = extractBits(attrib.x, 0u, 8u);
  let frequency = extractBits(attrib.x, 8u, 16u);
  let attribType = extractBits(attrib.x, 24u, 3u);
  let attributeSize = extractBits(attrib.x, 27u, 3u);
  let startingOffset = extractBits(attrib.y, 0u, 29u);
  let swapBytes = extractBits(attrib.y, 29u, 1u) != 0u;
  let useVolatile = extractBits(attrib.y, 30u, 1u) != 0u;
  let modulo = extractBits(attrib.y, 31u, 1u) != 0u;
  let vertexBaseIndex = rsxVertexState.attributeLayout[0].x;
  let vertexIndexOffset = rsxVertexState.attributeLayout[0].y;
  var vertexId: i32;
  if (frequency == 0u) {
    vertexId = 0;
  } else if (modulo) {
    vertexId = (i32(vertexIndex) + i32(vertexIndexOffset)) % i32(frequency);
  } else {
    vertexId = (i32(vertexIndex) - i32(vertexBaseIndex)) / i32(frequency);
  }
  return rsxFetchAttribute(attribType, attributeSize, startingOffset, stride, swapBytes, useVolatile, vertexId);
}
`;

// Translated programs are keyed by microcode content and the control words
// that change the generated WGSL, so a frame that reuses a program never
// re-translates it or rebuilds its shader module and bind group layout.
function programKey(packet, vertexBackend, textureSwizzles = new Map()) {
  return [
    vertexBackend,
    fnv1a32(packet.sections[SectionKind.vertexProgram].bytes),
    packet.vertexProgramEntry,
    packet.vertexProgramControl,
    packet.vertexProgramOutputMask,
    fnv1a32(packet.sections[SectionKind.fragmentProgram].bytes),
    packet.fragmentProgramControl,
    packet.textures.filter((texture) => texture.stage === 0).map((texture) => `${texture.slot}=${texture.dimension}${textureSwizzles.has(texture.slot) ? `/${textureSwizzles.get(texture.slot)}` : ""}`).join(","),
    (SURFACE_TARGET_INDICES[packet.colorTarget] ?? []).length,
    packet.resolvedState.alphaTestEnabled ? `a${packet.resolvedState.alphaFunc & 7}` : "a-",
  ].join(":");
}

function assembleShader(vertex, fragment, vertexBackend, colorTargetCount = 1, alphaFunc = undefined, textureSwizzles = new Map()) {
  const declarations = fragment.textureSlots.flatMap((slot) => [
    `@group(0) @binding(${slot * 2}) var rsxTexture${slot}: ${WGSL_TEXTURE_TYPES[fragment.textureDimensions.get(slot)]};`,
    `@group(0) @binding(${slot * 2 + 1}) var rsxSampler${slot}: sampler;`,
    textureSwizzleCode(slot, textureSwizzles.get(slot)),
  ]).join("\n");
  const vertexOutputFields = VertexVaryings.map((name, varying) => `@location(${varying}) ${name}: vec4f,`).join("\n");
  const fragmentDeclarations = `
    struct RSXFragmentState {
      environment: array<vec4f, 2>,
      constants: array<vec4f, ${FRAGMENT_CONSTANT_SLOTS}>,
    };
    @group(0) @binding(33) var<uniform> rsxFragmentState: RSXFragmentState;
  `;
  let vertexStage;
  if (vertexBackend === "webgpu-wgsl") {
    // Attributes are fetched from RPCS3's raw vertex streams in the shader.
    const attributeFields = Array.from({ length: 16 }, (_, attribute) => `attribute${attribute}: vec4f,`).join("\n");
    const fetches = vertex.inputs.map((attribute) => `input.attribute${attribute} = rsxReadLocation(${attribute}u, vertexIn.vertexIndex);`).join("\n");
    vertexStage = `
      struct RSXVertexState {
        environment: array<vec4f, 6>,
        constants: array<vec4f, 468>,
        attributeLayout: array<vec4u, ${VERTEX_LAYOUT_BYTES / 16}>,
      };
      @group(0) @binding(32) var<uniform> rsxVertexState: RSXVertexState;
      @group(0) @binding(34) var<storage, read> rsxPersistentStream: array<u32>;
      @group(0) @binding(35) var<storage, read> rsxVolatileStream: array<u32>;
      ${RSX_VERTEX_FETCH_WGSL}
      struct RSXVertexInputs {
        ${attributeFields}
      };
      struct VertexIn {
        @builtin(vertex_index) vertexIndex: u32,
      };
      @vertex fn vertex_main(vertexIn: VertexIn) -> VertexOut {
        var input: RSXVertexInputs;
        ${Array.from({ length: 16 }, (_, attribute) => `input.attribute${attribute} = vec4f(0.0, 0.0, 0.0, 1.0);`).join("\n")}
        ${fetches}
        var result: VertexOut;
        ${vertex.code}
        return result;
      }
    `;
  } else {
    // CPU oracle: the vertex program was executed in JavaScript; the stage
    // only forwards position and varyings.
    const vertexInputFields = ["@location(0) position: vec4f,", ...VertexVaryings.map((name, varying) => `@location(${varying + 1}) ${name}: vec4f,`)].join("\n");
    vertexStage = `
      struct VertexIn {
        ${vertexInputFields}
      };
      @vertex fn vertex_main(input: VertexIn) -> VertexOut {
        var result: VertexOut;
        result.position = input.position;
        ${VertexVaryings.map((name) => `result.${name} = input.${name};`).join("\n")}
        return result;
      }
    `;
  }
  return `
    ${declarations}
    ${fragmentDeclarations}
    struct VertexOut {
      @builtin(position) position: vec4f,
      ${vertexOutputFields}
    };
    ${vertexStage}
    ${fragmentSignature(fragment, colorTargetCount, alphaFunc)}
  `;
}

// RSX alpha test (RSXROPEpilogue.glsl): the fragment is discarded unless color 0's alpha
// passes alpha_func against alpha_ref (fragment environment word 3). Function codes are the
// low bits of CELL_GCM_NEVER..ALWAYS.
const ALPHA_COMPARISONS = ["false", "a < r", "a == r", "a <= r", "a > r", "a != r", "a >= r", "true"];
function alphaTestCode(value, alphaFunc) {
  if (alphaFunc === undefined) return "";
  return `{ let a = ${value}.w; let r = rsxFragmentState.environment[0].w; if (!(${ALPHA_COMPARISONS[alphaFunc]})) { discard; } }`;
}

// RSX writes color targets 1..3 from r2, r3, r4 (32-bit exports) or h4, h6, h8 (16-bit
// exports), as FragmentProgramDecompiler's ocol1..3; a single target keeps the plain return.
function fragmentSignature(fragment, colorTargetCount, alphaFunc) {
  const match = /return (r16|r32)\[0\];\s*$/.exec(fragment.code);
  if (!match) throw new Error("RSX fragment program has no color return");
  const file = match[1];
  const body = fragment.code.slice(0, match.index);
  const alphaTest = alphaTestCode(`${file}[0]`, alphaFunc);
  if (colorTargetCount <= 1) {
    return `@fragment fn fragment_main(input: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
      ${body}${alphaTest}
      return ${file}[0];
    }`;
  }
  const registers = file === "r32" ? [0, 2, 3, 4] : [0, 4, 6, 8];
  const fields = Array.from({ length: colorTargetCount }, (_, i) => `@location(${i}) color${i}: vec4f,`).join(" ");
  const values = Array.from({ length: colorTargetCount }, (_, i) => `${file}[${registers[i]}]`).join(", ");
  return `struct FragmentOut { ${fields} };
    @fragment fn fragment_main(input: VertexOut, @builtin(front_facing) frontFacing: bool) -> FragmentOut {
      ${body}${alphaTest}
      return FragmentOut(${values});
    }`;
}

// Differential check of the WGSL vertex fetch: a compute pass runs
// rsxReadLocation for every drawn vertex and location and returns the fetched
// attributes, which the caller compares against the CPU oracle (readAttribute).
export async function fetchAttributesOnGPU(prepared, packet) {
  const { device } = prepared;
  const indexed = Boolean(packet.flags & PacketFlag.indexed);
  const count = packet.drawCount;
  const code = `
    struct RSXVertexState {
      environment: array<vec4f, 6>,
      constants: array<vec4f, 468>,
      attributeLayout: array<vec4u, ${VERTEX_LAYOUT_BYTES / 16}>,
    };
    @group(0) @binding(32) var<uniform> rsxVertexState: RSXVertexState;
    @group(0) @binding(34) var<storage, read> rsxPersistentStream: array<u32>;
    @group(0) @binding(35) var<storage, read> rsxVolatileStream: array<u32>;
    @group(0) @binding(36) var<storage, read_write> output: array<vec4f>;
    @group(0) @binding(37) var<storage, read> indices: array<u32>;
    ${RSX_VERTEX_FETCH_WGSL}
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
      let vertex = id.x;
      if (vertex >= ${count}u) { return; }
      var vertexIndex = vertex;
      ${indexed ? (packet.indexType === 0
        ? "vertexIndex = indices[vertex];"
        : "vertexIndex = (indices[vertex >> 1u] >> ((vertex & 1u) * 16u)) & 0xffffu;") : ""}
      for (var location = 0u; location < 16u; location = location + 1u) {
        output[vertex * 16u + location] = rsxReadLocation(location, vertexIndex);
      }
    }
  `;
  const module = device.createShaderModule({ code });
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 32, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 34, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 35, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 36, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 37, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
  ] });
  const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: "main" } });
  const upload = (bytes, usage, minimum = 16) => {
    const size = Math.max(minimum, alignTo(bytes.byteLength, 4));
    const buffer = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    if (bytes.byteLength) writeSectionBytes(device, buffer, 0, bytes);
    return buffer;
  };
  const state = new Uint8Array(VERTEX_STATE_BYTES);
  state.set(packet.sections[SectionKind.vertexEnvironment].bytes, 0);
  state.set(packet.sections[SectionKind.vertexConstants].bytes, 96);
  state.set(packet.sections[SectionKind.vertexLayout].bytes, 96 + 468 * 16);
  const uniform = upload(state, GPUBufferUsage.UNIFORM);
  const persistent = upload(packet.sections[SectionKind.persistentVertices].bytes, GPUBufferUsage.STORAGE);
  const volatileBuffer = upload(packet.sections[SectionKind.volatileVertices].bytes, GPUBufferUsage.STORAGE);
  const indexBuffer = upload(packet.sections[SectionKind.indices].bytes, GPUBufferUsage.STORAGE);
  const outputSize = Math.max(16, count * 16 * 16);
  const output = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const bindGroup = device.createBindGroup({ layout, entries: [
    { binding: 32, resource: { buffer: uniform } },
    { binding: 34, resource: { buffer: persistent } },
    { binding: 35, resource: { buffer: volatileBuffer } },
    { binding: 36, resource: { buffer: output } },
    { binding: 37, resource: { buffer: indexBuffer } },
  ] });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readback.getMappedRange().slice(0, count * 16 * 16));
  readback.unmap();
  for (const buffer of [uniform, persistent, volatileBuffer, indexBuffer, output, readback]) buffer.destroy();
  return result;
}

// CPU oracle attributes for the same draw order and layout as fetchAttributesOnGPU.
export function fetchAttributesOnCPU(packet) {
  const descriptors = readVertexDescriptors(packet);
  const { vertexBaseIndex, vertexIndexOffset } = vertexIndexing(packet);
  const vertexOrder = drawVertexOrder(packet);
  const result = new Float32Array(vertexOrder.length * 64);
  vertexOrder.forEach((vertex, outputVertex) => {
    for (let location = 0; location < 16; location += 1) {
      const descriptor = descriptors.get(location);
      const value = descriptor ? readAttribute(packet, descriptor, vertex, vertexBaseIndex, vertexIndexOffset) : vector(0, 1);
      result.set(value, outputVertex * 64 + location * 4);
    }
  });
  return result;
}

// An RSX clear as a draw: full-screen triangle, the resolved clear color to
// the masked channels, the resolved depth through frag_depth, within the
// resolved scissor. Blending is off and depth always passes.
const CLEAR_WGSL = `
struct RSXClear { color: vec4f, depth: f32 };
@group(0) @binding(0) var<uniform> rsxClear: RSXClear;
struct ClearOut { @builtin(position) position: vec4f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> ClearOut {
  var out: ClearOut;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4f(x, y, 0.0, 1.0);
  return out;
}
struct ClearFragment { CLEAR_OUTPUTS CLEAR_DEPTH_FIELD };
@fragment fn fragment_main() -> ClearFragment {
  var out: ClearFragment;
  CLEAR_ASSIGNMENTS
  CLEAR_DEPTH_ASSIGN
  return out;
}
`;

// RPCS3's null texture for referenced-but-disabled samplers: a small
// zero-filled RGBA8 image with a plain sampler.
function getNullTexture(prepared, dimension = 1) {
  const cache = prepared.nullTextures ??= new Map();
  if (cache.has(dimension)) return cache.get(dimension);
  const { device } = prepared;
  const cube = dimension === 2;
  const texture = device.createTexture({
    label: `RPCS3 RSX null texture (${TEXTURE_VIEW_DIMENSIONS[dimension]})`,
    size: { width: 4, height: dimension === 0 ? 1 : 4, depthOrArrayLayers: cube ? 6 : 1 },
    dimension: dimension === 3 ? "3d" : dimension === 0 ? "1d" : "2d",
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const height = dimension === 0 ? 1 : 4;
  device.queue.writeTexture(
    { texture },
    new Uint8Array(4 * height * 4 * (cube ? 6 : 1)),
    { bytesPerRow: 16, rowsPerImage: height },
    { width: 4, height, depthOrArrayLayers: cube ? 6 : 1 },
  );
  const resource = {
    texture,
    view: texture.createView({ dimension: TEXTURE_VIEW_DIMENSIONS[dimension] }),
    sampler: device.createSampler({ magFilter: "nearest", minFilter: "nearest" }),
    byteSize: 64,
    diagnostics: { width: 4, height, nullTexture: true },
  };
  cache.set(dimension, resource);
  return resource;
}

// A clear covers every bound color target and the depth target of its framebuffer.
function getClearPipeline(prepared, targets, writeMask, depthWrite) {
  const cache = prepared.clearPipelineCache ??= new Map();
  const key = `${targets.formatKey}|${writeMask}|${depthWrite}`;
  let pipeline = cache.get(key);
  if (pipeline) return pipeline;
  const { device } = prepared;
  const count = Math.max(1, targets.colors.length);
  const modules = prepared.clearModules ??= new Map();
  const hasDepth = Boolean(targets.depth);
  const moduleKey = `${count}:${hasDepth ? "depth" : "color"}`;
  let module = modules.get(moduleKey);
  if (!module) {
    // A fragment stage may only export depth when the pipeline has a depth attachment
    const code = CLEAR_WGSL
      .replace("CLEAR_OUTPUTS", Array.from({ length: count }, (_, i) => `@location(${i}) color${i}: vec4f,`).join(" "))
      .replace("CLEAR_ASSIGNMENTS", Array.from({ length: count }, (_, i) => `out.color${i} = rsxClear.color;`).join("\n  "))
      .replace("CLEAR_DEPTH_FIELD", hasDepth ? "@builtin(frag_depth) depth: f32" : "")
      .replace("CLEAR_DEPTH_ASSIGN", hasDepth ? "out.depth = rsxClear.depth;" : "");
    module = device.createShaderModule({ label: `RPCS3 RSX clear (${moduleKey})`, code });
    modules.set(moduleKey, module);
  }
  prepared.clearBindGroupLayout ??= device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 32 } },
  ] });
  pipeline = device.createRenderPipeline({
    label: `RPCS3 RSX clear ${key}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [prepared.clearBindGroupLayout] }),
    vertex: { module, entryPoint: "vertex_main", buffers: [] },
    fragment: { module, entryPoint: "fragment_main", targets: targets.colors.map((surface) => ({ format: surface.format, writeMask })) },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: targets.depth ? { format: targets.depth.format, depthWriteEnabled: depthWrite, depthCompare: "always" } : undefined,
  });
  cache.set(key, pipeline);
  return pipeline;
}

function getClearBindGroup(prepared, uniformRing) {
  if (prepared.clearBindGroup?.generation === uniformRing.generation) return prepared.clearBindGroup.group;
  // Warm the clear shader for the common single-target framebuffer
  getClearPipeline(prepared, { formatKey: `${prepared.format}|depth24plus`, colors: [{ format: prepared.format }], depth: { format: "depth24plus" } }, 0, false);
  const group = prepared.device.createBindGroup({
    layout: prepared.clearBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformRing.buffer, offset: 0, size: 32 } }],
  });
  prepared.clearBindGroup = { generation: uniformRing.generation, group };
  return group;
}

function getProgram(prepared, packet, vertexBackend, aliasCandidates) {
  const cache = prepared.programCache ??= new Map();
  const textureSwizzles = surfaceTextureSwizzles(aliasCandidates, packet);
  const key = programKey(packet, vertexBackend, textureSwizzles);
  let program = cache.get(key);
  if (program) {
    cache.delete(key);
    cache.set(key, program);
    return program;
  }
  const vertex = compileVertexProgram(packet);
  const fragment = compileFragmentProgram(packet);
  const shaderCode = assembleShader(vertex, fragment, vertexBackend, (SURFACE_TARGET_INDICES[packet.colorTarget] ?? []).length,
    packet.resolvedState.alphaTestEnabled ? packet.resolvedState.alphaFunc & 7 : undefined, textureSwizzles);
  const { device } = prepared;
  const module = device.createShaderModule({ label: `RPCS3 translated RSX program ${key}`, code: shaderCode });
  const bindGroupLayout = device.createBindGroupLayout({
    label: `RPCS3 RSX bind group layout ${key}`,
    entries: [
      ...(vertexBackend === "webgpu-wgsl" ? [
        {
          binding: 32, visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: VERTEX_STATE_BYTES },
        },
        { binding: 34, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 35, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ] : []),
      {
        binding: 33, visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: FRAGMENT_STATE_BYTES },
      },
      ...fragment.textureSlots.flatMap((slot) => [
        { binding: slot * 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: TEXTURE_VIEW_DIMENSIONS[fragment.textureDimensions.get(slot)] } },
        { binding: slot * 2 + 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ]),
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  program = { key, vertex, fragment, shaderCode, module, bindGroupLayout, pipelineLayout };
  cache.set(key, program);
  if (cache.size > PROGRAM_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return program;
}

// queue.writeBuffer sizes must be multiples of 4; packet sections are
// contiguous and aligned, so the padding bytes normally exist in the packet.
function writeSectionBytes(device, buffer, offset, bytes) {
  if (bytes.byteLength === 0) return;
  const size = alignTo(bytes.byteLength, 4);
  if (bytes.byteOffset + size <= bytes.buffer.byteLength) {
    device.queue.writeBuffer(buffer, offset, bytes.buffer, bytes.byteOffset, size);
    return;
  }
  const padded = new Uint8Array(size);
  padded.set(bytes);
  device.queue.writeBuffer(buffer, offset, padded);
}

// A buffer that grows to the largest frame seen and is rewritten in place;
// queue.writeBuffer is ordered after previously submitted work, so reuse is
// safe without fences. generation changes when the buffer is replaced.
function ensureRing(prepared, name, usage, bytes) {
  const ring = prepared[name] ??= { buffer: undefined, size: 0, generation: 0 };
  if (ring.size < bytes) {
    ring.buffer?.destroy();
    ring.size = Math.max(bytes, ring.size * 2, 64 * 1024);
    ring.buffer = prepared.device.createBuffer({ label: `RPCS3 RSX ${name}`, size: ring.size, usage });
    ring.generation += 1;
  }
  return ring;
}

// RSX surface formats (rsx::surface_color_format, rsx::surface_depth_format2) as WebGPU
// formats, following the Vulkan backend's choices (VKFormats.cpp).
function surfaceColorFormat(rsxFormat) {
  switch (rsxFormat) {
    case 4: case 5: case 8: return "bgra8unorm";   // X8R8G8B8_*, A8R8G8B8
    case 14: case 15: case 16: return "rgba8unorm"; // X8B8G8R8_*, A8B8G8R8
    case 9: return "r8unorm";                       // B8
    case 10: return "rg8unorm";                     // G8B8
    case 11: return "rgba16float";                  // F_W16Z16Y16X16
    case 12: return "rgba32float";                  // F_W32Z32Y32X32
    case 13: return "r32float";                     // F_X32
    default: throw new Error(`RSX surface color format ${rsxFormat} is not yet translated`);
  }
}

function surfaceDepthFormat(rsxFormat) {
  switch (rsxFormat) {
    case 1: return "depth16unorm";   // Z16
    case 2: return "depth24plus";    // Z24S8 (stencil not yet translated)
    case 3: return "depth32float";   // Z16 float
    case 4: return "depth32float";   // Z24S8 float
    default: throw new Error(`RSX surface depth format ${rsxFormat} is not yet translated`);
  }
}

// GPU format an RSX texture format expects when it samples a render target directly
// (VK get_compatible_sampler_format); anything else needs RPCS3's format conversion.
function textureSurfaceFormat(baseFormat) {
  switch (baseFormat) {
    case 0x85: return "bgra8unorm";
    case 0x81: return "r8unorm";
    case 0x8b: return "rg8unorm";
    case 0x9a: return "rgba16float";
    case 0x9b: return "rgba32float";
    case 0x9c: return "r32float";
    default: return undefined;
  }
}

// Guest surfaces (render targets) live on the GPU, keyed by kind, address and format, and
// persist across frames like their guest memory; they are the texture cache's surface store.
// guestWidth/guestHeight are the RSX surface dimensions (texture lookups match on them);
// width/height are the backing size under the resolution scale (RPCS3's resolution_scale).
// Host image formats of rsx::webgpu::host_surface_format (WebGPURenderTargets.h). R5G6B5
// and A1R5G5B5 render as BGRA8, the way the Vulkan backend falls back without the packed formats.
const HOST_SURFACE_FORMATS = Object.freeze({
  1: "bgra8unorm", 2: "rgba8unorm", 3: "r8unorm", 4: "rg8unorm", 5: "rgba16float", 6: "rgba32float", 7: "r32float",
  8: "bgra8unorm", 9: "bgra8unorm", 0x101: "depth16unorm", 0x102: "depth24plus",
});

// RPCS3's surface store (rsx::surface_store, WebGPURenderTargets.h traits) owns every surface
// decision; the renderer only keeps the images it names by id. Structural ops keep the table
// current at the point of the packet stream they arrive in; erase/copy ops are encoded in
// packet order by the pass loop. Returns false for an op the pass loop must encode.
function applyStructuralSurfaceOp(prepared, op, retired, stats) {
  const table = prepared.surfaceTable ??= new Map();
  switch (op.kind) {
    case SurfaceOpKind.create: {
      if (table.has(op.id)) {
        // A restarted runtime numbers its surfaces from 1 again: the old image is retired
        retired.push(table.get(op.id));
        table.delete(op.id);
        stats.replaced = (stats.replaced ?? 0) + 1;
      }
      const kind = op.isDepth ? "depth" : "color";
      const format = HOST_SURFACE_FORMATS[op.hostFormat];
      if (!format) throw new Error(`RSX surface host format 0x${op.hostFormat.toString(16)} is not translated`);
      const texture = prepared.device.createTexture({
        label: `RPCS3 RSX ${kind} surface #${op.id} ${format}`,
        size: { width: op.imageWidth, height: op.imageHeight },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      table.set(op.id, {
        id: op.id, key: `${kind}:${op.id}`, diagKey: `${kind}:#${op.id}:${format}`, kind, format, hostFormat: op.hostFormat,
        width: op.imageWidth, height: op.imageHeight, texture, view: texture.createView(),
        regions: new Map(), scratch: undefined, scratchView: undefined,
        address: 0, pitch: 0, surfaceWidth: op.imageWidth, surfaceHeight: op.imageHeight, samplesX: 1, samplesY: 1, rsxFormat: 0,
      });
      stats.creates += 1;
      return true;
    }
    case SurfaceOpKind.describe: {
      const surface = table.get(op.id);
      if (!surface) { stats.missing += 1; (stats.missingByKind ??= {})[`describe:${op.id}`] = ((stats.missingByKind ??= {})[`describe:${op.id}`] ?? 0) + 1; return true; }
      Object.assign(surface, {
        address: op.address, pitch: op.pitch, surfaceWidth: op.surfaceWidth, surfaceHeight: op.surfaceHeight,
        samplesX: op.samplesX, samplesY: op.samplesY, rsxFormat: op.rsxFormat,
        diagKey: `${surface.kind}:${op.address.toString(16)}:${surface.format}#${op.id}`,
      });
      return true;
    }
    default:
      // destroy, erase, copy and load are ordered with the GPU work (a destroy after a copy
      // that reads the surface must not run before it)
      return false;
  }
}

// Metadata snapshot of the surfaces a draw can alias textures onto, taken at the draw's
// position in the packet stream (a later describe must not change an earlier draw's lookup).
function surfaceAliasCandidates(prepared) {
  return [...(prepared.surfaceTable?.values() ?? [])].map((surface) => ({
    live: surface, kind: surface.kind, format: surface.format, address: surface.address, pitch: surface.pitch,
    surfaceWidth: surface.surfaceWidth, surfaceHeight: surface.surfaceHeight, samplesX: surface.samplesX, samplesY: surface.samplesY,
    rsxFormat: surface.rsxFormat, width: surface.width, height: surface.height,
  }));
}

const RECT_BLIT_WGSL = `
struct BlitRect { source: vec4f };
@group(0) @binding(0) var blitTexture: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;
@group(0) @binding(2) var<uniform> blitRect: BlitRect;
struct BlitOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> BlitOut {
  var out: BlitOut;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}
@fragment fn fragment_main(input: BlitOut) -> @location(0) vec4f {
  return textureSample(blitTexture, blitSampler, mix(blitRect.source.xy, blitRect.source.zw, input.uv));
}
`;

const DEPTH_BLIT_WGSL = `
struct BlitRect { source: vec4f };
@group(0) @binding(0) var blitDepth: texture_depth_2d;
@group(0) @binding(2) var<uniform> blitRect: BlitRect;
struct BlitOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> BlitOut {
  var out: BlitOut;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}
@fragment fn fragment_main(input: BlitOut) -> @builtin(frag_depth) f32 {
  let texel = vec2i(floor(mix(blitRect.source.xy, blitRect.source.zw, input.uv)));
  return textureLoad(blitDepth, texel, 0);
}
`;

// vk::blitter::scale_image with nearest filtering: source rect of one surface into the
// destination rect of another. Color surfaces sample normalized coordinates; depth surfaces
// load the nearest texel and export it as fragment depth.
function getRectBlitPipeline(prepared, format, depth) {
  const cache = prepared.rectBlitPipelines ??= new Map();
  const key = `${depth ? "depth" : "color"}:${format}`;
  let pipeline = cache.get(key);
  if (pipeline) return pipeline;
  const { device } = prepared;
  if (depth) {
    prepared.depthBlitModule ??= device.createShaderModule({ label: "RPCS3 RSX surface depth blit", code: DEPTH_BLIT_WGSL });
    prepared.depthBlitBindGroupLayout ??= device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 16 } },
    ] });
    pipeline = device.createRenderPipeline({
      label: `RPCS3 RSX surface depth blit ${format}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [prepared.depthBlitBindGroupLayout] }),
      vertex: { module: prepared.depthBlitModule, entryPoint: "vertex_main", buffers: [] },
      fragment: { module: prepared.depthBlitModule, entryPoint: "fragment_main", targets: [] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format, depthWriteEnabled: true, depthCompare: "always" },
    });
  } else {
    prepared.rectBlitModule ??= device.createShaderModule({ label: "RPCS3 RSX surface blit", code: RECT_BLIT_WGSL });
    prepared.rectBlitBindGroupLayout ??= device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 16 } },
    ] });
    prepared.blitSampler ??= device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    pipeline = device.createRenderPipeline({
      label: `RPCS3 RSX surface blit ${format}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [prepared.rectBlitBindGroupLayout] }),
      vertex: { module: prepared.rectBlitModule, entryPoint: "vertex_main", buffers: [] },
      fragment: { module: prepared.rectBlitModule, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
  }
  cache.set(key, pipeline);
  return pipeline;
}

// Encodes an erase or copy op at its position in the frame (between render passes).
function encodeSurfaceOp(prepared, encoder, op, stats) {
  const table = prepared.surfaceTable ?? new Map();
  const { device } = prepared;
  if (op.kind === SurfaceOpKind.destroy) {
    const surface = table.get(op.id);
    if (surface) { table.delete(op.id); stats.retired.push(surface); }
    stats.destroys += 1;
    return;
  }
  if (op.kind === SurfaceOpKind.erase) {
    const surface = table.get(op.id);
    if (!surface) { stats.missing += 1; (stats.missingByKind ??= {})[`erase:${op.id}`] = ((stats.missingByKind ??= {})[`erase:${op.id}`] ?? 0) + 1; return; }
    // vk::render_target::clear_memory: color (0, 0, 0, 1), depth 1.0 (stencil 255)
    const pass = surface.kind === "color"
      ? encoder.beginRenderPass({ colorAttachments: [{ view: surface.view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] })
      : encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: surface.view, depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" } });
    pass.end();
    stats.erases += 1;
    return;
  }
  if (op.kind === SurfaceOpKind.copyScaled) {
    const source = table.get(op.srcId);
    const target = table.get(op.id);
    if (!source || !target) { stats.missing += 1; (stats.missingByKind ??= {})[`copy:${op.srcId}->${op.id}`] = ((stats.missingByKind ??= {})[`copy:${op.srcId}->${op.id}`] ?? 0) + 1; return; }
    if (op.rsxFormat === 1 || source.format !== target.format || source === target) {
      // Typeless (format-cast) transfers are not translated yet
      stats.unsupported += 1;
      return;
    }
    const clip = (v, max) => Math.max(0, Math.min(max, v));
    const sx1 = clip(op.srcX1, source.width), sy1 = clip(op.srcY1, source.height);
    const sx2 = clip(op.srcX2, source.width), sy2 = clip(op.srcY2, source.height);
    const dx1 = clip(op.dstX1, target.width), dy1 = clip(op.dstY1, target.height);
    const dx2 = clip(op.dstX2, target.width), dy2 = clip(op.dstY2, target.height);
    const sw = sx2 - sx1, sh = sy2 - sy1, dw = dx2 - dx1, dh = dy2 - dy1;
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) { stats.empty += 1; return; }
    if (sw === dw && sh === dh) {
      encoder.copyTextureToTexture(
        { texture: source.texture, origin: { x: sx1, y: sy1 } },
        { texture: target.texture, origin: { x: dx1, y: dy1 } },
        { width: dw, height: dh },
      );
      stats.copies += 1;
      return;
    }
    const depth = target.kind === "depth";
    const rect = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(rect, 0, new Float32Array(depth
      ? [sx1, sy1, sx2, sy2]
      : [sx1 / source.width, sy1 / source.height, sx2 / source.width, sy2 / source.height]));
    (prepared.frameScratchBuffers ??= []).push(rect);
    const pass = depth
      ? encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: target.view, depthLoadOp: "load", depthStoreOp: "store" } })
      : encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: "load", storeOp: "store" }] });
    pass.setPipeline(getRectBlitPipeline(prepared, target.format, depth));
    pass.setViewport(dx1, dy1, dw, dh, 0, 1);
    pass.setScissorRect(dx1, dy1, dw, dh);
    pass.setBindGroup(0, device.createBindGroup({
      layout: depth ? prepared.depthBlitBindGroupLayout : prepared.rectBlitBindGroupLayout,
      entries: depth
        ? [{ binding: 0, resource: source.view }, { binding: 2, resource: { buffer: rect } }]
        : [{ binding: 0, resource: source.view }, { binding: 1, resource: prepared.blitSampler }, { binding: 2, resource: { buffer: rect } }],
    }));
    pass.draw(3);
    pass.end();
    stats.scaledCopies += 1;
    return;
  }
  if (op.kind === SurfaceOpKind.loadMemory) {
    // read_color_buffers / read_depth_buffer: guest memory upload into a surface (not translated)
    stats.unsupported += 1;
    return;
  }
  throw new Error(`unknown RSX surface op ${op.kind}`);
}

// A texture that reads part of a surface: a row-aligned sub-rectangle (2D) or a stack of
// slices (3D volumes rendered into a tall 2D surface, as RPCS3's _3d_gather deferred
// request). The region is refreshed from the surface before every draw that samples it.
// A texture that reads part of a surface: a row-aligned sub-rectangle (2D) or a stack of
// slices (3D volumes rendered into a tall 2D surface, as RPCS3's _3d_gather deferred
// request). Rows and sizes are in guest samples (rsx::surface_metrics::samples); the copy is
// taken in image pixels, scaled like the surface's image. Refreshed before every draw that samples it.
function getSurfaceRegion(prepared, candidate, rowOffset, width, height, depth) {
  const surface = candidate.live;
  const key = `${rowOffset}:${width}x${height}x${depth}`;
  let region = surface.regions.get(key);
  const scaleX = candidate.width / candidate.surfaceWidth;
  const scaleY = candidate.height / candidate.surfaceHeight;
  const scaledWidth = Math.max(1, Math.round((width / candidate.samplesX) * scaleX));
  const scaledHeight = Math.max(1, Math.round((height / candidate.samplesY) * scaleY));
  const scaledRow = Math.round((rowOffset / candidate.samplesY) * scaleY);
  if (region && (region.scaledWidth !== scaledWidth || region.scaledHeight !== scaledHeight || region.texture.format !== surface.format)) {
    region.texture.destroy();
    surface.regions.delete(key);
    region = undefined;
  }
  if (!region) {
    const texture = prepared.device.createTexture({
      label: `RPCS3 RSX surface region ${surface.key} ${key}`,
      size: { width: scaledWidth, height: scaledHeight, depthOrArrayLayers: depth },
      dimension: depth > 1 ? "3d" : "2d",
      format: surface.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    region = { key, surface, rowOffset, width, height, depth, scaledWidth, scaledHeight, scaledRow, texture, view: texture.createView({ dimension: depth > 1 ? "3d" : "2d" }) };
    surface.regions.set(key, region);
  }
  region.scaledRow = scaledRow;
  return region;
}

// Scratch copy of a surface a draw samples while rendering to it (RPCS3 inserts a texture
// barrier there; WebGPU cannot bind an attachment of the current pass).
function getSurfaceScratch(prepared, surface) {
  if (!surface.scratch) {
    surface.scratch = prepared.device.createTexture({
      label: `RPCS3 RSX surface scratch ${surface.key}`,
      size: { width: surface.width, height: surface.height },
      format: surface.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    surface.scratchView = surface.scratch.createView();
  }
  return surface;
}

const SURFACE_TARGET_INDICES = { 0: [], 1: [0], 2: [1], 0x13: [0, 1], 0x17: [0, 1, 2], 0x1f: [0, 1, 2, 3] };

// Image size of an operation's attachments (the surfaces carry RPCS3's resolution scale)
function targetExtent(targets) {
  const reference = targets.colors[0] ?? targets.depth;
  return { width: reference?.width ?? 1, height: reference?.height ?? 1 };
}

// Attachments of a draw or clear: the color targets selected by surface_target and the depth
// target, all sized like RPCS3's framebuffer layout for that operation.
// Attachments of a draw or clear: the surfaces RPCS3's surface store bound for it, by id.
function operationTargets(prepared, packet) {
  const fb = packet.framebuffer;
  if (!fb) throw new Error("RSX packet has no framebuffer section");
  const indices = SURFACE_TARGET_INDICES[packet.colorTarget];
  if (!indices) throw new Error(`invalid RSX surface target 0x${packet.colorTarget.toString(16)}`);
  const table = prepared.surfaceTable ?? new Map();
  const colors = [];
  let missing = 0;
  // A target RPCS3's layout leaves unwritten (color_write_enabled false) or unaddressed has
  // no attachment, as in the native backends
  for (const index of indices) {
    if (fb.colorAddresses[index] === 0 || !((fb.colorWriteMask >>> index) & 1)) continue;
    const surface = table.get(fb.colorSurfaceIds[index]);
    if (surface) colors.push(surface); else missing += 1;
  }
  let depth;
  if (fb.zetaAddress) {
    depth = table.get(fb.zetaSurfaceId);
    if (!depth) missing += 1;
  }
  return {
    colors,
    depth,
    missing,
    // Attachment identity (pass boundaries) and attachment formats (pipeline compatibility)
    key: [...colors.map((surface) => surface.key), depth?.key ?? "-"].join("|"),
    formatKey: [...colors.map((surface) => surface.format), depth?.format ?? "-"].join("|"),
  };
}

// A texture lookup that hits a render target exactly (rsx::surface_store::get_surface_at with
// texture_cache_helpers::check_framebuffer_resource): same base address, a 2D single-level
// image of the surface's size, a format the surface can be sampled as, identity remap.
// (texture_cache::upload_texture surface path with check_framebuffer_resource): a 2D or 3D
// texture whose start lies on a row of a color surface with the same pitch and a format the
// surface can be sampled as; 3D volumes take depth slices of height rows each. Returns the
// surface plus the row offset; the caller binds the surface directly when it matches whole.
// Component map a colour surface is sampled through, in RSX ARGB order, from
// VKGSRender's get_compatible_surface_format: X8*_Z* forces alpha to 0, X8*_O* to 1,
// B8 broadcasts red with alpha 1, G8B8 reads {R,G,R,G}, F_X32 broadcasts red.
function surfaceNativeMap(rsxFormat) {
  switch (rsxFormat) {
    case 4: case 14: return ["0", "r", "g", "b"];
    case 5: case 15: return ["1", "r", "g", "b"];
    case 9: return ["1", "r", "r", "r"];
    case 10: return ["g", "r", "g", "r"];
    case 13: return ["r", "r", "r", "r"];
    default: return ["a", "r", "g", "b"];
  }
}

// vk::apply_swizzle_remap(native map, texture remap): the guest remap selects, per
// ARGB channel, a native component, zero or one; returned in RGBA order as a
// 4-character swizzle over the sampled vec4 ("rgba" = identity).
function surfaceTextureSwizzle(surface, descriptor) {
  const native = surfaceNativeMap(surface.rsxFormat);
  const remap = descriptor.remap & 0xffff;
  const control = descriptor.remap >>> 8;
  const argb = [0, 1, 2, 3].map((channel) => {
    const mode = (control >>> (channel * 2)) & 3;
    if (mode === 0) return "0";
    if (mode === 1) return "1";
    return native[(remap >>> (channel * 2)) & 3];
  });
  return `${argb[1]}${argb[2]}${argb[3]}${argb[0]}`;
}

function textureSwizzleCode(slot, swizzle = "rgba") {
  const component = (token) => token === "0" ? "0.0" : token === "1" ? "1.0" : `s.${token}`;
  const body = swizzle === "rgba" ? "s" : `vec4f(${[...swizzle].map(component).join(", ")})`;
  return `fn rsxTexel${slot}(s: vec4f) -> vec4f { return ${body}; }`;
}

// Per-slot swizzles of the textures this draw samples from render targets.
function surfaceTextureSwizzles(candidates, packet) {
  const swizzles = new Map();
  for (const descriptor of packet.textures) {
    if (descriptor.stage !== 0) continue;
    const hit = findSurfaceForTexture(candidates, descriptor);
    if (hit && hit.swizzle !== "rgba") swizzles.set(descriptor.slot, hit.swizzle);
  }
  return swizzles;
}

function findSurfaceForTexture(candidates, descriptor) {
  if (!candidates) return undefined;
  if (descriptor.dimension !== 1 && descriptor.dimension !== 3) return undefined;
  const expected = textureSurfaceFormat(descriptor.format & ~0x60);
  if (!expected) return undefined;
  const depth = descriptor.dimension === 3 ? Math.max(1, descriptor.depth) : 1;
  for (const candidate of candidates) {
    if (candidate.kind !== "color" || candidate.format !== expected || !candidate.pitch) continue;
    // texture_cache_helpers::check_framebuffer_resource compares in rsx::surface_metrics::samples
    const sampleWidth = candidate.surfaceWidth * candidate.samplesX;
    const sampleHeight = candidate.surfaceHeight * candidate.samplesY;
    const span = candidate.pitch * sampleHeight;
    if (descriptor.address < candidate.address || descriptor.address >= candidate.address + span) continue;
    const offset = descriptor.address - candidate.address;
    if (offset % candidate.pitch !== 0) continue;
    // rsx::pitch_compatible: a single-row texture matches any pitch, otherwise pitches must agree.
    if (descriptor.pitch && descriptor.height !== 1 && descriptor.pitch !== candidate.pitch) continue;
    const rowOffset = offset / candidate.pitch;
    if (descriptor.width > sampleWidth || rowOffset + descriptor.height * depth > sampleHeight) continue;
    const whole = rowOffset === 0 && depth === 1 && descriptor.width === sampleWidth && descriptor.height === sampleHeight;
    return { surface: candidate.live, candidate, rowOffset, depth, whole, swizzle: surfaceTextureSwizzle(candidate, descriptor) };
  }
  return undefined;
}

function findColorSurfaceAt(prepared, address) {
  if (!prepared.surfaceTable) return undefined;
  for (const surface of prepared.surfaceTable.values()) {
    if (surface.kind === "color" && surface.address === address) return surface;
  }
  return undefined;
}

function createRsxSampler(device, descriptor, mipCount) {
  const addressMode = (value) => value === 1 ? "repeat" : value === 2 ? "mirror-repeat" : "clamp-to-edge";
  const minFilter = descriptor.filterModes & 0xff;
  const magFilter = (descriptor.filterModes >>> 8) & 0xff;
  // CELL_GCM_TEXTURE_NEAREST/LINEAR sample the base level only; *_NEAREST_NEAREST/LINEAR_NEAREST
  // pick a level, *_NEAREST_LINEAR/LINEAR_LINEAR blend two levels.
  const mipmapped = minFilter >= 3 && minFilter <= 6;
  return device.createSampler({
    addressModeU: addressMode(descriptor.addressModes & 0xff),
    addressModeV: addressMode((descriptor.addressModes >>> 8) & 0xff),
    addressModeW: addressMode((descriptor.addressModes >>> 16) & 0xff),
    magFilter: magFilter === 1 ? "nearest" : "linear",
    minFilter: minFilter === 1 || minFilter === 3 || minFilter === 5 ? "nearest" : "linear",
    mipmapFilter: minFilter === 5 || minFilter === 6 ? "linear" : "nearest",
    lodMaxClamp: mipmapped ? mipCount - 1 : 0,
  });
}

const BLIT_WGSL = `
@group(0) @binding(0) var blitTexture: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;
struct BlitOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> BlitOut {
  var out: BlitOut;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}
@fragment fn fragment_main(input: BlitOut) -> @location(0) vec4f {
  return textureSample(blitTexture, blitSampler, input.uv);
}
`;

// Presents a surface into the frame target (the display scan-out); an exact copy at equal size.
function getBlitPipeline(prepared, format) {
  const cache = prepared.blitPipelines ??= new Map();
  let pipeline = cache.get(format);
  if (pipeline) return pipeline;
  const { device } = prepared;
  prepared.blitModule ??= device.createShaderModule({ label: "RPCS3 RSX present", code: BLIT_WGSL });
  prepared.blitBindGroupLayout ??= device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  ] });
  prepared.blitSampler ??= device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  pipeline = device.createRenderPipeline({
    label: `RPCS3 RSX present ${format}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [prepared.blitBindGroupLayout] }),
    vertex: { module: prepared.blitModule, entryPoint: "vertex_main", buffers: [] },
    fragment: { module: prepared.blitModule, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
  });
  cache.set(format, pipeline);
  return pipeline;
}

// The frame is rendered into an owned color/depth pair that persists across
// frames of the same size; presentation copies it into the canvas texture.
function ensureFrameTarget(prepared, width, height, format) {
  const current = prepared.frameTarget;
  if (current && current.width === width && current.height === height && current.format === format) return current;
  current?.color.destroy();
  current?.depth.destroy();
  const { device } = prepared;
  const color = device.createTexture({
    label: "RPCS3 RSX color target",
    size: { width, height },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  });
  const depth = device.createTexture({
    label: "RPCS3 RSX depth target",
    size: { width, height },
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return prepared.frameTarget = { width, height, format, color, depth, colorView: color.createView(), depthView: depth.createView() };
}

// Clear values come from RPCS3's clear_surface resolution (surface-format
// clear-color helpers, z_clear_value scaled by the depth format).
function clearValue(packet) {
  const state = packet.resolvedState;
  const [r, g, b, a] = state.clearColor;
  return {
    r, g, b, a,
    bytes: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(a * 255)],
    mask: state.clearMask,
    depth: state.clearMask & ClearMask.depth ? state.clearDepth : 1,
    stencil: state.clearMask & ClearMask.stencil ? state.clearStencil : 0,
  };
}

function depthState(packet) {
  const state = packet.resolvedState;
  const enabled = state.depthTestEnabled;
  const writeEnabled = state.depthWriteEnabled;
  const comparison = new Map([
    [0x200, "never"], [0x201, "less"], [0x202, "equal"], [0x203, "less-equal"],
    [0x204, "greater"], [0x205, "not-equal"], [0x206, "greater-equal"], [0x207, "always"],
  ]).get(state.depthFunc);
  if (!comparison) throw new Error(`unsupported RSX depth comparison 0x${state.depthFunc.toString(16)}`);
  // Like RPCS3's Vulkan backend: depth write is meaningless without depth test.
  return { enabled, writeEnabled: enabled && writeEnabled, comparison: enabled ? comparison : "always" };
}

function renderTargetState(packet) {
  const state = packet.resolvedState;
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
  // Draw buffer 0 only: multiple render targets are not part of the exercised
  // closure yet. Logic op and blend are mutually exclusive in RPCS3; logic op
  // wins, and WebGPU has no logic op, so such draws are rejected explicitly.
  if (state.logicOpEnabled) throw new Error(`RSX logic operation 0x${state.logicOperation.toString(16)} is not supported by WebGPU`);
  const blendEnabled = Boolean(state.blendEnabledMask & 1);
  const writeMasks = [0, 1, 2, 3].map((index) => {
    const mask = state.colorWriteMask[index];
    let writeMask = 0;
    if (mask & 1) writeMask |= GPUColorWrite.RED;
    if (mask & 2) writeMask |= GPUColorWrite.GREEN;
    if (mask & 4) writeMask |= GPUColorWrite.BLUE;
    if (mask & 8) writeMask |= GPUColorWrite.ALPHA;
    return writeMask;
  });
  const blend = blendEnabled ? {
    color: { srcFactor: factor(state.blendSfactorRgb), dstFactor: factor(state.blendDfactorRgb), operation: operation(state.blendEquationRgb) },
    alpha: { srcFactor: factor(state.blendSfactorA), dstFactor: factor(state.blendDfactorA), operation: operation(state.blendEquationA) },
  } : undefined;
  const [r, g, b, a] = state.blendColor;
  return {
    blend,
    blendEnabled,
    blendEnabledMask: state.blendEnabledMask,
    writeMask: writeMasks[0],
    writeMasks,
    blendConstant: { r, g, b, a },
  };
}

function rasterState(packet) {
  const state = packet.resolvedState;
  const frontFaceValue = state.frontFaceMode;
  const frontFace = new Map([[0x0900, "ccw"], [0x0901, "cw"]]).get(frontFaceValue);
  if (!frontFace) throw new Error(`unsupported RSX front-face mode 0x${frontFaceValue.toString(16)}`);
  const cullEnabled = state.cullFaceEnabled;
  const cullFaceValue = state.cullFaceMode;
  const cullMode = cullEnabled
    ? new Map([[0x0404, "front"], [0x0405, "back"]]).get(cullFaceValue)
    : "none";
  if (cullEnabled && !cullMode) {
    throw new Error(`unsupported RSX cull-face mode 0x${cullFaceValue.toString(16)}`);
  }
  return { frontFace, cullMode };
}

function scissorState(packet, canvas) {
  const bytes = packet.sections[SectionKind.rasterEnvironment].bytes;
  if (bytes.byteLength !== 16) throw new Error("RPCS3 raster-environment packet is missing scissor state");
  if (packet.width === 0 || packet.height === 0) throw new Error("RPCS3 draw packet has an empty framebuffer");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = {
    x: view.getUint32(0, true),
    y: view.getUint32(4, true),
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
  };
  // RPCS3's get_scissor already applies its resolution scale; clip to the attachment
  const x = Math.min(canvas.width, raw.x);
  const y = Math.min(canvas.height, raw.y);
  const x2 = Math.min(canvas.width, raw.x + raw.width);
  const y2 = Math.min(canvas.height, raw.y + raw.height);
  return { ...raw, scaled: { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) } };
}

export async function prepareWebGPU(canvas, options = {}) {
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
  const presentation = options.presentation !== false;
  const context = presentation ? canvas.getContext("webgpu") : undefined;
  if (presentation && !context) throw new Error("OffscreenCanvas WebGPU context is unavailable");
  const format = presentation ? navigator.gpu.getPreferredCanvasFormat() : (options.format ?? "rgba8unorm");
  context?.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
  return { canvas, adapter, device, context, format };
}

function deswizzle2D(bytes, width, height, bytesPerElement) {
  const log2Width = Math.ceil(Math.log2(width));
  const log2Height = Math.ceil(Math.log2(height));
  const limitMask = 2 ** (Math.min(log2Width, log2Height) * 2);
  const xMask = (0x55555555 | ~(limitMask - 1)) >>> 0;
  const yMask = (0xaaaaaaaa & (limitMask - 1)) >>> 0;
  const result = new Uint8Array(width * height * bytesPerElement);
  let offsetY = 0;
  let offsetX0 = 0;
  for (let y = 0; y < height; y += 1) {
    let offsetX = offsetX0;
    for (let x = 0; x < width; x += 1) {
      const source = (offsetY + offsetX) * bytesPerElement;
      result.set(bytes.subarray(source, source + bytesPerElement), (y * width + x) * bytesPerElement);
      offsetX = ((offsetX - xMask) & xMask) >>> 0;
    }
    offsetY = ((offsetY - yMask) & yMask) >>> 0;
    if (offsetY === 0) offsetX0 += limitMask;
  }
  return result;
}

function color565(value) {
  const r = (value >>> 11) & 31;
  const g = (value >>> 5) & 63;
  const b = value & 31;
  return [(r << 3) | (r >>> 2), (g << 2) | (g >>> 4), (b << 3) | (b >>> 2), 255];
}

function decodeBcColor(bytes, offset, forceFourColors) {
  const color0 = bytes[offset] | (bytes[offset + 1] << 8);
  const color1 = bytes[offset + 2] | (bytes[offset + 3] << 8);
  const colors = [color565(color0), color565(color1)];
  if (color0 > color1 || forceFourColors) {
    colors.push(colors[0].map((value, channel) => channel === 3 ? 255 : Math.floor((2 * value + colors[1][channel]) / 3)));
    colors.push(colors[0].map((value, channel) => channel === 3 ? 255 : Math.floor((value + 2 * colors[1][channel]) / 3)));
  } else {
    colors.push(colors[0].map((value, channel) => channel === 3 ? 255 : Math.floor((value + colors[1][channel]) / 2)));
    colors.push([0, 0, 0, 0]);
  }
  const indices = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
  return { colors, indices };
}

// Decodes one DXT subresource (RPCS3 never swizzles compressed formats) into RGBA8 rows.
function decodeBcSubresource(bytes, offset, sourcePitch, width, height, baseFormat, rgba, rgbaOffset, bytesPerRow) {
  const blockBytes = baseFormat === 0x86 ? 8 : 16;
  const blockWidth = Math.max(1, Math.ceil(width / 4));
  const blockHeight = Math.max(1, Math.ceil(height / 4));
  if (bytes.byteLength < offset + sourcePitch * (blockHeight - 1) + blockWidth * blockBytes) throw new Error("RPCS3 compressed texture payload is truncated");
  for (let blockY = 0; blockY < blockHeight; blockY += 1) {
    for (let blockX = 0; blockX < blockWidth; blockX += 1) {
      const block = offset + blockY * sourcePitch + blockX * blockBytes;
      const colorOffset = baseFormat === 0x86 ? block : block + 8;
      const { colors, indices } = decodeBcColor(bytes, colorOffset, baseFormat !== 0x86);
      let alphaBits = 0n;
      let alphaPalette;
      if (baseFormat === 0x88) {
        const alpha0 = bytes[block];
        const alpha1 = bytes[block + 1];
        alphaPalette = [alpha0, alpha1];
        const divisor = alpha0 > alpha1 ? 7 : 5;
        const interpolated = alpha0 > alpha1 ? 6 : 4;
        for (let index = 1; index <= interpolated; index += 1) {
          alphaPalette.push(Math.floor(((divisor - index) * alpha0 + index * alpha1) / divisor));
        }
        if (alpha0 <= alpha1) alphaPalette.push(0, 255);
        for (let byte = 0; byte < 6; byte += 1) alphaBits |= BigInt(bytes[block + 2 + byte]) << BigInt(byte * 8);
      }
      for (let pixel = 0; pixel < 16; pixel += 1) {
        const x = blockX * 4 + (pixel & 3);
        const y = blockY * 4 + (pixel >>> 2);
        if (x >= width || y >= height) continue;
        const color = colors[(indices >>> (pixel * 2)) & 3];
        const destination = rgbaOffset + y * bytesPerRow + x * 4;
        rgba.set(color, destination);
        if (baseFormat === 0x87) {
          rgba[destination + 3] = ((bytes[block + (pixel >>> 1)] >>> ((pixel & 1) * 4)) & 15) * 17;
        } else if (baseFormat === 0x88) {
          rgba[destination + 3] = alphaPalette[Number((alphaBits >> BigInt(pixel * 3)) & 7n)];
        }
      }
    }
  }
}

function nextPow2(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

// rsx::calculate_z_index: x, y and z bits interleaved while any dimension still has bits.
function swizzledIndex3D(x, y, z, log2Width, log2Height, log2Depth) {
  let offset = 0;
  let shift = 0;
  do {
    if (log2Width) { offset |= (x & 1) << shift; shift += 1; x >>>= 1; log2Width -= 1; }
    if (log2Height) { offset |= (y & 1) << shift; shift += 1; y >>>= 1; log2Height -= 1; }
    if (log2Depth) { offset |= (z & 1) << shift; shift += 1; z >>>= 1; log2Depth -= 1; }
  } while (x | y | z);
  return offset;
}

// rsx::convert_linear_swizzle_3d: a depth of 1 is the 2D swizzle.
function deswizzle3D(bytes, width, height, depth, bytesPerElement) {
  if (depth === 1) return deswizzle2D(bytes, width, height, bytesPerElement);
  const log2Width = Math.ceil(Math.log2(width));
  const log2Height = Math.ceil(Math.log2(height));
  const log2Depth = Math.ceil(Math.log2(depth));
  const result = new Uint8Array(width * height * depth * bytesPerElement);
  let destination = 0;
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const source = swizzledIndex3D(x, y, z, log2Width, log2Height, log2Depth) * bytesPerElement;
        result.set(bytes.subarray(source, source + bytesPerElement), destination);
        destination += bytesPerElement;
      }
    }
  }
  return result;
}

// Subresource layout of an RSX texture payload, mirroring rsx::get_subresources_layout_impl:
// layers (6 cube faces) of mip chains; linear rows use the register pitch and a 1-texel border,
// swizzled data is tightly packed (or padded to a power of two around a 4-texel border) and each
// layer starts 128-byte aligned.
function textureLayout(descriptor, baseFormat) {
  const compressed = baseFormat >= 0x86 && baseFormat <= 0x88;
  const blockEdge = compressed ? 4 : 1;
  const blockBytes = compressed ? (baseFormat === 0x86 ? 8 : 16) : baseFormat === 0x9a ? 8 : baseFormat === 0x85 || baseFormat === 0x9f ? 4 : baseFormat === 0x8b ? 2 : 1;
  const linear = Boolean(descriptor.format & 0x20);
  const hasBorder = descriptor.borderType === 0 && !compressed;
  const border = hasBorder ? (linear ? 1 : 4) : 0;
  const layers = descriptor.dimension === 2 ? 6 : 1;
  const height0 = descriptor.dimension === 0 ? 1 : descriptor.height;
  const depth0 = descriptor.dimension === 3 ? Math.max(1, descriptor.depth) : 1;
  const mips = Math.max(1, descriptor.mipCount);
  const subresources = [];
  let offset = 0;
  for (let layer = 0; layer < layers; layer += 1) {
    let width = descriptor.width;
    let height = height0;
    let depth = depth0;
    for (let level = 0; level < mips; level += 1) {
      const widthInBlock = Math.ceil(width / blockEdge);
      const heightInBlock = Math.ceil(height / blockEdge);
      let pitchInBlock;
      let fullHeightInBlock;
      if (linear) {
        pitchInBlock = Math.floor(descriptor.pitch / blockBytes);
        fullHeightInBlock = heightInBlock + border + border;
      } else if (!border) {
        pitchInBlock = widthInBlock;
        fullHeightInBlock = heightInBlock;
      } else {
        pitchInBlock = nextPow2(widthInBlock + border + border);
        fullHeightInBlock = nextPow2(heightInBlock + border + border);
      }
      const sliceBytes = pitchInBlock * blockBytes * fullHeightInBlock * depth;
      subresources.push({ layer, level, width, height, depth, widthInBlock, heightInBlock, pitchInBlock, fullHeightInBlock, offset, bytes: sliceBytes });
      offset += sliceBytes;
      width = Math.max(width >>> 1, 1);
      height = Math.max(height >>> 1, 1);
      depth = Math.max(depth >>> 1, 1);
    }
    if (!linear) offset = (offset + 127) & ~127;
  }
  // rsx::get_texture_size does not pad after the last layer
  const last = subresources[subresources.length - 1];
  return { compressed, blockBytes, linear, border, layers, mips, height0, depth0, subresources, totalBytes: last.offset + last.bytes };
}

// Converts one subresource to RGBA8 rows (bytesPerRow per row, height rows per depth slice).
function convertSubresource(descriptor, baseFormat, layout, subresource, rgba, bytesPerRow) {
  const { width, height, depth, widthInBlock, heightInBlock, pitchInBlock, fullHeightInBlock, offset } = subresource;
  const { blockBytes, linear, border } = layout;
  if (layout.compressed) {
    for (let z = 0; z < depth; z += 1) {
      decodeBcSubresource(descriptor.bytes, offset + z * pitchInBlock * blockBytes * fullHeightInBlock, pitchInBlock * blockBytes, width, height, baseFormat, rgba, z * bytesPerRow * height, bytesPerRow);
    }
    return;
  }
  if (descriptor.bytes.byteLength < offset + subresource.bytes) throw new Error("RPCS3 texture payload is truncated");
  // Source texels (bytesPerTexel each) with rowPitch texels per row and rowsPerSlice rows per slice
  let source;
  let rowPitch;
  let rowsPerSlice;
  if (linear) {
    source = descriptor.bytes.subarray(offset, offset + subresource.bytes);
    rowPitch = pitchInBlock;
    rowsPerSlice = fullHeightInBlock;
  } else {
    // copy_unmodified_block_swizzled: deswizzle the (padded) block, then skip the border
    const paddedWidth = border ? nextPow2(widthInBlock + border + border) : widthInBlock;
    const paddedHeight = border ? nextPow2(heightInBlock + border + border) : heightInBlock;
    source = deswizzle3D(descriptor.bytes.subarray(offset, offset + paddedWidth * paddedHeight * depth * blockBytes), paddedWidth, paddedHeight, depth, blockBytes);
    rowPitch = paddedWidth;
    rowsPerSlice = paddedHeight;
  }
  if (baseFormat === 0x9a || baseFormat === 0x9f) {
    // W16_Z16_Y16_X16_FLOAT / Y16_X16_FLOAT: big-endian half words copied into R16G16B16A16_SFLOAT /
    // R16G16_SFLOAT (word order preserved) and read through RPCS3's ARGB component mapping
    // {A,R,G,B} / {R,G,R,G} (vk::get_component_mapping); WebGPU has no view swizzle, so the
    // mapping and the guest remap are baked into an rgba16float image (exact for half floats).
    const words = new Uint16Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >>> 1);
    const remap = descriptor.remap & 0xffff;
    const remapControl = descriptor.remap >>> 8;
    const identity = remap === 0xaae4;
    for (let z = 0; z < depth; z += 1) {
      for (let y = 0; y < height; y += 1) {
        const sourceRow = ((z * rowsPerSlice + y + border) * rowPitch + border) * blockBytes;
        const destinationRow = ((z * height + y) * bytesPerRow) >>> 1;
        for (let x = 0; x < width; x += 1) {
          const o = sourceRow + x * blockBytes;
          const w0 = (source[o] << 8) | source[o + 1];
          const w1 = (source[o + 2] << 8) | source[o + 3];
          let argb;
          if (baseFormat === 0x9a) {
            const w2 = (source[o + 4] << 8) | source[o + 5];
            const w3 = (source[o + 6] << 8) | source[o + 7];
            argb = [w3, w0, w1, w2];
          } else {
            argb = [w0, w1, w0, w1];
          }
          let out = argb;
          if (!identity) {
            out = [0, 1, 2, 3].map((channel) => {
              const control = (remapControl >>> (channel * 2)) & 3;
              if (control === 0) return 0;
              if (control === 1) return 0x3c00;
              return argb[(remap >>> (channel * 2)) & 3];
            });
          }
          const destination = destinationRow + x * 4;
          words[destination] = out[1];
          words[destination + 1] = out[2];
          words[destination + 2] = out[3];
          words[destination + 3] = out[0];
        }
      }
    }
    return;
  }
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      const sourceRow = ((z * rowsPerSlice + y + border) * rowPitch + border) * blockBytes;
      const destinationRow = (z * height + y) * bytesPerRow;
      for (let x = 0; x < width; x += 1) {
        const sourceOffset = sourceRow + x * blockBytes;
        const destination = destinationRow + x * 4;
        if (baseFormat === 0x85) {
          rgba[destination] = source[sourceOffset + 1];
          rgba[destination + 1] = source[sourceOffset + 2];
          rgba[destination + 2] = source[sourceOffset + 3];
          rgba[destination + 3] = source[sourceOffset];
        } else if (baseFormat === 0x8b) {
          rgba[destination] = source[sourceOffset + 1];
          rgba[destination + 1] = source[sourceOffset];
          rgba[destination + 2] = source[sourceOffset + 1];
          rgba[destination + 3] = source[sourceOffset];
        } else {
          const value = source[sourceOffset];
          rgba[destination] = value;
          rgba[destination + 1] = value;
          rgba[destination + 2] = value;
          rgba[destination + 3] = 255;
        }
      }
    }
  }
}

function applyRemap(descriptor, rgba, bytesPerRow, width, rows) {
  if ((descriptor.remap & 0xffff) === 0xaae4) return;
  const remapControl = descriptor.remap >>> 8;
  const component = (argb, channel) => {
    const control = (remapControl >>> (channel * 2)) & 3;
    if (control === 0) return 0;
    if (control === 1) return 255;
    return argb[(descriptor.remap >>> (channel * 2)) & 3];
  };
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const destination = y * bytesPerRow + x * 4;
      const argb = [rgba[destination + 3], rgba[destination], rgba[destination + 1], rgba[destination + 2]];
      const remapped = [0, 1, 2, 3].map((channel) => component(argb, channel));
      rgba.set([remapped[1], remapped[2], remapped[3], remapped[0]], destination);
    }
  }
}

// Uploads an RSX fragment texture (1D, 2D, cube or 3D, every mip level) as RGBA8.
function uploadTexture(device, descriptor, withStatistics = false) {
  const baseFormat = descriptor.format & ~(0x20 | 0x40);
  const halfFloat = baseFormat === 0x9a || baseFormat === 0x9f;
  const bytesPerTexel = baseFormat === 0x85 ? 4 : baseFormat === 0x8b ? 2 : baseFormat === 0x81 ? 1 : baseFormat === 0x9a ? 8 : baseFormat === 0x9f ? 4 : 0;
  const compressed = baseFormat >= 0x86 && baseFormat <= 0x88;
  if (!bytesPerTexel && !compressed) {
    throw new Error(`current WebGPU texture closure requires B8, G8B8, A8R8G8B8, W16_Z16_Y16_X16_FLOAT, Y16_X16_FLOAT, or DXT data (format=0x${descriptor.format.toString(16)})`);
  }
  const gpuFormat = halfFloat ? "rgba16float" : "rgba8unorm";
  const outputBytesPerTexel = halfFloat ? 8 : 4;
  if (descriptor.dimension > 3) throw new Error(`invalid RSX texture dimension ${descriptor.dimension}`);
  const layout = textureLayout(descriptor, baseFormat);
  if (descriptor.dimension === 0 && layout.mips > 1) throw new Error("RSX 1D textures with mipmaps are not yet translated");
  if (descriptor.bytes.byteLength < layout.totalBytes) throw new Error(`RPCS3 texture payload is truncated (${descriptor.bytes.byteLength} of ${layout.totalBytes} bytes)`);
  const cube = descriptor.dimension === 2;
  const viewDimension = TEXTURE_VIEW_DIMENSIONS[descriptor.dimension];
  const texture = device.createTexture({
    label: `RPCS3 RSX texture ${descriptor.stage}:${descriptor.slot}`,
    size: { width: descriptor.width, height: layout.height0, depthOrArrayLayers: cube ? 6 : layout.depth0 },
    dimension: descriptor.dimension === 3 ? "3d" : descriptor.dimension === 0 ? "1d" : "2d",
    mipLevelCount: layout.mips,
    format: gpuFormat,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  let byteSize = 0;
  let base;
  for (const subresource of layout.subresources) {
    const bytesPerRow = Math.ceil((subresource.width * outputBytesPerTexel) / 256) * 256;
    const rgba = new Uint8Array(bytesPerRow * subresource.height * subresource.depth);
    convertSubresource(descriptor, baseFormat, layout, subresource, rgba, bytesPerRow);
    if (!halfFloat) applyRemap(descriptor, rgba, bytesPerRow, subresource.width, subresource.height * subresource.depth);
    device.queue.writeTexture(
      { texture, mipLevel: subresource.level, origin: { x: 0, y: 0, z: cube ? subresource.layer : 0 } },
      rgba,
      { bytesPerRow, rowsPerImage: subresource.height },
      { width: subresource.width, height: subresource.height, depthOrArrayLayers: cube ? 1 : subresource.depth },
    );
    byteSize += subresource.width * subresource.height * subresource.depth * outputBytesPerTexel;
    if (subresource.layer === 0 && subresource.level === 0) base = { rgba, bytesPerRow, width: subresource.width, height: subresource.height };
  }
  const addressMode = (value) => value === 1 ? "repeat" : value === 2 ? "mirror-repeat" : "clamp-to-edge";
  const minFilter = descriptor.filterModes & 0xff;
  const magFilter = (descriptor.filterModes >>> 8) & 0xff;
  // CELL_GCM_TEXTURE_NEAREST/LINEAR sample the base level only; *_NEAREST_NEAREST/LINEAR_NEAREST
  // pick a level, *_NEAREST_LINEAR/LINEAR_LINEAR blend two levels.
  const mipmapped = minFilter >= 3 && minFilter <= 6;
  const sampler = device.createSampler({
    addressModeU: addressMode(descriptor.addressModes & 0xff),
    addressModeV: addressMode((descriptor.addressModes >>> 8) & 0xff),
    addressModeW: addressMode((descriptor.addressModes >>> 16) & 0xff),
    magFilter: magFilter === 1 ? "nearest" : "linear",
    minFilter: minFilter === 1 || minFilter === 3 || minFilter === 5 ? "nearest" : "linear",
    mipmapFilter: minFilter === 5 || minFilter === 6 ? "linear" : "nearest",
    lodMaxClamp: mipmapped ? layout.mips - 1 : 0,
  });
  // Per-channel statistics are diagnostics for the acceptance specs, not
  // part of the upload.
  const channelMin = [255, 255, 255, 255];
  const channelMax = [0, 0, 0, 0];
  const channelSum = [0, 0, 0, 0];
  if (withStatistics && !halfFloat) {
    for (let y = 0; y < base.height; y += 1) {
      for (let x = 0; x < base.width; x += 1) {
        const destination = y * base.bytesPerRow + x * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          channelMin[channel] = Math.min(channelMin[channel], base.rgba[destination + channel]);
          channelMax[channel] = Math.max(channelMax[channel], base.rgba[destination + channel]);
          channelSum[channel] += base.rgba[destination + channel];
        }
      }
    }
  }
  return {
    texture,
    view: texture.createView({ dimension: viewDimension }),
    sampler,
    byteSize,
    diagnostics: {
      address: descriptor.address,
      width: descriptor.width,
      height: descriptor.height,
      depth: layout.depth0,
      layers: layout.layers,
      mipCount: layout.mips,
      dimension: descriptor.dimension,
      format: descriptor.format,
      channelMin,
      channelMax,
      channelMean: withStatistics ? channelSum.map((sum) => sum / (base.width * base.height)) : undefined,
    },
  };
}

function textureCacheKey(descriptor) {
  return [
    descriptor.address,
    descriptor.contentHash,
    descriptor.format,
    descriptor.width,
    descriptor.height,
    descriptor.depth,
    descriptor.pitch,
    descriptor.mipCount,
    descriptor.dimension,
    descriptor.remap,
    descriptor.addressModes,
    descriptor.filterModes,
    descriptor.borderType,
  ].join(":");
}

function drawDiagnostics(draw) {
  if (!draw.oracleOutput) return { vertexOracle: false };
  const result = {
    vertexOracle: true,
    attribute0Bounds: { min: [Infinity, Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity, -Infinity] },
    clipBounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    varyingBounds: Object.fromEntries(VertexVaryings.map((name) => [name, {
      min: [Infinity, Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity, -Infinity],
    }])),
  };
  for (let offset = 0; offset < draw.oracleOutput.length; offset += VertexOutputStrideFloats) {
    for (let component = 0; component < 4; component += 1) {
      const value = draw.input[offset + component];
      result.attribute0Bounds.min[component] = Math.min(result.attribute0Bounds.min[component], value);
      result.attribute0Bounds.max[component] = Math.max(result.attribute0Bounds.max[component], value);
    }
    const w = draw.oracleOutput[offset + 3];
    for (let component = 0; component < 3; component += 1) {
      const value = draw.oracleOutput[offset + component] / w;
      result.clipBounds.min[component] = Math.min(result.clipBounds.min[component], value);
      result.clipBounds.max[component] = Math.max(result.clipBounds.max[component], value);
    }
    for (let varying = 0; varying < VertexVaryings.length; varying += 1) {
      const bounds = result.varyingBounds[VertexVaryings[varying]];
      for (let component = 0; component < 4; component += 1) {
        const value = draw.oracleOutput[offset + (varying + 1) * 4 + component];
        bounds.min[component] = Math.min(bounds.min[component], value);
        bounds.max[component] = Math.max(bounds.max[component], value);
      }
    }
  }
  return result;
}

export async function renderPacketsToWebGPU(prepared, packets, options = {}) {
  const renderStartedAt = performance.now();
  // Validation failures invalidate the whole command buffer; report them instead of a silent black frame
  prepared.device.pushErrorScope("validation");
  stopWebGPUPresentation();
  const { canvas, adapter, device, context, format } = prepared;
  // Clears and draws execute in packet order against a render target that
  // persists across frames, as on the RSX: a clear is a scissored, masked
  // write of the resolved clear values, and a frame without a clear draws
  // over the previous contents.
  const operations = packets.filter((packet) => packet.kind === PacketKind.draw || packet.kind === PacketKind.clear);
  const drawPackets = operations.filter((packet) => packet.kind === PacketKind.draw);
  const clearPackets = operations.filter((packet) => packet.kind === PacketKind.clear);
  // Draws and clears address guest surfaces at their own size; the canvas only sees the
  // presented display buffer.
  // Resolution scale (RPCS3's resolution_scale): surfaces render at guest size times this
  // factor and are scaled only on presentation. Without an explicit option the canvas size
  // over the frame's size is used, which keeps the fragment cost at the canvas resolution.
  // RPCS3's surface store effects arrive with each packet (the ones a discarded packet carried
  // come first). Structural ops update the id table at their position in the stream; erase and
  // copy ops are encoded in order by the pass loop, before the operation they precede.
  const retiredSurfaces = [];
  const surfaceOpStats = { creates: 0, destroys: 0, erases: 0, copies: 0, scaledCopies: 0, empty: 0, missing: 0, unsupported: 0, retired: retiredSurfaces };
  const gpuOpsBefore = [];
  const aliasCandidatesByDraw = [];
  const operationTargetList = [];
  let gpuOpQueue = [];
  const applyOps = (ops) => {
    for (const op of ops) {
      if (!applyStructuralSurfaceOp(prepared, op, retiredSurfaces, surfaceOpStats)) gpuOpQueue.push(op);
    }
  };
  applyOps(options.carriedSurfaceOps ?? []);
  for (const packet of packets) {
    applyOps(packet.surfaceOps ?? []);
    if (packet.kind === PacketKind.draw || packet.kind === PacketKind.clear) {
      gpuOpsBefore.push(gpuOpQueue);
      gpuOpQueue = [];
      operationTargetList.push(operationTargets(prepared, packet));
      if (packet.kind === PacketKind.draw) aliasCandidatesByDraw.push(surfaceAliasCandidates(prepared));
    }
  }
  const trailingGpuOps = gpuOpQueue;
  const clearTargets = operationTargetList.filter((_, index) => operations[index].kind === PacketKind.clear);
  const drawTargets = operationTargetList.filter((_, index) => operations[index].kind === PacketKind.draw);
  const missingTargets = operationTargetList.reduce((sum, targets) => sum + targets.missing, 0);
  const clears = clearPackets.map((packet, index) => ({
    ...clearValue(packet),
    scissor: packet.sections[SectionKind.rasterEnvironment].bytes.byteLength === 16
      ? scissorState(packet, targetExtent(clearTargets[index]))
      : { scaled: { x: 0, y: 0, ...targetExtent(clearTargets[index]) } },
  }));
  // Reference clear values for the readback statistics (changed vs clear pixels).
  const clear = clears[0] ?? prepared.lastClear ?? { r: 0, g: 0, b: 0, a: 0, bytes: [0, 0, 0, 0], mask: 0, depth: 1, stencil: 0 };
  if (clears[0]) prepared.lastClear = clears[0];
  const vertexBackend = options.vertexBackend ?? "webgpu-wgsl";
  if (vertexBackend !== "webgpu-wgsl" && vertexBackend !== "cpu-oracle") {
    throw new Error(`unknown RSX vertex backend ${vertexBackend}`);
  }
  const vertexDiagnostics = options.vertexDiagnostics === true;
  const textureDiagnostics = vertexDiagnostics || options.textureDiagnostics === true;
  const programs = drawPackets.map((packet, index) => getProgram(prepared, packet, vertexBackend, aliasCandidatesByDraw[index]));
  const translated = drawPackets.map((packet, index) => translateDraw(packet, programs[index], vertexDiagnostics, vertexBackend));
  const depthStates = drawPackets.map(depthState);
  const targetStates = drawPackets.map(renderTargetState);
  const rasterStates = drawPackets.map(rasterState);
  const scissorStates = drawPackets.map((packet, index) => scissorState(packet, targetExtent(drawTargets[index])));
  const translatedAt = performance.now();

  const pipelineCache = prepared.pipelineCache ??= new Map();
  const bindGroupCache = prepared.bindGroupCache ??= new Map();
  const textureCache = prepared.textureCache ??= new Map();
  const textureCacheBudget = options.textureCacheBytes ?? 512 * 1024 * 1024;
  const frameTextureKeys = new Set();
  let pipelineCacheHits = 0;
  let pipelineCacheMisses = 0;
  let bindGroupCacheHits = 0;
  let bindGroupCacheMisses = 0;
  let textureCacheHits = 0;
  let textureEvictions = 0;
  let missingTexturePayloads = 0;
  let surfaceTextureHits = 0;
  let surfaceCyclicCopies = 0;
  let textureCacheMisses = 0;

  // One uniform ring for the frame (dynamic offsets per draw) and one vertex
  // ring; both persist across frames and grow to the largest frame seen.
  const drawCount = translated.length;
  const uniformStride = VERTEX_STATE_STRIDE + FRAGMENT_STATE_STRIDE;
  const clearBase = drawCount * uniformStride;
  const uniformRing = ensureRing(prepared, "uniformRing", GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, Math.max(UNIFORM_ALIGNMENT, clearBase + clears.length * UNIFORM_ALIGNMENT));
  const uniformBytes = new Uint8Array(Math.max(UNIFORM_ALIGNMENT, clearBase + clears.length * UNIFORM_ALIGNMENT));
  // Clear operations: color and depth values in a 256-byte slot each.
  const clearResources = clears.map((op, index) => {
    const view = new DataView(uniformBytes.buffer, clearBase + index * UNIFORM_ALIGNMENT, 32);
    view.setFloat32(0, op.r, true); view.setFloat32(4, op.g, true); view.setFloat32(8, op.b, true); view.setFloat32(12, op.a, true);
    view.setFloat32(16, op.depth, true);
    let writeMask = 0;
    if (op.mask & ClearMask.red) writeMask |= GPUColorWrite.RED;
    if (op.mask & ClearMask.green) writeMask |= GPUColorWrite.GREEN;
    if (op.mask & ClearMask.blue) writeMask |= GPUColorWrite.BLUE;
    if (op.mask & ClearMask.alpha) writeMask |= GPUColorWrite.ALPHA;
    const depthWrite = Boolean(op.mask & ClearMask.depth);
    return { pipeline: getClearPipeline(prepared, clearTargets[index], writeMask, depthWrite), offset: clearBase + index * UNIFORM_ALIGNMENT, scissor: op.scissor.scaled, writeMask, depthWrite };
  });
  const clearBindGroup = clears.length ? getClearBindGroup(prepared, uniformRing) : undefined;
  const vertexBytes = translated.reduce((sum, draw) => sum + (draw.gpuInput ? alignTo(draw.gpuInput.byteLength, UNIFORM_ALIGNMENT) : 0), 0);
  const vertexRing = ensureRing(prepared, "vertexRing", GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, Math.max(UNIFORM_ALIGNMENT, vertexBytes));
  let vertexRingOffset = 0;
  // RPCS3's raw vertex streams and index streams, bound as-is for the WGSL
  // fetch; every draw gets 256-aligned slots so bind groups can be cached
  // by offset and size.
  const streamSlot = (bytes) => Math.max(UNIFORM_ALIGNMENT, alignTo(bytes.byteLength, UNIFORM_ALIGNMENT));
  const streamBytes = drawPackets.reduce((sum, packet) =>
    sum + streamSlot(packet.sections[SectionKind.persistentVertices].bytes) + streamSlot(packet.sections[SectionKind.volatileVertices].bytes), 0);
  const streamRing = ensureRing(prepared, "streamRing", GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, Math.max(UNIFORM_ALIGNMENT, streamBytes));
  let streamRingOffset = 0;
  const indexBytes = drawPackets.reduce((sum, packet) => sum + streamSlot(packet.sections[SectionKind.indices].bytes), 0);
  const indexRing = ensureRing(prepared, "indexRing", GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, Math.max(UNIFORM_ALIGNMENT, indexBytes));
  let indexRingOffset = 0;

  const resources = translated.map((draw, index) => {
    const packet = drawPackets[index];
    const { program } = draw;
    const targets = drawTargets[index];
    const target = targetStates[index];
    const depth = depthStates[index];
    const raster = rasterStates[index];
    const blend = target.blend;
    const blendKey = blend
      ? [blend.color.srcFactor, blend.color.dstFactor, blend.color.operation, blend.alpha.srcFactor, blend.alpha.dstFactor, blend.alpha.operation].join(",")
      : "none";
    const stripIndexFormat = vertexBackend === "webgpu-wgsl" && draw.indexed && draw.topology.endsWith("-strip") ? draw.indexFormat : undefined;
    const pipelineKey = [program.key, targets.formatKey, draw.topology, stripIndexFormat ?? "-", raster.frontFace, raster.cullMode, depth.writeEnabled, depth.comparison, target.writeMask, blendKey].join("|");
    let pipeline = pipelineCache.get(pipelineKey);
    if (pipeline) {
      pipelineCacheHits += 1;
    } else {
      pipelineCacheMisses += 1;
      pipeline = device.createRenderPipeline({
        label: `RPCS3 RSX WebGPU pipeline ${pipelineKey}`,
        layout: program.pipelineLayout,
        vertex: {
          module: program.module,
          entryPoint: "vertex_main",
          buffers: vertexBackend === "webgpu-wgsl" ? [] : [{
            arrayStride: VertexOutputStrideFloats * 4,
            attributes: Array.from({ length: 16 }, (_, attribute) => ({
              shaderLocation: attribute,
              offset: attribute * 16,
              format: "float32x4",
            })),
          }],
        },
        fragment: {
          module: program.module,
          entryPoint: "fragment_main",
          targets: targets.colors.map((surface, i) => ({ format: surface.format, blend: (target.blendEnabledMask & (1 << i)) ? blend : undefined, writeMask: target.writeMasks[i] })),
        },
        primitive: { topology: draw.topology, frontFace: raster.frontFace, cullMode: raster.cullMode, stripIndexFormat },
        depthStencil: targets.depth ? { format: targets.depth.format, depthWriteEnabled: depth.writeEnabled, depthCompare: depth.comparison } : undefined,
      });
      pipelineCache.set(pipelineKey, pipeline);
      if (pipelineCache.size > PIPELINE_CACHE_LIMIT) pipelineCache.delete(pipelineCache.keys().next().value);
    }

    let vertexOffset = 0;
    let vertexSize = 0;
    let indexOffset = 0;
    let indexSize = 0;
    const streams = { persistent: { offset: 0, size: 0 }, volatile: { offset: 0, size: 0 } };
    if (draw.gpuInput) {
      vertexOffset = vertexRingOffset;
      vertexSize = draw.gpuInput.byteLength;
      vertexRingOffset += alignTo(vertexSize, UNIFORM_ALIGNMENT);
      device.queue.writeBuffer(vertexRing.buffer, vertexOffset, draw.gpuInput.buffer, draw.gpuInput.byteOffset, vertexSize);
    }
    if (vertexBackend === "webgpu-wgsl") {
      for (const [name, section] of [["persistent", SectionKind.persistentVertices], ["volatile", SectionKind.volatileVertices]]) {
        const bytes = packet.sections[section].bytes;
        streams[name] = { offset: streamRingOffset, size: streamSlot(bytes) };
        writeSectionBytes(device, streamRing.buffer, streamRingOffset, bytes);
        streamRingOffset += streams[name].size;
      }
      if (draw.indexed) {
        const bytes = packet.sections[SectionKind.indices].bytes;
        indexOffset = indexRingOffset;
        indexSize = bytes.byteLength;
        indexRingOffset += streamSlot(bytes);
        writeSectionBytes(device, indexRing.buffer, indexOffset, bytes);
      }
    }

    const uniformBase = index * uniformStride;
    const fragmentBase = uniformBase + VERTEX_STATE_STRIDE;
    if (vertexBackend === "webgpu-wgsl") {
      const environment = packet.sections[SectionKind.vertexEnvironment].bytes;
      const constants = packet.sections[SectionKind.vertexConstants].bytes;
      if (environment.byteLength !== 96 || constants.byteLength !== 468 * 16) {
        throw new Error("RPCS3 vertex-state packet has an invalid uniform layout");
      }
      const layout = packet.sections[SectionKind.vertexLayout].bytes;
      if (layout.byteLength !== VERTEX_LAYOUT_BYTES) throw new Error("RPCS3 vertex-layout packet has an invalid size");
      uniformBytes.set(environment, uniformBase);
      uniformBytes.set(constants, uniformBase + 96);
      uniformBytes.set(layout, uniformBase + 96 + constants.byteLength);
    }
    const fragmentEnvironment = packet.sections[SectionKind.fragmentEnvironment].bytes;
    if (fragmentEnvironment.byteLength !== 32) throw new Error("RPCS3 fragment environment is truncated");
    uniformBytes.set(fragmentEnvironment, fragmentBase);
    const fragmentConstants = packet.sections[SectionKind.fragmentConstants].bytes;
    if (fragmentConstants.byteLength !== program.fragment.constantCount * 16) {
      throw new Error(`RPCS3 fragment constants (${fragmentConstants.byteLength} bytes) do not match the program's ${program.fragment.constantCount} inline constants`);
    }
    uniformBytes.set(fragmentConstants, fragmentBase + 32);

    // The packet builder owns texture residency: it delivers a payload once and evicts through
    // stage-2 records, so both sides agree on what the cache holds without a return channel.
    for (const eviction of packet.textureEvictions ?? []) {
      const cacheKey = textureCacheKey(eviction);
      const resource = textureCache.get(cacheKey);
      if (!resource) continue;
      textureCache.delete(cacheKey);
      prepared.textureCacheBytes -= resource.byteSize;
      resource.texture.destroy();
      for (const key of [...bindGroupCache.keys()]) {
        if (key.includes(cacheKey)) bindGroupCache.delete(key);
      }
      textureEvictions += 1;
    }
    const textureResources = [];
    const cyclicCopies = [];
    if (program.fragment.textured) {
      for (const slot of program.fragment.textureSlots) {
        const descriptor = packet.textures.find((texture) => texture.stage === 0 && texture.slot === slot);
        if (!descriptor) {
          // A referenced sampler that the guest left disabled: RPCS3 binds its
          // zero-filled null image (vk::null_image_view), so samples read 0.
          textureResources.push({ slot, ...getNullTexture(prepared, program.fragment.textureDimensions.get(slot)), cacheKey: "null", cached: true });
          continue;
        }
        const hit = findSurfaceForTexture(aliasCandidatesByDraw[index], descriptor);
        if (hit) {
          // Sampling a render target. A whole match binds the surface; a target of this very
          // draw, a sub-rectangle or a slice stack is copied right before the draw (pass loop).
          const { surface, rowOffset, depth, whole } = hit;
          const cyclic = drawTargets[index].colors.includes(surface);
          const sampler = createRsxSampler(device, descriptor, 1);
          if (whole && !cyclic) {
            textureResources.push({ slot, texture: surface.texture, view: surface.view, sampler, cacheKey: `surface:${surface.key}`, cached: true, diagnostics: { surface: surface.key } });
          } else if (whole) {
            getSurfaceScratch(prepared, surface);
            cyclicCopies.push({ surface, region: undefined });
            textureResources.push({ slot, texture: surface.scratch, view: surface.scratchView, sampler, cacheKey: `surface-scratch:${surface.key}`, cached: true, diagnostics: { surface: surface.key, cyclic: true } });
          } else {
            const region = getSurfaceRegion(prepared, hit.candidate, rowOffset, descriptor.width, descriptor.height, depth);
            cyclicCopies.push({ surface, region });
            textureResources.push({ slot, texture: region.texture, view: region.view, sampler, cacheKey: `surface-region:${surface.key}:${region.key}`, cached: true, diagnostics: { surface: surface.key, region: region.key, cyclic } });
          }
          surfaceTextureHits += 1;
          continue;
        }
        const cacheKey = textureCacheKey(descriptor);
        let resource = textureCache.get(cacheKey);
        if (resource) {
          textureCache.delete(cacheKey);
          textureCache.set(cacheKey, resource);
          textureCacheHits += 1;
        } else if (descriptor.bytes.byteLength === 0) {
          // A reference to a texture the builder believes resident, whose payload never
          // arrived (its packet was dropped). Bind the null image and count it.
          missingTexturePayloads += 1;
          textureResources.push({ slot, ...getNullTexture(prepared, program.fragment.textureDimensions.get(slot)), cacheKey: "null", cached: true });
          continue;
        } else {
          resource = uploadTexture(device, descriptor, textureDiagnostics);
          textureCache.set(cacheKey, resource);
          prepared.textureCacheBytes = (prepared.textureCacheBytes ?? 0) + resource.byteSize;
          textureCacheMisses += 1;
        }
        frameTextureKeys.add(cacheKey);
        textureResources.push({ slot, ...resource, cacheKey, cached: true });
      }
    }

    const bindGroupKey = [
      program.key, uniformRing.generation, streamRing.generation,
      streams.persistent.offset, streams.persistent.size, streams.volatile.offset, streams.volatile.size,
      textureResources.map((resource) => resource.cacheKey).join(","),
    ].join("|");
    let bindGroup = bindGroupCache.get(bindGroupKey);
    if (bindGroup) {
      bindGroupCacheHits += 1;
    } else {
      bindGroupCacheMisses += 1;
      bindGroup = device.createBindGroup({
        layout: program.bindGroupLayout,
        entries: [
          ...(vertexBackend === "webgpu-wgsl" ? [
            { binding: 32, resource: { buffer: uniformRing.buffer, offset: 0, size: VERTEX_STATE_BYTES } },
            { binding: 34, resource: { buffer: streamRing.buffer, offset: streams.persistent.offset, size: streams.persistent.size } },
            { binding: 35, resource: { buffer: streamRing.buffer, offset: streams.volatile.offset, size: streams.volatile.size } },
          ] : []),
          { binding: 33, resource: { buffer: uniformRing.buffer, offset: 0, size: FRAGMENT_STATE_BYTES } },
          ...textureResources.flatMap((resource) => [
            { binding: resource.slot * 2, resource: resource.view },
            { binding: resource.slot * 2 + 1, resource: resource.sampler },
          ]),
        ],
      });
      bindGroupCache.set(bindGroupKey, bindGroup);
      if (bindGroupCache.size > BIND_GROUP_CACHE_LIMIT) bindGroupCache.delete(bindGroupCache.keys().next().value);
    }
    const dynamicOffsets = vertexBackend === "webgpu-wgsl" ? [uniformBase, fragmentBase] : [fragmentBase];
    return { pipeline, vertexOffset, vertexSize, indexOffset, indexSize, bindGroup, dynamicOffsets, textureResources, cyclicCopies, shaderCode: program.shaderCode };
  });
  device.queue.writeBuffer(uniformRing.buffer, 0, uniformBytes);
  const frameTarget = ensureFrameTarget(prepared, canvas.width, canvas.height, format);
  const resourcesReadyAt = performance.now();

  const encoder = device.createCommandEncoder({ label: "RPCS3 RSX packet frame" });
  // One render pass per run of operations sharing a framebuffer; surfaces load their
  // previous contents, as guest memory would.
  let pass = null;
  let passKey = null;
  let lastColorSurface = prepared.lastColorSurface;
  const beginPass = (targets) => {
    pass = encoder.beginRenderPass({
      colorAttachments: targets.colors.map((surface) => ({ view: surface.view, loadOp: "load", storeOp: "store" })),
      depthStencilAttachment: targets.depth ? { view: targets.depth.view, depthLoadOp: "load", depthStoreOp: "store" } : undefined,
    });
    passKey = targets.key;
    if (targets.colors.length) lastColorSurface = targets.colors[0];
  };
  const endPass = () => { if (pass) { pass.end(); pass = null; passKey = null; } };
  let drawIndex = 0;
  let clearIndex = 0;
  let operationIndex = 0;
  const clearLog = [];
  // Diagnosis aid: draws listed in options.skipDraws are translated but not encoded.
  const skipDraws = new Set(options.skipDraws ?? []);
  for (const operation of operations) {
    const targets = operationTargetList[operationIndex++];
    const precedingOps = gpuOpsBefore[operationIndex - 1];
    if (precedingOps.length) {
      endPass();
      for (const op of precedingOps) encodeSurfaceOp(prepared, encoder, op, surfaceOpStats);
    }
    // An operation whose surface the renderer never received (ops lost with a dropped packet) is skipped whole
    if (targets.missing) continue;
    if (operation.kind === PacketKind.clear) {
      const op = clearResources[clearIndex++];
      clearLog.push({ target: targets.key, scissor: op.scissor, writeMask: op.writeMask, depthWrite: op.depthWrite, colors: targets.colors.length, depth: Boolean(targets.depth) });
      if (op.scissor.width === 0 || op.scissor.height === 0 || (op.writeMask === 0 && !op.depthWrite)) continue;
      if (!targets.colors.length && !targets.depth) continue;
      if (passKey !== targets.key) { endPass(); beginPass(targets); }
      pass.setPipeline(op.pipeline);
      pass.setScissorRect(op.scissor.x, op.scissor.y, op.scissor.width, op.scissor.height);
      pass.setBindGroup(0, clearBindGroup, [op.offset]);
      pass.draw(3);
      continue;
    }
    const index = drawIndex++;
    if (skipDraws.has(index)) continue;
    const scissor = scissorStates[index].scaled;
    if (scissor.width === 0 || scissor.height === 0) continue;
    if (!targets.colors.length && !targets.depth) continue;
    const resource = resources[index];
    const draw = translated[index];
    if (resource.cyclicCopies.length) {
      endPass();
      for (const { surface, region } of resource.cyclicCopies) {
        if (!region) {
          encoder.copyTextureToTexture({ texture: surface.texture }, { texture: surface.scratch }, { width: surface.width, height: surface.height });
        } else {
          for (let slice = 0; slice < region.depth; slice += 1) {
            encoder.copyTextureToTexture(
              { texture: surface.texture, origin: { x: 0, y: region.scaledRow + slice * region.scaledHeight } },
              { texture: region.texture, origin: { x: 0, y: 0, z: slice } },
              { width: region.scaledWidth, height: region.scaledHeight, depthOrArrayLayers: 1 },
            );
          }
        }
        surfaceCyclicCopies += 1;
      }
    }
    if (passKey !== targets.key) { endPass(); beginPass(targets); }
    pass.setPipeline(resource.pipeline);
    pass.setScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
    if (targetStates[index].blendEnabled) pass.setBlendConstant(targetStates[index].blendConstant);
    pass.setBindGroup(0, resource.bindGroup, resource.dynamicOffsets);
    if (vertexBackend === "webgpu-wgsl") {
      if (draw.indexed) {
        pass.setIndexBuffer(indexRing.buffer, draw.indexFormat, resource.indexOffset, resource.indexSize);
        pass.drawIndexed(draw.vertexCount);
      } else {
        pass.draw(draw.vertexCount);
      }
    } else {
      pass.setVertexBuffer(0, vertexRing.buffer, resource.vertexOffset, resource.vertexSize);
      pass.draw(draw.vertexCount);
    }
  }
  endPass();
  // Present: the display buffer the guest flipped (or, without a flip, the last color target)
  // is blitted into the frame target, which the canvas and the readback see.
  for (const op of trailingGpuOps) encodeSurfaceOp(prepared, encoder, op, surfaceOpStats);
  const flipPacket = packets.find((packet) => packet.kind === PacketKind.flip);
  const presented = (flipPacket?.framebuffer && (prepared.surfaceTable?.get(flipPacket.framebuffer.displaySurfaceId)
    || findColorSurfaceAt(prepared, flipPacket.framebuffer.colorAddresses[0]))) || lastColorSurface;
  prepared.lastColorSurface = lastColorSurface;
  if (presented) {
    const blitPass = encoder.beginRenderPass({ colorAttachments: [{ view: frameTarget.colorView, loadOp: "load", storeOp: "store" }] });
    blitPass.setPipeline(getBlitPipeline(prepared, format));
    blitPass.setBindGroup(0, device.createBindGroup({ layout: prepared.blitBindGroupLayout, entries: [
      { binding: 0, resource: presented.view },
      { binding: 1, resource: prepared.blitSampler },
    ] }));
    blitPass.draw(3);
    blitPass.end();
  }
  const texture = frameTarget.color;
  if (context) {
    encoder.copyTextureToTexture({ texture }, { texture: context.getCurrentTexture() }, { width: canvas.width, height: canvas.height });
  }
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
  const validationError = await device.popErrorScope();
  if (validationError) console.error(`[rpcs3 webgpu] validation: ${validationError.message}`);
  // Images RPCS3's store retired this frame (and per-op scratch) are released after the submit that last used them
  for (const surface of retiredSurfaces) {
    surface.texture.destroy();
    surface.scratch?.destroy();
    surface.regions.forEach((region) => region.texture.destroy());
  }
  for (const buffer of prepared.frameScratchBuffers ?? []) buffer.destroy();
  prepared.frameScratchBuffers = [];
  if (prepared.lastColorSurface && retiredSurfaces.includes(prepared.lastColorSurface)) prepared.lastColorSurface = undefined;
  const submittedAt = performance.now();
  // A GPU sync is only needed to read the frame back; direct presentation
  // leaves the queue asynchronous.
  if (readback || options.gpuSync === true) await device.queue.onSubmittedWorkDone();
  const gpuSyncedAt = performance.now();
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
  // Diagnostics: every color surface as RGBA8 (blitted through the frame format), for
  // inspecting intermediate render targets of a frame.
  let surfaceDumps;
  if (options.dumpSurfaces && prepared.surfaceTable) {
    surfaceDumps = [];
    for (const surface of prepared.surfaceTable.values()) {
      if (surface.kind !== "color") continue;
      const dumpTexture = device.createTexture({ size: { width: surface.width, height: surface.height }, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const dumpEncoder = device.createCommandEncoder();
      const dumpPass = dumpEncoder.beginRenderPass({ colorAttachments: [{ view: dumpTexture.createView(), loadOp: "clear", storeOp: "store" }] });
      dumpPass.setPipeline(getBlitPipeline(prepared, format));
      dumpPass.setBindGroup(0, device.createBindGroup({ layout: prepared.blitBindGroupLayout, entries: [{ binding: 0, resource: surface.view }, { binding: 1, resource: prepared.blitSampler }] }));
      dumpPass.draw(3);
      dumpPass.end();
      const dumpRow = Math.ceil((surface.width * 4) / 256) * 256;
      const dumpBuffer = device.createBuffer({ size: dumpRow * surface.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      dumpEncoder.copyTextureToBuffer({ texture: dumpTexture }, { buffer: dumpBuffer, bytesPerRow: dumpRow, rowsPerImage: surface.height }, { width: surface.width, height: surface.height });
      device.queue.submit([dumpEncoder.finish()]);
      await dumpBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(dumpBuffer.getMappedRange());
      const out = new Uint8Array(surface.width * surface.height * 4);
      for (let y = 0; y < surface.height; y += 1) {
        for (let x = 0; x < surface.width; x += 1) {
          const o = y * dumpRow + x * 4;
          const d = (y * surface.width + x) * 4;
          out[d] = mapped[o + (bgra ? 2 : 0)]; out[d + 1] = mapped[o + 1]; out[d + 2] = mapped[o + (bgra ? 0 : 2)]; out[d + 3] = mapped[o + 3];
        }
      }
      dumpBuffer.unmap(); dumpBuffer.destroy(); dumpTexture.destroy();
      surfaceDumps.push({ key: surface.diagKey, width: surface.width, height: surface.height, rgbaBase64: base64(out) });
    }
  }
  // Residency is decided by the packet builder; this is only a guard against a protocol
  // failure (twice the builder's budget), never the normal eviction path.
  if ((prepared.textureCacheBytes ?? 0) > textureCacheBudget * 2) {
    for (const [cacheKey, resource] of textureCache) {
      if ((prepared.textureCacheBytes ?? 0) <= textureCacheBudget) break;
      if (frameTextureKeys.has(cacheKey)) continue;
      textureCache.delete(cacheKey);
      prepared.textureCacheBytes -= resource.byteSize;
      resource.texture.destroy();
      for (const key of [...bindGroupCache.keys()]) {
        if (key.includes(cacheKey)) bindGroupCache.delete(key);
      }
    }
  }

  if (context && options.replayPresentation !== false && typeof globalThis.requestAnimationFrame === "function") {
    // WebGPU canvas textures are not retained bitmaps. Keep copying the
    // rendered frame into the canvas until a newer frame replaces it. This is
    // presentation scheduling only: guest/RSX execution is neither delayed nor
    // paced by requestAnimationFrame, and no draw is re-encoded.
    const presentation = { cancelled: false, animationFrame: undefined };
    const present = () => {
      if (presentation.cancelled) return;
      presentation.animationFrame = globalThis.requestAnimationFrame(present);
      const current = prepared.frameTarget;
      const canvasTexture = context.getCurrentTexture();
      if (!current || canvasTexture.width !== current.width || canvasTexture.height !== current.height) return;
      const presentationEncoder = device.createCommandEncoder({ label: "RPCS3 RSX present" });
      presentationEncoder.copyTextureToTexture({ texture: current.color }, { texture: canvasTexture }, { width: current.width, height: current.height });
      device.queue.submit([presentationEncoder.finish()]);
    };
    activePresentation = presentation;
    presentation.animationFrame = globalThis.requestAnimationFrame(present);
  }
  const info = adapter.info ?? {};
  return {
    presented: true,
    surface: context ? "canvas" : "texture",
    format,
    adapter: [info.vendor, info.architecture, info.device, info.description, info.backend, info.type].filter(Boolean).join(" · "),
    width: canvas.width,
    height: canvas.height,
    draws: translated.length,
    vertices: translated.reduce((sum, draw) => sum + draw.vertexCount, 0),
    vertexBackend,
    vertexOpcodes: [...new Set(translated.flatMap((draw) => draw.vertexOpcodes))].sort((a, b) => a - b),
    scalarVertexOpcodes: [...new Set(translated.flatMap((draw) => draw.scalarVertexOpcodes))].sort((a, b) => a - b),
    fragmentOpcodes: [...new Set(translated.flatMap((draw) => draw.fragmentOpcodes))].sort((a, b) => a - b),
    shaderPrograms: options.captureShaders ? [...new Set(resources.map(({ shaderCode }) => shaderCode))] : undefined,
    depthStates,
    rasterStates,
    scissorStates,
    targetStates,
    drawDiagnostics: translated.map((draw, index) => ({
      ...drawDiagnostics(draw),
      target: drawTargets[index].key,
      scissor: scissorStates[index].scaled,
      blend: targetStates[index].blendEnabled,
      depthWrite: depthStates[index].writeEnabled,
      fragmentOpcodes: draw.fragmentOpcodes,
      shaderCode: options.captureShaders ? resources[index].shaderCode : undefined,
      texture: resources[index].textureResources[0]?.diagnostics,
      textures: resources[index].textureResources.map(({ slot, diagnostics }) => ({ slot, ...diagnostics })),
    })),
    changedPixels,
    clearPixels,
    frameHash,
    changedBounds: !pixels || changedMaxX < 0 ? null : { minX: changedMinX, minY: changedMinY, maxX: changedMaxX, maxY: changedMaxY },
    validationError: validationError?.message,
    timings: {
      translateMs: translatedAt - renderStartedAt,
      resourceAndPipelineMs: resourcesReadyAt - translatedAt,
      encodeSubmitMs: submittedAt - resourcesReadyAt,
      gpuSyncMs: gpuSyncedAt - submittedAt,
      readbackMapMs: readbackReadyAt - gpuSyncedAt,
      submitAndMappedReadbackMs: readbackReadyAt - resourcesReadyAt,
      readbackScanMs: readbackScannedAt - readbackReadyAt,
      totalMs: readbackScannedAt - renderStartedAt,
    },
    pipelineCache: { hits: pipelineCacheHits, misses: pipelineCacheMisses, size: pipelineCache.size },
    programCache: { size: prepared.programCache?.size ?? 0 },
    bindGroupCache: { hits: bindGroupCacheHits, misses: bindGroupCacheMisses, size: bindGroupCache.size },
    textureCache: {
      hits: textureCacheHits,
      misses: textureCacheMisses,
      size: textureCache.size,
      bytes: prepared.textureCacheBytes ?? 0,
      budget: textureCacheBudget,
      evictions: textureEvictions,
      missingPayloads: missingTexturePayloads,
    },
    surfaces: {
      list: [...(prepared.surfaceTable?.values() ?? [])].map((surface) => ({
        id: surface.id, key: surface.diagKey, pitch: surface.pitch, rsxFormat: surface.rsxFormat,
        surfaceWidth: surface.surfaceWidth, surfaceHeight: surface.surfaceHeight, samples: [surface.samplesX, surface.samplesY],
        width: surface.width, height: surface.height,
      })),
      count: prepared.surfaceTable?.size ?? 0,
      ops: surfaceOpStats,
      missingTargets,
      retired: retiredSurfaces.length,
      clearLog,
      textureHits: surfaceTextureHits,
      cyclicCopies: surfaceCyclicCopies,
      presented: presented?.key,
    },
    uniformRingBytes: uniformRing.size,
    vertexRingBytes: vertexRing.size,
    streamRingBytes: streamRing.size,
    indexRingBytes: indexRing.size,
    rgbaBase64: rgba ? base64(rgba) : undefined,
    surfaceDumps,
  };
}
