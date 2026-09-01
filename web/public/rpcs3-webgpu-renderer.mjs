import { ClearMask, PacketFlag, PacketKind, SectionKind, fnv1a32 } from "./rpcs3-webgpu-packet.mjs";

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
  prepared.bindGroupCache = undefined;
  prepared.pipelineCache = undefined;
  prepared.programCache = undefined;
  prepared.clearPipelineCache = undefined;
  prepared.clearBindGroup = undefined;
  prepared.lastClear = undefined;
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
  return columns.map((column) => position.reduce((sum, component, index) => sum + component * column[index], 0));
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

// Compile the RSX fragment instruction stream into WGSL using the same bit
// fields and execution rules as RPCS3's existing GLSL fragment interpreter.
// The closure is intentionally strict: unsupported instructions fail instead
// of silently manufacturing a plausible frame.
function compileFragmentProgram(packet) {
  const bytes = packet.sections[SectionKind.fragmentProgram].bytes;
  if (bytes.byteLength < 16 || bytes.byteLength % 16 !== 0) throw new Error("invalid RSX fragment program");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines = ["var r16: array<vec4f, 48>;", "var r32: array<vec4f, 48>;", "var cc: array<vec4f, 2>;"];
  const opcodes = [];
  const textureSlots = new Set();
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
      [0x10, 1], [0x11, 1], [0x15, 1], [0x16, 1], [0x17, 1],
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
    else if (opcode === 0x17) {
      const textureSlot = bits(words[0], 17, 4);
      value = `textureSample(rsxTexture${textureSlot}, rsxSampler${textureSlot}, ${sources[0]}.xy)`;
      textureSlots.add(textureSlot);
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
  lines.push(`return ${(packet.fragmentProgramControl & 0x40) !== 0 ? "r32" : "r16"}[0];`);
  if (constantIndex > FRAGMENT_CONSTANT_SLOTS) throw new Error(`RSX fragment program uses ${constantIndex} inline constants; the uniform holds ${FRAGMENT_CONSTANT_SLOTS}`);
  return {
    code: lines.join("\n"),
    textured: textureSlots.size > 0,
    textureSlots: [...textureSlots].sort((a, b) => a - b),
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
    if (primitiveRestart) throw new Error("the CPU vertex oracle cannot expand a primitive-restart index stream");
    const descriptors = readVertexDescriptors(packet);
    const { vertexBaseIndex, vertexIndexOffset } = vertexIndexing(packet);
    const vertexOrder = drawVertexOrder(packet);
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
  if (program.fragment.textured && packet.textures.length === 0) throw new Error("RSX fragment program samples a texture without a payload");
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
function programKey(packet, vertexBackend) {
  return [
    vertexBackend,
    fnv1a32(packet.sections[SectionKind.vertexProgram].bytes),
    packet.vertexProgramEntry,
    packet.vertexProgramControl,
    packet.vertexProgramOutputMask,
    fnv1a32(packet.sections[SectionKind.fragmentProgram].bytes),
    packet.fragmentProgramControl,
  ].join(":");
}

function assembleShader(vertex, fragment, vertexBackend) {
  const declarations = fragment.textureSlots.flatMap((slot) => [
    `@group(0) @binding(${slot * 2}) var rsxTexture${slot}: texture_2d<f32>;`,
    `@group(0) @binding(${slot * 2 + 1}) var rsxSampler${slot}: sampler;`,
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
    @fragment fn fragment_main(input: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
      ${fragment.code}
    }
  `;
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
struct ClearFragment { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };
@fragment fn fragment_main() -> ClearFragment {
  var out: ClearFragment;
  out.color = rsxClear.color;
  out.depth = rsxClear.depth;
  return out;
}
`;

function getClearPipeline(prepared, format, writeMask, depthWrite) {
  const cache = prepared.clearPipelineCache ??= new Map();
  const key = `${format}|${writeMask}|${depthWrite}`;
  let pipeline = cache.get(key);
  if (pipeline) return pipeline;
  const { device } = prepared;
  prepared.clearModule ??= device.createShaderModule({ label: "RPCS3 RSX clear", code: CLEAR_WGSL });
  prepared.clearBindGroupLayout ??= device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 32 } },
  ] });
  pipeline = device.createRenderPipeline({
    label: `RPCS3 RSX clear ${key}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [prepared.clearBindGroupLayout] }),
    vertex: { module: prepared.clearModule, entryPoint: "vertex_main", buffers: [] },
    fragment: { module: prepared.clearModule, entryPoint: "fragment_main", targets: [{ format, writeMask }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: depthWrite, depthCompare: "always" },
  });
  cache.set(key, pipeline);
  return pipeline;
}

function getClearBindGroup(prepared, uniformRing) {
  if (prepared.clearBindGroup?.generation === uniformRing.generation) return prepared.clearBindGroup.group;
  getClearPipeline(prepared, prepared.format, 0, false);
  const group = prepared.device.createBindGroup({
    layout: prepared.clearBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformRing.buffer, offset: 0, size: 32 } }],
  });
  prepared.clearBindGroup = { generation: uniformRing.generation, group };
  return group;
}

function getProgram(prepared, packet, vertexBackend) {
  const cache = prepared.programCache ??= new Map();
  const key = programKey(packet, vertexBackend);
  let program = cache.get(key);
  if (program) {
    cache.delete(key);
    cache.set(key, program);
    return program;
  }
  const vertex = compileVertexProgram(packet);
  const fragment = compileFragmentProgram(packet);
  const shaderCode = assembleShader(vertex, fragment, vertexBackend);
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
        { binding: slot * 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
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
  const mask = state.colorWriteMask[0];
  let writeMask = 0;
  if (mask & 1) writeMask |= GPUColorWrite.RED;
  if (mask & 2) writeMask |= GPUColorWrite.GREEN;
  if (mask & 4) writeMask |= GPUColorWrite.BLUE;
  if (mask & 8) writeMask |= GPUColorWrite.ALPHA;
  const blend = blendEnabled ? {
    color: { srcFactor: factor(state.blendSfactorRgb), dstFactor: factor(state.blendDfactorRgb), operation: operation(state.blendEquationRgb) },
    alpha: { srcFactor: factor(state.blendSfactorA), dstFactor: factor(state.blendDfactorA), operation: operation(state.blendEquationA) },
  } : undefined;
  const [r, g, b, a] = state.blendColor;
  return {
    blend,
    blendEnabled,
    writeMask,
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
  const x = Math.min(canvas.width, Math.floor(raw.x * canvas.width / packet.width));
  const y = Math.min(canvas.height, Math.floor(raw.y * canvas.height / packet.height));
  const x2 = Math.min(canvas.width, Math.floor((raw.x + raw.width) * canvas.width / packet.width));
  const y2 = Math.min(canvas.height, Math.floor((raw.y + raw.height) * canvas.height / packet.height));
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

function decodeBcTexture(descriptor, baseFormat, rgba, bytesPerRow) {
  const blockBytes = baseFormat === 0x86 ? 8 : 16;
  const blockWidth = Math.max(1, Math.ceil(descriptor.width / 4));
  const blockHeight = Math.max(1, Math.ceil(descriptor.height / 4));
  const sourcePitch = descriptor.pitch || blockWidth * blockBytes;
  if (descriptor.bytes.byteLength < sourcePitch * blockHeight) throw new Error("RPCS3 compressed texture payload is truncated");
  for (let blockY = 0; blockY < blockHeight; blockY += 1) {
    for (let blockX = 0; blockX < blockWidth; blockX += 1) {
      const block = blockY * sourcePitch + blockX * blockBytes;
      const colorOffset = baseFormat === 0x86 ? block : block + 8;
      const { colors, indices } = decodeBcColor(descriptor.bytes, colorOffset, baseFormat !== 0x86);
      let alphaBits = 0n;
      let alphaPalette;
      if (baseFormat === 0x88) {
        const alpha0 = descriptor.bytes[block];
        const alpha1 = descriptor.bytes[block + 1];
        alphaPalette = [alpha0, alpha1];
        const divisor = alpha0 > alpha1 ? 7 : 5;
        const interpolated = alpha0 > alpha1 ? 6 : 4;
        for (let index = 1; index <= interpolated; index += 1) {
          alphaPalette.push(Math.floor(((divisor - index) * alpha0 + index * alpha1) / divisor));
        }
        if (alpha0 <= alpha1) alphaPalette.push(0, 255);
        for (let byte = 0; byte < 6; byte += 1) alphaBits |= BigInt(descriptor.bytes[block + 2 + byte]) << BigInt(byte * 8);
      }
      for (let pixel = 0; pixel < 16; pixel += 1) {
        const x = blockX * 4 + (pixel & 3);
        const y = blockY * 4 + (pixel >>> 2);
        if (x >= descriptor.width || y >= descriptor.height) continue;
        const color = colors[(indices >>> (pixel * 2)) & 3];
        const destination = y * bytesPerRow + x * 4;
        rgba.set(color, destination);
        if (baseFormat === 0x87) {
          rgba[destination + 3] = ((descriptor.bytes[block + (pixel >>> 1)] >>> ((pixel & 1) * 4)) & 15) * 17;
        } else if (baseFormat === 0x88) {
          rgba[destination + 3] = alphaPalette[Number((alphaBits >> BigInt(pixel * 3)) & 7n)];
        }
      }
    }
  }
}

function uploadTexture2D(device, descriptor, withStatistics = false) {
  const baseFormat = descriptor.format & ~(0x20 | 0x40);
  const bytesPerTexel = baseFormat === 0x85 ? 4 : baseFormat === 0x8b ? 2 : baseFormat === 0x81 ? 1 : 0;
  const compressed = baseFormat >= 0x86 && baseFormat <= 0x88;
  if ((!bytesPerTexel && !compressed) || descriptor.depth !== 1 || descriptor.dimension !== 1) {
    throw new Error(`current WebGPU texture closure requires B8, G8B8, A8R8G8B8, or DXT 2D data (format=0x${descriptor.format.toString(16)})`);
  }
  const bytesPerRow = Math.ceil((descriptor.width * 4) / 256) * 256;
  const rgba = new Uint8Array(bytesPerRow * descriptor.height);
  if (compressed) {
    decodeBcTexture(descriptor, baseFormat, rgba, bytesPerRow);
  } else {
    const linear = Boolean(descriptor.format & 0x20);
    const sourcePitch = linear ? (descriptor.pitch || descriptor.width * bytesPerTexel) : descriptor.width * bytesPerTexel;
    if (sourcePitch < descriptor.width * bytesPerTexel || descriptor.bytes.byteLength < sourcePitch * descriptor.height) {
      throw new Error("RPCS3 texture payload is truncated");
    }
    const sourceBytes = linear
      ? descriptor.bytes
      : deswizzle2D(descriptor.bytes, descriptor.width, descriptor.height, bytesPerTexel);
    for (let y = 0; y < descriptor.height; y += 1) {
      for (let x = 0; x < descriptor.width; x += 1) {
        const source = y * sourcePitch + x * bytesPerTexel;
        const destination = y * bytesPerRow + x * 4;
        if (baseFormat === 0x85) {
          rgba[destination] = sourceBytes[source + 1];
          rgba[destination + 1] = sourceBytes[source + 2];
          rgba[destination + 2] = sourceBytes[source + 3];
          rgba[destination + 3] = sourceBytes[source];
        } else if (baseFormat === 0x8b) {
          rgba[destination] = sourceBytes[source + 1];
          rgba[destination + 1] = sourceBytes[source];
          rgba[destination + 2] = sourceBytes[source + 1];
          rgba[destination + 3] = sourceBytes[source];
        } else {
          const value = sourceBytes[source];
          rgba[destination] = value;
          rgba[destination + 1] = value;
          rgba[destination + 2] = value;
          rgba[destination + 3] = 255;
        }
      }
    }
  }
  const remapControl = descriptor.remap >>> 8;
  const component = (argb, channel) => {
    const control = (remapControl >>> (channel * 2)) & 3;
    if (control === 0) return 0;
    if (control === 1) return 255;
    return argb[(descriptor.remap >>> (channel * 2)) & 3];
  };
  if ((descriptor.remap & 0xffff) !== 0xaae4) {
    for (let y = 0; y < descriptor.height; y += 1) {
      for (let x = 0; x < descriptor.width; x += 1) {
        const destination = y * bytesPerRow + x * 4;
        const argb = [rgba[destination + 3], rgba[destination], rgba[destination + 1], rgba[destination + 2]];
        const remapped = [0, 1, 2, 3].map((channel) => component(argb, channel));
        rgba.set([remapped[1], remapped[2], remapped[3], remapped[0]], destination);
      }
    }
  }
  // Per-channel statistics are diagnostics for the acceptance specs, not
  // part of the upload.
  const channelMin = [255, 255, 255, 255];
  const channelMax = [0, 0, 0, 0];
  const channelSum = [0, 0, 0, 0];
  if (withStatistics) {
    for (let y = 0; y < descriptor.height; y += 1) {
      for (let x = 0; x < descriptor.width; x += 1) {
        const destination = y * bytesPerRow + x * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          channelMin[channel] = Math.min(channelMin[channel], rgba[destination + channel]);
          channelMax[channel] = Math.max(channelMax[channel], rgba[destination + channel]);
          channelSum[channel] += rgba[destination + channel];
        }
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
  const addressMode = (value) => value === 1 ? "repeat" : value === 2 ? "mirror-repeat" : "clamp-to-edge";
  const minFilter = descriptor.filterModes & 0xff;
  const magFilter = (descriptor.filterModes >>> 8) & 0xff;
  const sampler = device.createSampler({
    addressModeU: addressMode(descriptor.addressModes & 0xff),
    addressModeV: addressMode((descriptor.addressModes >>> 8) & 0xff),
    addressModeW: addressMode((descriptor.addressModes >>> 16) & 0xff),
    magFilter: magFilter === 1 ? "nearest" : "linear",
    minFilter: minFilter === 1 || minFilter === 3 || minFilter === 5 ? "nearest" : "linear",
  });
  return {
    texture,
    view: texture.createView(),
    sampler,
    byteSize: descriptor.width * descriptor.height * 4,
    diagnostics: {
      width: descriptor.width,
      height: descriptor.height,
      ...(withStatistics ? {
        channelMin,
        channelMax,
        channelMean: channelSum.map((sum) => sum / (descriptor.width * descriptor.height)),
      } : {}),
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
  ].join(":");
}

function drawDiagnostics(draw) {
  if (!draw.oracleOutput) return { vertexOracle: false };
  const result = {
    vertexOracle: true,
    clipBounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    varyingBounds: Object.fromEntries(VertexVaryings.map((name) => [name, {
      min: [Infinity, Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity, -Infinity],
    }])),
  };
  for (let offset = 0; offset < draw.oracleOutput.length; offset += VertexOutputStrideFloats) {
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
  stopWebGPUPresentation();
  const { canvas, adapter, device, context, format } = prepared;
  // Clears and draws execute in packet order against a render target that
  // persists across frames, as on the RSX: a clear is a scissored, masked
  // write of the resolved clear values, and a frame without a clear draws
  // over the previous contents.
  const operations = packets.filter((packet) => packet.kind === PacketKind.draw || packet.kind === PacketKind.clear);
  const drawPackets = operations.filter((packet) => packet.kind === PacketKind.draw);
  const clearPackets = operations.filter((packet) => packet.kind === PacketKind.clear);
  const clears = clearPackets.map((packet) => ({
    ...clearValue(packet),
    scissor: packet.sections[SectionKind.rasterEnvironment].bytes.byteLength === 16
      ? scissorState(packet, canvas)
      : { scaled: { x: 0, y: 0, width: canvas.width, height: canvas.height } },
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
  const programs = drawPackets.map((packet) => getProgram(prepared, packet, vertexBackend));
  const translated = drawPackets.map((packet, index) => translateDraw(packet, programs[index], vertexDiagnostics, vertexBackend));
  const depthStates = drawPackets.map(depthState);
  const targetStates = drawPackets.map(renderTargetState);
  const rasterStates = drawPackets.map(rasterState);
  const scissorStates = drawPackets.map((packet) => scissorState(packet, canvas));
  const translatedAt = performance.now();

  const pipelineCache = prepared.pipelineCache ??= new Map();
  const bindGroupCache = prepared.bindGroupCache ??= new Map();
  const textureCache = prepared.textureCache ??= new Map();
  const textureCacheBudget = options.textureCacheBytes ?? 128 * 1024 * 1024;
  const frameTextureKeys = new Set();
  let pipelineCacheHits = 0;
  let pipelineCacheMisses = 0;
  let bindGroupCacheHits = 0;
  let bindGroupCacheMisses = 0;
  let textureCacheHits = 0;
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
    return { pipeline: getClearPipeline(prepared, format, writeMask, depthWrite), offset: clearBase + index * UNIFORM_ALIGNMENT, scissor: op.scissor.scaled, writeMask, depthWrite };
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
    const target = targetStates[index];
    const depth = depthStates[index];
    const raster = rasterStates[index];
    const blend = target.blend;
    const blendKey = blend
      ? [blend.color.srcFactor, blend.color.dstFactor, blend.color.operation, blend.alpha.srcFactor, blend.alpha.dstFactor, blend.alpha.operation].join(",")
      : "none";
    const stripIndexFormat = vertexBackend === "webgpu-wgsl" && draw.indexed && draw.topology.endsWith("-strip") ? draw.indexFormat : undefined;
    const pipelineKey = [program.key, format, draw.topology, stripIndexFormat ?? "-", raster.frontFace, raster.cullMode, depth.writeEnabled, depth.comparison, target.writeMask, blendKey].join("|");
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
          targets: [{ format, blend, writeMask: target.writeMask }],
        },
        primitive: { topology: draw.topology, frontFace: raster.frontFace, cullMode: raster.cullMode, stripIndexFormat },
        depthStencil: { format: "depth24plus", depthWriteEnabled: depth.writeEnabled, depthCompare: depth.comparison },
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

    const textureResources = [];
    if (program.fragment.textured) {
      for (const slot of program.fragment.textureSlots) {
        const descriptor = packet.textures.find((texture) => texture.stage === 0 && texture.slot === slot);
        if (!descriptor) throw new Error(`RPCS3 fragment texture ${slot} is missing`);
        const cacheKey = textureCacheKey(descriptor);
        let resource = textureCache.get(cacheKey);
        if (resource) {
          textureCache.delete(cacheKey);
          textureCache.set(cacheKey, resource);
          textureCacheHits += 1;
        } else {
          resource = uploadTexture2D(device, descriptor, textureDiagnostics);
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
    return { pipeline, vertexOffset, vertexSize, indexOffset, indexSize, bindGroup, dynamicOffsets, textureResources, shaderCode: program.shaderCode };
  });
  device.queue.writeBuffer(uniformRing.buffer, 0, uniformBytes);
  const frameTarget = ensureFrameTarget(prepared, canvas.width, canvas.height, format);
  const resourcesReadyAt = performance.now();

  const encoder = device.createCommandEncoder({ label: "RPCS3 RSX packet frame" });
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: frameTarget.colorView, loadOp: "load", storeOp: "store",
  }], depthStencilAttachment: {
    view: frameTarget.depthView, depthLoadOp: "load", depthStoreOp: "store",
  } });
  let drawIndex = 0;
  let clearIndex = 0;
  for (const operation of operations) {
    if (operation.kind === PacketKind.clear) {
      const op = clearResources[clearIndex++];
      if (op.scissor.width === 0 || op.scissor.height === 0 || (op.writeMask === 0 && !op.depthWrite)) continue;
      pass.setPipeline(op.pipeline);
      pass.setScissorRect(op.scissor.x, op.scissor.y, op.scissor.width, op.scissor.height);
      pass.setBindGroup(0, clearBindGroup, [op.offset]);
      pass.draw(3);
      continue;
    }
    const index = drawIndex++;
    const scissor = scissorStates[index].scaled;
    if (scissor.width === 0 || scissor.height === 0) continue;
    const resource = resources[index];
    const draw = translated[index];
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
  pass.end();
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
  if ((prepared.textureCacheBytes ?? 0) > textureCacheBudget) {
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
      texture: resources[index].textureResources[0]?.diagnostics,
      textures: resources[index].textureResources.map(({ slot, diagnostics }) => ({ slot, ...diagnostics })),
    })),
    changedPixels,
    clearPixels,
    frameHash,
    changedBounds: !pixels || changedMaxX < 0 ? null : { minX: changedMinX, minY: changedMinY, maxX: changedMaxX, maxY: changedMaxY },
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
    },
    uniformRingBytes: uniformRing.size,
    vertexRingBytes: vertexRing.size,
    streamRingBytes: streamRing.size,
    indexRingBytes: indexRing.size,
    rgbaBase64: rgba ? base64(rgba) : undefined,
  };
}
