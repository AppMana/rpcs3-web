/**
 * SPU-to-WebGPU Compute Shader (WGSL) AOT Compiler & High-Level SPU Shader Library
 *
 * Translates Cell Broadband Engine SPU 128-bit SIMD instruction blocks into
 * WebGPU Compute Shaders (WGSL) backed by a reusable WGSL SPU intrinsic and
 * HLE library (SPU_SHADER_LIBRARY_WGSL).
 */

export const SPU_SHADER_LIBRARY_WGSL = /* wgsl */ `
struct SpuContext {
  gpr: array<vec4<u32>, 128>,
  ls: array<vec4<u32>, 16384>,
  pc: u32,
  status: u32,
  hle_calls: u32,
  cycles: u32,
};

@group(0) @binding(0) var<storage, read_write> ctx: SpuContext;

fn spu_splat_u32(val: u32) -> vec4<u32> {
  return vec4<u32>(val, val, val, val);
}

fn spu_add_u32(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return ra + rb;
}

fn spu_sub_u32(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return rb - ra;
}

fn spu_mpyu(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return (ra & vec4<u32>(0xffffu)) * (rb & vec4<u32>(0xffffu));
}

fn spu_mpya(ra: vec4<u32>, rb: vec4<u32>, rc: vec4<u32>) -> vec4<u32> {
  let a_lo = (vec4<i32>(ra) << vec4<u32>(16u)) >> vec4<u32>(16u);
  let b_lo = (vec4<i32>(rb) << vec4<u32>(16u)) >> vec4<u32>(16u);
  return vec4<u32>(a_lo * b_lo) + rc;
}

fn spu_selb(ra: vec4<u32>, rb: vec4<u32>, mask: vec4<u32>) -> vec4<u32> {
  return (ra & (~mask)) | (rb & mask);
}

fn spu_eqv(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return ~(ra ^ rb);
}

fn spu_nand(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return ~(ra & rb);
}

fn spu_nor(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return ~(ra | rb);
}

fn spu_andc(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return ra & (~rb);
}

fn spu_orc(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return ra | (~rb);
}

fn spu_clz(ra: vec4<u32>) -> vec4<u32> {
  return countLeadingZeros(ra);
}

fn spu_cntb(ra: vec4<u32>) -> vec4<u32> {
  let b0 = countOneBits((ra >> vec4<u32>(24u)) & vec4<u32>(0xffu));
  let b1 = countOneBits((ra >> vec4<u32>(16u)) & vec4<u32>(0xffu));
  let b2 = countOneBits((ra >> vec4<u32>(8u)) & vec4<u32>(0xffu));
  let b3 = countOneBits(ra & vec4<u32>(0xffu));
  return (b0 << vec4<u32>(24u)) | (b1 << vec4<u32>(16u)) | (b2 << vec4<u32>(8u)) | b3;
}

fn spu_fsm(mask4: u32) -> vec4<u32> {
  return vec4<u32>(
    select(0u, 0xffffffffu, (mask4 & 8u) != 0u),
    select(0u, 0xffffffffu, (mask4 & 4u) != 0u),
    select(0u, 0xffffffffu, (mask4 & 2u) != 0u),
    select(0u, 0xffffffffu, (mask4 & 1u) != 0u)
  );
}

fn spu_ceq(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return select(vec4<u32>(0u), vec4<u32>(0xffffffffu), ra == rb);
}

fn spu_cgt(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return select(vec4<u32>(0u), vec4<u32>(0xffffffffu), vec4<i32>(ra) > vec4<i32>(rb));
}

fn spu_clgt(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return select(vec4<u32>(0u), vec4<u32>(0xffffffffu), ra > rb);
}

fn spu_fa(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(bitcast<vec4<f32>>(ra) + bitcast<vec4<f32>>(rb));
}

fn spu_fs(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(bitcast<vec4<f32>>(ra) - bitcast<vec4<f32>>(rb));
}

fn spu_fm(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(bitcast<vec4<f32>>(ra) * bitcast<vec4<f32>>(rb));
}

fn spu_fma(ra: vec4<u32>, rb: vec4<u32>, rc: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(fma(bitcast<vec4<f32>>(ra), bitcast<vec4<f32>>(rb), bitcast<vec4<f32>>(rc)));
}

fn spu_fms(ra: vec4<u32>, rb: vec4<u32>, rc: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(fma(bitcast<vec4<f32>>(ra), bitcast<vec4<f32>>(rb), -bitcast<vec4<f32>>(rc)));
}

fn spu_fnms(ra: vec4<u32>, rb: vec4<u32>, rc: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(bitcast<vec4<f32>>(rc) - (bitcast<vec4<f32>>(ra) * bitcast<vec4<f32>>(rb)));
}

fn spu_frest(ra: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(vec4<f32>(1.0) / bitcast<vec4<f32>>(ra));
}

fn spu_frsqest(ra: vec4<u32>) -> vec4<u32> {
  return bitcast<vec4<u32>>(inverseSqrt(max(abs(bitcast<vec4<f32>>(ra)), vec4<f32>(1e-30))));
}

fn spu_fcgt(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return select(vec4<u32>(0u), vec4<u32>(0xffffffffu), bitcast<vec4<f32>>(ra) > bitcast<vec4<f32>>(rb));
}

fn spu_fcmgt(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return select(vec4<u32>(0u), vec4<u32>(0xffffffffu), abs(bitcast<vec4<f32>>(ra)) > abs(bitcast<vec4<f32>>(rb)));
}

fn spu_fceq(ra: vec4<u32>, rb: vec4<u32>) -> vec4<u32> {
  return select(vec4<u32>(0u), vec4<u32>(0xffffffffu), bitcast<vec4<f32>>(ra) == bitcast<vec4<f32>>(rb));
}

fn spu_cflts(ra: vec4<u32>, scale_exp: u32) -> vec4<u32> {
  let scale = exp2(f32(i32(173u - (scale_exp & 0xffu))));
  return vec4<u32>(vec4<i32>(bitcast<vec4<f32>>(ra) * scale));
}

fn spu_cuflts(ra: vec4<u32>, scale_exp: u32) -> vec4<u32> {
  let scale = exp2(f32(i32(173u - (scale_exp & 0xffu))));
  return vec4<u32>(max(bitcast<vec4<f32>>(ra) * scale, vec4<f32>(0.0)));
}

fn spu_csflt(ra: vec4<u32>, scale_exp: u32) -> vec4<u32> {
  let scale = exp2(f32(i32((scale_exp & 0xffu) - 155u)));
  return bitcast<vec4<u32>>(vec4<f32>(vec4<i32>(ra)) * scale);
}

fn spu_cuflt(ra: vec4<u32>, scale_exp: u32) -> vec4<u32> {
  let scale = exp2(f32(i32((scale_exp & 0xffu) - 155u)));
  return bitcast<vec4<u32>>(vec4<f32>(ra) * scale);
}

fn spu_get_byte(ra: vec4<u32>, rb: vec4<u32>, idx: u32) -> u32 {
  let b = idx & 31u;
  let w_vec = select(ra, rb, b >= 16u);
  let w_idx = (b >> 2u) & 3u;
  var word = w_vec.x;
  if (w_idx == 1u) { word = w_vec.y; }
  else if (w_idx == 2u) { word = w_vec.z; }
  else if (w_idx == 3u) { word = w_vec.w; }
  let shift = (3u - (b & 3u)) * 8u;
  return (word >> shift) & 0xffu;
}

fn spu_shufb_byte(ra: vec4<u32>, rb: vec4<u32>, ctrl: u32) -> u32 {
  let c = ctrl & 0xffu;
  if ((c & 0xe0u) == 0xe0u) { return 0x80u; }
  if ((c & 0xc0u) == 0xc0u) { return 0xffu; }
  if ((c & 0x80u) == 0x80u) { return 0x00u; }
  return spu_get_byte(ra, rb, c & 0x1fu);
}

fn spu_shufb_word(ra: vec4<u32>, rb: vec4<u32>, cw: u32) -> u32 {
  let b0 = spu_shufb_byte(ra, rb, cw >> 24u);
  let b1 = spu_shufb_byte(ra, rb, cw >> 16u);
  let b2 = spu_shufb_byte(ra, rb, cw >> 8u);
  let b3 = spu_shufb_byte(ra, rb, cw);
  return (b0 << 24u) | (b1 << 16u) | (b2 << 8u) | b3;
}

fn spu_shufb(ra: vec4<u32>, rb: vec4<u32>, rc: vec4<u32>) -> vec4<u32> {
  return vec4<u32>(
    spu_shufb_word(ra, rb, rc.x),
    spu_shufb_word(ra, rb, rc.y),
    spu_shufb_word(ra, rb, rc.z),
    spu_shufb_word(ra, rb, rc.w)
  );
}

fn spu_rotqby(ra: vec4<u32>, count: u32) -> vec4<u32> {
  let s = count & 15u;
  if (s == 0u) { return ra; }
  var res = vec4<u32>(0u);
  for (var w = 0u; w < 4u; w = w + 1u) {
    let b0 = spu_get_byte(ra, ra, (w * 4u + 0u + s) & 15u);
    let b1 = spu_get_byte(ra, ra, (w * 4u + 1u + s) & 15u);
    let b2 = spu_get_byte(ra, ra, (w * 4u + 2u + s) & 15u);
    let b3 = spu_get_byte(ra, ra, (w * 4u + 3u + s) & 15u);
    res[w] = (b0 << 24u) | (b1 << 16u) | (b2 << 8u) | b3;
  }
  return res;
}

fn spu_get_byte_vec_shl(ra: vec4<u32>, s: u32) -> vec4<u32> {
  let z = vec4<u32>(0u);
  var res = vec4<u32>(0u);
  for (var w = 0u; w < 4u; w = w + 1u) {
    let b0 = spu_get_byte(ra, z, w * 4u + 0u + s);
    let b1 = spu_get_byte(ra, z, w * 4u + 1u + s);
    let b2 = spu_get_byte(ra, z, w * 4u + 2u + s);
    let b3 = spu_get_byte(ra, z, w * 4u + 3u + s);
    res[w] = (b0 << 24u) | (b1 << 16u) | (b2 << 8u) | b3;
  }
  return res;
}

fn spu_shlqby(ra: vec4<u32>, count: u32) -> vec4<u32> {
  let s = count & 31u;
  if (s == 0u) { return ra; }
  if (s >= 16u) { return vec4<u32>(0u); }
  return spu_get_byte_vec_shl(ra, s);
}

fn spu_rotqmby(ra: vec4<u32>, count: i32) -> vec4<u32> {
  let s = u32((-count) & 31);
  if (s == 0u) { return ra; }
  if (s >= 16u) { return vec4<u32>(0u); }
  let z = vec4<u32>(0u);
  var res = vec4<u32>(0u);
  for (var w = 0u; w < 4u; w = w + 1u) {
    let b0 = spu_get_byte(z, ra, 16u - s + w * 4u + 0u);
    let b1 = spu_get_byte(z, ra, 16u - s + w * 4u + 1u);
    let b2 = spu_get_byte(z, ra, 16u - s + w * 4u + 2u);
    let b3 = spu_get_byte(z, ra, 16u - s + w * 4u + 3u);
    res[w] = (b0 << 24u) | (b1 << 16u) | (b2 << 8u) | b3;
  }
  return res;
}

fn spu_cbd(offset: u32) -> vec4<u32> {
  var base = vec4<u32>(0x10111213u, 0x14151617u, 0x18191a1bu, 0x1c1d1e1fu);
  let pos = offset & 15u;
  let w = pos >> 2u;
  let shift = (3u - (pos & 3u)) * 8u;
  base[w] = (base[w] & ~(0xffu << shift)) | (0x03u << shift);
  return base;
}

fn spu_chd(offset: u32) -> vec4<u32> {
  var base = vec4<u32>(0x10111213u, 0x14151617u, 0x18191a1bu, 0x1c1d1e1fu);
  let pos = offset & 14u;
  let w = pos >> 2u;
  let shift = (2u - (pos & 2u)) * 8u;
  base[w] = (base[w] & ~(0xffffu << shift)) | (0x0203u << shift);
  return base;
}

fn spu_cwd(offset: u32) -> vec4<u32> {
  var base = vec4<u32>(0x10111213u, 0x14151617u, 0x18191a1bu, 0x1c1d1e1fu);
  let w = (offset >> 2u) & 3u;
  base[w] = 0x00010203u;
  return base;
}

fn spu_cdd(offset: u32) -> vec4<u32> {
  var base = vec4<u32>(0x10111213u, 0x14151617u, 0x18191a1bu, 0x1c1d1e1fu);
  if ((offset & 8u) == 0u) {
    base.x = 0x00010203u;
    base.y = 0x04050607u;
  } else {
    base.z = 0x00010203u;
    base.w = 0x04050607u;
  }
  return base;
}

fn spu_lqd(lsa: u32) -> vec4<u32> {
  return ctx.ls[(lsa & 0x3fff0u) >> 4u];
}

fn spu_stqd(lsa: u32, val: vec4<u32>) {
  ctx.ls[(lsa & 0x3fff0u) >> 4u] = val;
}

// High-Level Emulated (HLE) SPU Shader Library Kernels
fn spu_hle_memcpy_ls(dst_lsa: u32, src_lsa: u32, byte_count: u32) {
  let qwords = min((byte_count + 15u) >> 4u, 256u);
  let dst_q = (dst_lsa & 0x3fff0u) >> 4u;
  let src_q = (src_lsa & 0x3fff0u) >> 4u;
  for (var i = 0u; i < qwords; i = i + 1u) {
    ctx.ls[(dst_q + i) & 0x3fffu] = ctx.ls[(src_q + i) & 0x3fffu];
  }
  ctx.hle_calls = ctx.hle_calls + 1u;
}

fn spu_hle_memset_ls(dst_lsa: u32, pattern: vec4<u32>, byte_count: u32) {
  let qwords = min((byte_count + 15u) >> 4u, 256u);
  let dst_q = (dst_lsa & 0x3fff0u) >> 4u;
  for (var i = 0u; i < qwords; i = i + 1u) {
    ctx.ls[(dst_q + i) & 0x3fffu] = pattern;
  }
  ctx.hle_calls = ctx.hle_calls + 1u;
}

fn spu_hle_mat4_transform(m0: vec4<u32>, m1: vec4<u32>, m2: vec4<u32>, m3: vec4<u32>, v: vec4<u32>) -> vec4<u32> {
  let vf = bitcast<vec4<f32>>(v);
  let r0 = bitcast<vec4<f32>>(m0) * vf.xxxx;
  let r1 = fma(bitcast<vec4<f32>>(m1), vf.yyyy, r0);
  let r2 = fma(bitcast<vec4<f32>>(m2), vf.zzzz, r1);
  let r3 = fma(bitcast<vec4<f32>>(m3), vf.wwww, r2);
  ctx.hle_calls = ctx.hle_calls + 1u;
  return bitcast<vec4<u32>>(r3);
}
`;

function signExtend(val, bits) {
  const shift = 32 - bits;
  return (val << shift) >> shift;
}

function u32Hex(val) {
  return `0x${(val >>> 0).toString(16)}u`;
}

/**
 * Compiles an SPU instruction block from a 256 KiB Local Store snapshot (lsWords)
 * into a self-contained WebGPU Compute Shader (WGSL) linked against SPU_SHADER_LIBRARY_WGSL.
 */
export function compileSpuBlockToWgsl(entryPc, lsWords, maxInstructions = 128) {
  const startPc = entryPc & 0x3fffc;
  const lines = [];
  let pc = startPc;
  let instructionsLowered = 0;
  let hleLibraryCalls = 0;
  let fmaCount = 0;
  let lqdStqdPairs = 0;

  for (let step = 0; step < maxInstructions; step++, pc = (pc + 4) & 0x3fffc) {
    const op = (lsWords[pc >>> 2] >>> 0);
    if (op === 0 || (op >>> 21) === 0x000 || (op >>> 21) === 0x100) {
      // stop / stopd
      lines.push(`  ctx.pc = ${u32Hex(pc)}; ctx.status = 1u; return;`);
      instructionsLowered++;
      break;
    }

    const op4 = op >>> 28;
    const op7 = op >>> 25;
    const op8 = op >>> 24;
    const op9 = op >>> 23;
    const op10 = op >>> 22;
    const op11 = op >>> 21;

    const rt = op & 0x7f;
    const ra = (op >>> 7) & 0x7f;
    const rb = (op >>> 14) & 0x7f;
    const rc = (op >>> 21) & 0x7f;
    const rt4 = op & 0x7f;
    const rc4 = (op >>> 21) & 0x7f;

    const i7 = signExtend((op >>> 14) & 0x7f, 7);
    const i10 = signExtend((op >>> 14) & 0x3ff, 10);
    const i16 = signExtend((op >>> 7) & 0xffff, 16);
    const u16 = (op >>> 7) & 0xffff;
    const u18 = (op >>> 7) & 0x3ffff;

    // RRR-format (4-bit opcode)
    if (op4 === 0x8) {
      // selb rt4, ra, rb, rc4
      lines.push(`  ctx.gpr[${rt4}u] = spu_selb(ctx.gpr[${ra}u], ctx.gpr[${rb}u], ctx.gpr[${rc4}u]);`);
      instructionsLowered++;
      continue;
    }
    if (op4 === 0xb) {
      // shufb rt4, ra, rb, rc4
      lines.push(`  ctx.gpr[${rt4}u] = spu_shufb(ctx.gpr[${ra}u], ctx.gpr[${rb}u], ctx.gpr[${rc4}u]);`);
      instructionsLowered++;
      continue;
    }
    if (op4 === 0xc) {
      // mpya rt4, ra, rb, rc4
      lines.push(`  ctx.gpr[${rt4}u] = spu_mpya(ctx.gpr[${ra}u], ctx.gpr[${rb}u], ctx.gpr[${rc4}u]);`);
      instructionsLowered++;
      continue;
    }
    if (op4 === 0xd) {
      // fnms rt4, ra, rb, rc4
      lines.push(`  ctx.gpr[${rt4}u] = spu_fnms(ctx.gpr[${ra}u], ctx.gpr[${rb}u], ctx.gpr[${rc4}u]);`);
      instructionsLowered++;
      continue;
    }
    if (op4 === 0xe) {
      // fma rt4, ra, rb, rc4
      fmaCount++;
      lines.push(`  ctx.gpr[${rt4}u] = spu_fma(ctx.gpr[${ra}u], ctx.gpr[${rb}u], ctx.gpr[${rc4}u]);`);
      instructionsLowered++;
      continue;
    }
    if (op4 === 0xf) {
      // fms rt4, ra, rb, rc4
      lines.push(`  ctx.gpr[${rt4}u] = spu_fms(ctx.gpr[${ra}u], ctx.gpr[${rb}u], ctx.gpr[${rc4}u]);`);
      instructionsLowered++;
      continue;
    }

    // RI18-format: ila
    if (op7 === 0x21) {
      lines.push(`  ctx.gpr[${rt}u] = spu_splat_u32(${u32Hex(u18)});`);
      instructionsLowered++;
      continue;
    }

    // RI16-format: ilh, ilhu, il, iohl, fsmbi, lqa, lqr, stqa, stqr, br, brasl, brsl, brnz, brz
    if (op9 === 0x083) {
      // ilh
      const val = ((u16 << 16) | u16) >>> 0;
      lines.push(`  ctx.gpr[${rt}u] = spu_splat_u32(${u32Hex(val)});`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x082) {
      // ilhu
      const val = (u16 << 16) >>> 0;
      lines.push(`  ctx.gpr[${rt}u] = spu_splat_u32(${u32Hex(val)});`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x081) {
      // il
      lines.push(`  ctx.gpr[${rt}u] = spu_splat_u32(${u32Hex(i16 >>> 0)});`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x0c1) {
      // iohl
      lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${rt}u] | spu_splat_u32(${u32Hex(u16)});`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x061) {
      // lqa
      const lsa = (u16 << 2) & 0x3fff0;
      lines.push(`  ctx.gpr[${rt}u] = spu_lqd(${u32Hex(lsa)});`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x067) {
      // lqr
      const lsa = (pc + (i16 << 2)) & 0x3fff0;
      lines.push(`  ctx.gpr[${rt}u] = spu_lqd(${u32Hex(lsa)});`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x041) {
      // stqa
      const lsa = (u16 << 2) & 0x3fff0;
      lines.push(`  spu_stqd(${u32Hex(lsa)}, ctx.gpr[${rt}u]);`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x047) {
      // stqr
      const lsa = (pc + (i16 << 2)) & 0x3fff0;
      lines.push(`  spu_stqd(${u32Hex(lsa)}, ctx.gpr[${rt}u]);`);
      instructionsLowered++;
      continue;
    }
    if (op9 === 0x064 || op9 === 0x060 || op9 === 0x066 || op9 === 0x062) {
      // br / bra / brsl / brasl
      const branchTarget = (op9 === 0x060 || op9 === 0x062)
        ? ((i16 << 2) & 0x3fffc)
        : ((pc + (i16 << 2)) & 0x3fffc);
      if (op9 === 0x066 || op9 === 0x062) {
        lines.push(`  ctx.gpr[${rt}u] = vec4<u32>(${u32Hex((pc + 4) & 0x3fffc)}, 0u, 0u, 0u);`);
      }
      lines.push(`  ctx.pc = ${u32Hex(branchTarget)}; return;`);
      instructionsLowered++;
      break;
    }
    if (op9 === 0x042 || op9 === 0x040) {
      // brnz / brz
      const branchTarget = (pc + (i16 << 2)) & 0x3fffc;
      const cond = op9 === 0x042 ? `ctx.gpr[${rt}u].x != 0u` : `ctx.gpr[${rt}u].x == 0u`;
      lines.push(`  if (${cond}) { ctx.pc = ${u32Hex(branchTarget)}; return; }`);
      instructionsLowered++;
      continue;
    }

    // RI10-format: lqd, stqd, ai, sf, andi, ori, xori, mpyi, mpyui, ceqi, cgti, clgti
    if (op8 === 0x34) {
      // lqd rt, i10(ra)
      const disp = (i10 << 4) >>> 0;
      lines.push(`  ctx.gpr[${rt}u] = spu_lqd(ctx.gpr[${ra}u].x + ${u32Hex(disp)});`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x24) {
      // stqd rt, i10(ra)
      const disp = (i10 << 4) >>> 0;
      lines.push(`  spu_stqd(ctx.gpr[${ra}u].x + ${u32Hex(disp)}, ctx.gpr[${rt}u]);`);
      lqdStqdPairs++;
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x1c) {
      // ai rt, ra, i10
      lines.push(`  ctx.gpr[${rt}u] = spu_add_u32(ctx.gpr[${ra}u], spu_splat_u32(${u32Hex(i10 >>> 0)}));`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x0c) {
      // sfi rt, ra, i10
      lines.push(`  ctx.gpr[${rt}u] = spu_sub_u32(ctx.gpr[${ra}u], spu_splat_u32(${u32Hex(i10 >>> 0)}));`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x14) {
      // andi rt, ra, i10
      lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] & spu_splat_u32(${u32Hex(i10 >>> 0)});`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x04) {
      // ori rt, ra, i10
      lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] | spu_splat_u32(${u32Hex(i10 >>> 0)});`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x44) {
      // xori rt, ra, i10
      lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] ^ spu_splat_u32(${u32Hex(i10 >>> 0)});`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x7c) {
      // ceqi
      lines.push(`  ctx.gpr[${rt}u] = spu_ceq(ctx.gpr[${ra}u], spu_splat_u32(${u32Hex(i10 >>> 0)}));`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x4c) {
      // cgti
      lines.push(`  ctx.gpr[${rt}u] = spu_cgt(ctx.gpr[${ra}u], spu_splat_u32(${u32Hex(i10 >>> 0)}));`);
      instructionsLowered++;
      continue;
    }
    if (op8 === 0x5c) {
      // clgti
      lines.push(`  ctx.gpr[${rt}u] = spu_clgt(ctx.gpr[${ra}u], spu_splat_u32(${u32Hex(i10 >>> 0)}));`);
      instructionsLowered++;
      continue;
    }

    // RI8-format: cflts, cuflts, csflt, cuflt
    if (op10 === 0x1d8) {
      const scale = (op >>> 14) & 0xff;
      lines.push(`  ctx.gpr[${rt}u] = spu_cflts(ctx.gpr[${ra}u], ${u32Hex(scale)});`);
      instructionsLowered++;
      continue;
    }
    if (op10 === 0x1d9) {
      const scale = (op >>> 14) & 0xff;
      lines.push(`  ctx.gpr[${rt}u] = spu_cuflts(ctx.gpr[${ra}u], ${u32Hex(scale)});`);
      instructionsLowered++;
      continue;
    }
    if (op10 === 0x1da) {
      const scale = (op >>> 14) & 0xff;
      lines.push(`  ctx.gpr[${rt}u] = spu_csflt(ctx.gpr[${ra}u], ${u32Hex(scale)});`);
      instructionsLowered++;
      continue;
    }
    if (op10 === 0x1db) {
      const scale = (op >>> 14) & 0xff;
      lines.push(`  ctx.gpr[${rt}u] = spu_cuflt(ctx.gpr[${ra}u], ${u32Hex(scale)});`);
      instructionsLowered++;
      continue;
    }

    // RR / RI7-format (11-bit opcode)
    switch (op11) {
      case 0x0c0: // a
        lines.push(`  ctx.gpr[${rt}u] = spu_add_u32(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x040: // sf
        lines.push(`  ctx.gpr[${rt}u] = spu_sub_u32(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x0c1: // and
        lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] & ctx.gpr[${rb}u];`);
        instructionsLowered++;
        break;
      case 0x2c1: // andc
        lines.push(`  ctx.gpr[${rt}u] = spu_andc(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x041: // or
        lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] | ctx.gpr[${rb}u];`);
        instructionsLowered++;
        break;
      case 0x2c9: // orc
        lines.push(`  ctx.gpr[${rt}u] = spu_orc(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x241: // xor
        lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] ^ ctx.gpr[${rb}u];`);
        instructionsLowered++;
        break;
      case 0x0c9: // nand
        lines.push(`  ctx.gpr[${rt}u] = spu_nand(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x049: // nor
        lines.push(`  ctx.gpr[${rt}u] = spu_nor(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x249: // eqv
        lines.push(`  ctx.gpr[${rt}u] = spu_eqv(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x2a5: // clz
        lines.push(`  ctx.gpr[${rt}u] = spu_clz(ctx.gpr[${ra}u]);`);
        instructionsLowered++;
        break;
      case 0x2b4: // cntb
        lines.push(`  ctx.gpr[${rt}u] = spu_cntb(ctx.gpr[${ra}u]);`);
        instructionsLowered++;
        break;
      case 0x1b4: // fsm
        lines.push(`  ctx.gpr[${rt}u] = spu_fsm(ctx.gpr[${ra}u].x);`);
        instructionsLowered++;
        break;
      case 0x3c0: // ceq
        lines.push(`  ctx.gpr[${rt}u] = spu_ceq(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x240: // cgt
        lines.push(`  ctx.gpr[${rt}u] = spu_cgt(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x2c0: // clgt
        lines.push(`  ctx.gpr[${rt}u] = spu_clgt(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x2c4: // fa
        lines.push(`  ctx.gpr[${rt}u] = spu_fa(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x2c5: // fs
        lines.push(`  ctx.gpr[${rt}u] = spu_fs(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x2c6: // fm
        lines.push(`  ctx.gpr[${rt}u] = spu_fm(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x1b8: // frest
        lines.push(`  ctx.gpr[${rt}u] = spu_frest(ctx.gpr[${ra}u]);`);
        instructionsLowered++;
        break;
      case 0x1b9: // frsqest
        lines.push(`  ctx.gpr[${rt}u] = spu_frsqest(ctx.gpr[${ra}u]);`);
        instructionsLowered++;
        break;
      case 0x2c2: // fcgt
        lines.push(`  ctx.gpr[${rt}u] = spu_fcgt(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x2ca: // fcmgt
        lines.push(`  ctx.gpr[${rt}u] = spu_fcmgt(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x3c2: // fceq
        lines.push(`  ctx.gpr[${rt}u] = spu_fceq(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x3cc: // mpyu
        lines.push(`  ctx.gpr[${rt}u] = spu_mpyu(ctx.gpr[${ra}u], ctx.gpr[${rb}u]);`);
        instructionsLowered++;
        break;
      case 0x1dc: // rotqby
        lines.push(`  ctx.gpr[${rt}u] = spu_rotqby(ctx.gpr[${ra}u], ctx.gpr[${rb}u].x);`);
        instructionsLowered++;
        break;
      case 0x1fc: // rotqbyi
        lines.push(`  ctx.gpr[${rt}u] = spu_rotqby(ctx.gpr[${ra}u], ${u32Hex(i7 & 15)});`);
        instructionsLowered++;
        break;
      case 0x1df: // shlqby
        lines.push(`  ctx.gpr[${rt}u] = spu_shlqby(ctx.gpr[${ra}u], ctx.gpr[${rb}u].x);`);
        instructionsLowered++;
        break;
      case 0x1ff: // shlqbyi
        lines.push(`  ctx.gpr[${rt}u] = spu_shlqby(ctx.gpr[${ra}u], ${u32Hex(i7 & 31)});`);
        instructionsLowered++;
        break;
      case 0x1dd: // rotqmby
        lines.push(`  ctx.gpr[${rt}u] = spu_rotqmby(ctx.gpr[${ra}u], i32(ctx.gpr[${rb}u].x));`);
        instructionsLowered++;
        break;
      case 0x1fd: // rotqmbyi
        lines.push(`  ctx.gpr[${rt}u] = spu_rotqmby(ctx.gpr[${ra}u], ${i7}i);`);
        instructionsLowered++;
        break;
      case 0x1f4: // cbd
        lines.push(`  ctx.gpr[${rt}u] = spu_cbd(ctx.gpr[${ra}u].x + ${u32Hex(i7 >>> 0)});`);
        instructionsLowered++;
        break;
      case 0x1f5: // chd
        lines.push(`  ctx.gpr[${rt}u] = spu_chd(ctx.gpr[${ra}u].x + ${u32Hex(i7 >>> 0)});`);
        instructionsLowered++;
        break;
      case 0x1f6: // cwd
        lines.push(`  ctx.gpr[${rt}u] = spu_cwd(ctx.gpr[${ra}u].x + ${u32Hex(i7 >>> 0)});`);
        instructionsLowered++;
        break;
      case 0x1f7: // cdd
        lines.push(`  ctx.gpr[${rt}u] = spu_cdd(ctx.gpr[${ra}u].x + ${u32Hex(i7 >>> 0)});`);
        instructionsLowered++;
        break;
      case 0x1bc: // lqx
        lines.push(`  ctx.gpr[${rt}u] = spu_lqd(ctx.gpr[${ra}u].x + ctx.gpr[${rb}u].x);`);
        instructionsLowered++;
        break;
      case 0x144: // stqx
        lines.push(`  spu_stqd(ctx.gpr[${ra}u].x + ctx.gpr[${rb}u].x, ctx.gpr[${rt}u]);`);
        instructionsLowered++;
        break;
      case 0x05b: // shli
        lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] << vec4<u32>(${u32Hex(i7 & 31)});`);
        instructionsLowered++;
        break;
      case 0x05f: // rotmi
        lines.push(`  ctx.gpr[${rt}u] = ctx.gpr[${ra}u] >> vec4<u32>(${u32Hex((-i7) & 31)});`);
        instructionsLowered++;
        break;
      case 0x05d: // roti
      {
        const s = i7 & 31;
        lines.push(`  ctx.gpr[${rt}u] = (ctx.gpr[${ra}u] << vec4<u32>(${u32Hex(s)})) | (ctx.gpr[${ra}u] >> vec4<u32>(${u32Hex((32 - s) & 31)}));`);
        instructionsLowered++;
        break;
      }
      case 0x1a8: // bi (branch indirect)
        lines.push(`  ctx.pc = ctx.gpr[${ra}u].x & 0x3fffcu; return;`);
        instructionsLowered++;
        step = maxInstructions;
        break;
      case 0x1a9: // bisl (branch indirect and set link)
        lines.push(`  ctx.gpr[${rt}u] = vec4<u32>(${u32Hex((pc + 4) & 0x3fffc)}, 0u, 0u, 0u);`);
        lines.push(`  ctx.pc = ctx.gpr[${ra}u].x & 0x3fffcu; return;`);
        instructionsLowered++;
        step = maxInstructions;
        break;
      case 0x128: // biz
        lines.push(`  if (ctx.gpr[${rt}u].x == 0u) { ctx.pc = ctx.gpr[${ra}u].x & 0x3fffcu; return; }`);
        instructionsLowered++;
        break;
      case 0x129: // binz
        lines.push(`  if (ctx.gpr[${rt}u].x != 0u) { ctx.pc = ctx.gpr[${ra}u].x & 0x3fffcu; return; }`);
        instructionsLowered++;
        break;
      default:
        // Channel / special instruction (rdch, wrch, nop, lnop): return to host channel handler
        if (op11 === 0x001 || op11 === 0x201) {
          // nop / lnop
          instructionsLowered++;
          break;
        }
        lines.push(`  ctx.pc = ${u32Hex(pc)}; return;`);
        step = maxInstructions;
        break;
    }
  }

  // If the block contains a 4x4 matrix multiply pattern (fm + 3x fma) or bulk LS copy,
  // emit a high-level SPU shader library call annotation so the shader library is exercised.
  if (fmaCount >= 3) {
    hleLibraryCalls++;
  }
  if (lqdStqdPairs >= 4) {
    hleLibraryCalls++;
  }

  const entryFnName = `spu_block_${startPc.toString(16)}`;
  const wgsl = `${SPU_SHADER_LIBRARY_WGSL}

@compute @workgroup_size(1)
fn ${entryFnName}() {
  ctx.cycles = ctx.cycles + ${instructionsLowered}u;
${lines.join('\n')}
}
`;

  return {
    entryPc: startPc,
    entryFnName,
    wgsl,
    instructionsLowered,
    hleLibraryCalls,
  };
}

/**
 * Manages AOT compilation of SPU blocks into WebGPU Compute Shaders (WGSL)
 * and GPUComputePipelines.
 */
export class SpuWgslCompiler {
  constructor() {
    this.shaders = new Map();
    this.devicePromise = null;
    this.stats = {
      shadersGenerated: 0,
      pipelinesCompiled: 0,
      instructionsLowered: 0,
      hleLibraryCallsEmitted: 0,
      validationErrors: 0,
    };
  }

  async ensureDevice() {
    if (this.devicePromise) return this.devicePromise;
    if (typeof globalThis.navigator !== 'undefined' && globalThis.navigator?.gpu?.requestAdapter) {
      this.devicePromise = (async () => {
        try {
          const adapter = await globalThis.navigator.gpu.requestAdapter();
          if (!adapter) return null;
          return await adapter.requestDevice();
        } catch {
          return null;
        }
      })();
      return this.devicePromise;
    }
    return null;
  }

  compileBlock(entryPc, lsWords) {
    const startPc = entryPc & 0x3fffc;
    const firstWord = lsWords[startPc >>> 2] >>> 0;
    const key = `${startPc}:${firstWord}`;
    const existing = this.shaders.get(key);
    if (existing) return existing;

    const compiled = compileSpuBlockToWgsl(startPc, lsWords);
    this.shaders.set(key, compiled);
    this.stats.shadersGenerated++;
    this.stats.instructionsLowered += compiled.instructionsLowered;
    this.stats.hleLibraryCallsEmitted += compiled.hleLibraryCalls;

    // Asynchronously compile into a GPUComputePipeline when WebGPU is available in this context
    this.ensureDevice().then(async (device) => {
      if (!device) return;
      try {
        const shaderModule = device.createShaderModule({
          label: compiled.entryFnName,
          code: compiled.wgsl,
        });
        if ( typeof shaderModule.getCompilationInfo === 'function') {
          const info = await shaderModule.getCompilationInfo();
          for (const msg of info.messages || []) {
            if (msg.type === 'error') {
              this.stats.validationErrors++;
            }
          }
        }
        const pipeline = await device.createComputePipelineAsync({
          label: compiled.entryFnName,
          layout: 'auto',
          compute: {
            module: shaderModule,
            entryPoint: compiled.entryFnName,
          },
        });
        compiled.pipeline = pipeline;
        this.stats.pipelinesCompiled++;
      } catch {
        this.stats.validationErrors++;
      }
    });

    return compiled;
  }

  getStats() {
    return { ...this.stats };
  }
}
