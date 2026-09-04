#include "stdafx.h"
#include "SPUWasmRecompiler.h"
#include "SPUThread.h"
#include "SPUOpcodes.h"
#include "SPUWasmAbi.h"
#include "Emu/IdManager.h"
#include "Emu/system_config.h"

#include <cstring>
#include <cmath>
#include <unordered_set>
#include <deque>

namespace
{
	const spu_decoder<spu_wasm_recompiler> s_decoder;

	// spu_thread field offsets shared with the SPU LLVM wasm mode (SPUWasmAbi.h)
	enum : u32
	{
		off_state = 20,
		off_pc = 24,
		off_gpr = 48,
		off_block_counter = 3592,
		off_block_failure = 3608,
	};

	// wasm opcodes used below
	enum : u32
	{
		op_unreachable = 0x00, op_drop = 0x1a, op_select = 0x1b,
		op_i32_eqz = 0x45, op_i32_eq = 0x46, op_i32_ne = 0x47, op_i32_lt_s = 0x48, op_i32_lt_u = 0x49, op_i32_gt_s = 0x4a, op_i32_gt_u = 0x4b,
		op_i32_clz = 0x67, op_i32_add = 0x6a, op_i32_sub = 0x6b, op_i32_mul = 0x6c, op_i32_and = 0x71, op_i32_or = 0x72, op_i32_xor = 0x73,
		op_i32_shl = 0x74, op_i32_shr_s = 0x75, op_i32_shr_u = 0x76,
		op_i64_add = 0x7c, op_i64_sub = 0x7d, op_i64_shl = 0x86, op_i64_shr_s = 0x87, op_i64_shr_u = 0x88,
		op_i32_wrap_i64 = 0xa7, op_i64_extend_i32_s = 0xac, op_i64_extend_i32_u = 0xad,
	};

	enum : u32
	{
		simd_swizzle = 14, simd_i8x16_splat = 15, simd_i16x8_splat = 16, simd_i32x4_splat = 17, simd_i64x2_splat = 18, simd_f32x4_splat = 19,
		simd_i8x16_extract_lane_u = 22, simd_i8x16_replace_lane = 23, simd_i16x8_extract_lane_u = 25, simd_i16x8_replace_lane = 26,
		simd_i32x4_extract_lane = 27, simd_i32x4_replace_lane = 28, simd_i64x2_extract_lane = 29, simd_i64x2_replace_lane = 30,
		simd_i8x16_eq = 35, simd_i8x16_lt_s = 37, simd_i8x16_gt_s = 39, simd_i8x16_gt_u = 40,
		simd_i16x8_eq = 45, simd_i16x8_gt_s = 49, simd_i16x8_gt_u = 50,
		simd_i32x4_eq = 55, simd_i32x4_ne = 56, simd_i32x4_gt_s = 59, simd_i32x4_gt_u = 60,
		simd_f32x4_eq = 65, simd_f32x4_ne = 66, simd_f32x4_lt = 67, simd_f32x4_gt = 68,
		simd_v128_not = 77, simd_v128_and = 78, simd_v128_andnot = 79, simd_v128_or = 80, simd_v128_xor = 81, simd_v128_bitselect = 82, simd_v128_any_true = 83,
		simd_i8x16_shl = 107, simd_i8x16_add = 110, simd_i8x16_sub = 113, simd_i8x16_avgr_u = 123, simd_i8x16_bitmask = 100, simd_i16x8_bitmask = 132, simd_i32x4_bitmask = 164, simd_i64x2_eq = 214,
		simd_i16x8_shl = 139, simd_i16x8_shr_s = 140, simd_i16x8_shr_u = 141, simd_i16x8_add = 142, simd_i16x8_sub = 145, simd_i16x8_mul = 149,
		simd_i32x4_shl = 171, simd_i32x4_shr_s = 172, simd_i32x4_shr_u = 173, simd_i32x4_add = 174, simd_i32x4_sub = 177, simd_i32x4_mul = 181,
		simd_i64x2_shl = 203, simd_i64x2_shr_s = 204, simd_i64x2_shr_u = 205, simd_i64x2_add = 206, simd_i64x2_sub = 209,
		simd_f32x4_add = 228, simd_f32x4_sub = 229, simd_f32x4_mul = 230, simd_i32x4_dot_i16x8_s = 186, simd_i8x16_min_u = 119, simd_i8x16_max_u = 121, simd_i8x16_popcnt = 98, simd_f32x4_max = 233, simd_f64x2_add = 240, simd_f64x2_sub = 241, simd_f64x2_mul = 242, simd_i32x4_trunc_sat_f32x4_s = 248, simd_i32x4_trunc_sat_f32x4_u = 249, simd_f32x4_convert_i32x4_s = 250, simd_f32x4_demote_f64x2_zero = 94, simd_f64x2_promote_low_f32x4 = 95,
	};

	constexpr u8 k_reverse16[16] = { 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0 };
	constexpr u8 k_high_to_low[16] = { 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23 };
	constexpr u8 k_zero16[16] = {};
}

void spu_wasm_recompiler::code::uleb(u64 v)
{
	do
	{
		u8 byte = v & 0x7f;
		v >>= 7;
		if (v) byte |= 0x80;
		b.push_back(byte);
	}
	while (v);
}

void spu_wasm_recompiler::code::sleb(s64 v)
{
	while (true)
	{
		const u8 byte = v & 0x7f;
		v >>= 7;
		if ((v == 0 && !(byte & 0x40)) || (v == -1 && (byte & 0x40)))
		{
			b.push_back(byte);
			return;
		}
		b.push_back(byte | 0x80);
	}
}

void spu_wasm_recompiler::code::bytes(const void* p, usz n)
{
	const auto s = static_cast<const u8*>(p);
	b.insert(b.end(), s, s + n);
}

void spu_wasm_recompiler::code::v128_const32(u32 a, u32 b, u32 c, u32 d)
{
	u8 v[16];
	std::memcpy(v, &a, 4);
	std::memcpy(v + 4, &b, 4);
	std::memcpy(v + 8, &c, 4);
	std::memcpy(v + 12, &d, 4);
	v128_const(v);
}

spu_wasm_recompiler::spu_wasm_recompiler() = default;
spu_wasm_recompiler::~spu_wasm_recompiler() = default;

std::vector<u8> spu_wasm_recompiler::take_module()
{
	return std::move(m_module);
}

void spu_wasm_recompiler::refuse(const std::string& why)
{
	if (m_refusal.empty())
	{
		m_refusal = fmt::format("0x%05x: %s", m_pc, why);
	}
}

// ---------------------------------------------------------------------------------------------
// Emission helpers

void spu_wasm_recompiler::gpr_load(u32 reg)
{
	m_code.local_get(l_thread);
	m_code.v128_load(off_gpr + reg * 16);
}

void spu_wasm_recompiler::gpr_store_begin()
{
	m_code.local_get(l_thread);
}

void spu_wasm_recompiler::gpr_store_end(u32 reg)
{
	m_code.v128_store(off_gpr + reg * 16);
}

void spu_wasm_recompiler::gpr_store(u32 reg)
{
	// value is on the stack: park it, push the thread pointer, then store
	m_code.local_set(l_v2);
	m_code.local_get(l_thread);
	m_code.local_get(l_v2);
	m_code.v128_store(off_gpr + reg * 16);
}

void spu_wasm_recompiler::gpr_lane3(u32 reg)
{
	m_code.local_get(l_thread);
	m_code.i32_load(off_gpr + reg * 16 + 12);
}

void spu_wasm_recompiler::splat32(u32 value)
{
	m_code.v128_const32(value, value, value, value);
}

void spu_wasm_recompiler::splat16(u32 value)
{
	const u32 v = (value & 0xffff) | (value << 16);
	m_code.v128_const32(v, v, v, v);
}

void spu_wasm_recompiler::splat8(u32 value)
{
	const u32 v = (value & 0xff) * 0x01010101u;
	m_code.v128_const32(v, v, v, v);
}

void spu_wasm_recompiler::from32r()
{
	// i32 on the stack -> v128 with the value in lane 3 (preferred slot), zeros elsewhere
	m_code.local_set(l_t2);
	m_code.v128_const(k_zero16);
	m_code.local_get(l_t2);
	m_code.simd(simd_i32x4_replace_lane);
	m_code.emit8(3);
}

void spu_wasm_recompiler::reverse16()
{
	m_code.v128_const(k_reverse16);
	m_code.simd(simd_swizzle);
}

void spu_wasm_recompiler::ls_load_reversed()
{
	// i32 LS address on the stack
	m_code.local_get(l_ls);
	m_code.op(op_i32_add);
	m_code.v128_load(0);
	reverse16();
}

void spu_wasm_recompiler::ls_store_reversed(u32 reg)
{
	// i32 LS address on the stack
	m_code.local_get(l_ls);
	m_code.op(op_i32_add);
	gpr_load(reg);
	reverse16();
	m_code.v128_store(0);
}

void spu_wasm_recompiler::store_pc(u32 pc)
{
	m_code.local_get(l_thread);
	m_code.i32c(static_cast<s32>(pc));
	m_code.i32_store(off_pc);
}

void spu_wasm_recompiler::store_pc_local()
{
	m_code.local_get(l_thread);
	m_code.local_get(l_pc);
	m_code.i32_store(off_pc);
}

void spu_wasm_recompiler::exit_program()
{
	store_pc_local();
	m_code.br(m_exit_depth + m_depth);
}

void spu_wasm_recompiler::branch_to(u32 target)
{
	target &= 0x3fffc;
	if (target >= m_lower && target < m_upper && m_is_block_start[(target - m_lower) / 4])
	{
		m_code.i32c(static_cast<s32>(target));
		m_code.local_set(l_pc);
		m_code.br(m_loop_depth + m_depth);
		return;
	}
	store_pc(target);
	m_code.br(m_exit_depth + m_depth);
}

void spu_wasm_recompiler::branch_dynamic()
{
	// i32 target on the stack; the dispatch loop decides whether it is one of ours
	m_code.i32c(0x3fffc);
	m_code.op(op_i32_and);
	m_code.local_set(l_pc);
	m_code.br(m_loop_depth + m_depth);
}

void spu_wasm_recompiler::bail_to_interpreter()
{
	// The interpreter executes this instruction (halts, stops, interrupt state changes)
	store_pc(m_pc);
	m_code.br(m_exit_depth + m_depth);
}

void spu_wasm_recompiler::state_test(u32 next_pc)
{
	// After a helper that may have changed the thread state: pc must point past the
	// instruction before check_state, which may stop the thread and resume it there
	store_pc(next_pc);
	m_code.local_get(l_thread);
	m_code.call(f_check_state);
	m_code.if_void();
	m_code.local_get(l_thread);
	m_code.call(f_escape);
	m_code.op(op_unreachable);
	m_code.end();
}

void spu_wasm_recompiler::per_lane32(auto&& emit_scalar)
{
	// The operands' v128 values are expected in l_v0 (ra) and l_v1 (rb); builds the result in l_v2
	m_code.local_get(l_v0);
	m_code.local_set(l_v2);
	for (u32 lane = 0; lane < 4; lane++)
	{
		m_code.local_get(l_v2);
		emit_scalar(lane); // pushes the i32 result of this lane
		m_code.simd(simd_i32x4_replace_lane);
		m_code.emit8(lane);
		m_code.local_set(l_v2);
	}
	m_code.local_get(l_v2);
}

// ---------------------------------------------------------------------------------------------
// Program compilation

bool spu_wasm_recompiler::build(const spu_program& func)
{
	m_module.clear();
	m_refusal.clear();
	m_export_name.clear();
	m_code.b.clear();

	m_lower = func.lower_bound;
	m_upper = func.lower_bound + ::size32(func.data) * 4;
	const u32 entry = func.entry_point;
	const u32 words = ::size32(func.data);
	if (!words || entry < m_lower || entry >= m_upper)
	{
		m_refusal = "empty program";
		return false;
	}

	// Block starts within the program: the analyser's block info plus the entry
	m_is_block_start.assign(words, false);
	m_is_block_start[(entry - m_lower) / 4] = true;
	for (u32 i = 0; i < words; i++)
	{
		if (m_block_info[(m_lower + i * 4) / 4]) m_is_block_start[i] = true;
	}
	std::vector<u32> starts;
	for (u32 i = 0; i < words; i++)
	{
		if (m_is_block_start[i] && func.data[i]) starts.push_back(i);
	}
	const u32 block_count = ::size32(starts);

	// --- function body ---
	code& c = m_code;

	// state check: escape when the thread has state flags
	c.local_get(l_thread);
	c.i32_load(off_state);
	c.if_void();
	c.local_get(l_thread);
	c.call(f_escape);
	c.op(op_unreachable);
	c.end();

	// verification: the local store must hold this program's words (relative to the pc at dispatch)
	c.local_get(l_thread);
	c.i32_load(off_pc);
	c.local_tee(l_pc);
	c.i32c(static_cast<s32>(m_lower) - static_cast<s32>(entry));
	c.op(op_i32_add);
	c.local_get(l_ls);
	c.op(op_i32_add);
	c.local_set(l_t0); // host address of the program's first word
	c.block_void();    // $verify_ok
	c.block_void();    // $verify_fail
	for (u32 i = 0; i < words;)
	{
		// four consecutive non-hole words compare as one v128
		if (i + 4 <= words && func.data[i] && func.data[i + 1] && func.data[i + 2] && func.data[i + 3])
		{
			c.local_get(l_t0);
			c.v128_load(i * 4);
			c.v128_const32(func.data[i], func.data[i + 1], func.data[i + 2], func.data[i + 3]);
			c.simd(simd_i32x4_ne);
			c.simd(simd_v128_any_true);
			c.br_if(0);
			i += 4;
			continue;
		}
		if (func.data[i])
		{
			c.local_get(l_t0);
			c.i32_load(i * 4);
			c.i32c(static_cast<s32>(func.data[i]));
			c.op(op_i32_ne);
			c.br_if(0);
		}
		i++;
	}
	c.br(1); // verified
	c.end(); // $verify_fail
	c.local_get(l_thread);
	c.local_get(l_thread);
	c.i64_load(off_block_failure);
	c.i64c(1);
	c.op(op_i64_add);
	c.i64_store(off_block_failure);
	c.local_get(l_thread);
	c.local_get(l_ls);
	c.local_get(l_arg2);
	c.call(f_dispatch);
	c.ret();
	c.end(); // $verify_ok

	// dispatch: block $exit { loop $loop { block $bN-1 { ... block $b0 { br_table } b0 code } b1 code ... } }
	c.block_void(); // $exit
	c.loop_void();  // $loop
	for (u32 k = 0; k < block_count; k++) c.block_void();
	// publish pc: a target outside the program leaves through the default label with pc set
	c.local_get(l_thread);
	c.local_get(l_pc);
	c.i32_store(off_pc);
	// br_table indexed by (pc - lower) / 4
	c.local_get(l_pc);
	c.i32c(static_cast<s32>(m_lower));
	c.op(op_i32_sub);
	c.i32c(2);
	c.op(op_i32_shr_u);
	c.op(0x0e); // br_table
	c.uleb(words);
	for (u32 i = 0; i < words; i++)
	{
		u32 label = block_count + 1; // default: leave the program ($exit is outside the loop)
		for (u32 k = 0; k < block_count; k++)
		{
			if (starts[k] == i)
			{
				label = k;
				break;
			}
		}
		c.uleb(label);
	}
	c.uleb(block_count + 1);

	// blocks in address order; falling off the end of one continues into the next
	for (u32 k = 0; k < block_count && !refused(); k++)
	{
		c.end(); // closes $bk: block k's code starts here
		m_depth = 0;
		m_loop_depth = block_count - 1 - k;
		m_exit_depth = block_count - k;
		const u32 first = starts[k];
		const u32 last = k + 1 < block_count ? starts[k + 1] : words;
		for (u32 i = first; i < last && !refused(); i++)
		{
			m_pc = m_lower + i * 4;
			if (!func.data[i])
			{
				// hole: leaving the program here is the safe interpretation
				store_pc(m_pc);
				c.br(m_exit_depth);
				break;
			}
			const spu_opcode_t op{ std::bit_cast<be_t<u32>>(func.data[i]) };
			(this->*s_decoder.decode(op.opcode))(op);
		}
		if (k + 1 == block_count)
		{
			// end of the program range
			store_pc(m_upper);
			c.br(m_exit_depth);
		}
	}
	c.end(); // $loop
	c.end(); // $exit
	c.ret();
	c.end(); // function

	if (refused())
	{
		return false;
	}

	// --- module ---
	u64 hash = 0xcbf29ce484222325ull;
	for (const u32 word : func.data) hash = (hash ^ word) * 0x100000001b3ull;
	m_export_name = fmt::format("__spu-0x%05x-w%016llx", entry, hash);

	code m;
	m.bytes("\0asm\x01\0\0\0", 8);
	auto section = [&](u32 id, const code& payload)
	{
		m.emit8(id);
		m.uleb(payload.b.size());
		m.bytes(payload.b.data(), payload.b.size());
	};
	// types: 0 (i32,i32,i64)->() 1 (i32)->() 2 (i32)->i32 3 (i32,i32)->i32 4 (i32,i32,i32)->() 5 (i32,i32)->() 6 ()->i64
	{
		code t;
		t.uleb(7);
		auto ft = [&](std::initializer_list<u8> params, std::initializer_list<u8> results)
		{
			t.emit8(0x60);
			t.uleb(params.size());
			for (u8 p : params) t.emit8(p);
			t.uleb(results.size());
			for (u8 r : results) t.emit8(r);
		};
		ft({ 0x7f, 0x7f, 0x7e }, {});
		ft({ 0x7f }, {});
		ft({ 0x7f }, { 0x7f });
		ft({ 0x7f, 0x7f }, { 0x7f });
		ft({ 0x7f, 0x7f, 0x7f }, {});
		ft({ 0x7f, 0x7f }, {});
		ft({}, { 0x7e });
		section(1, t);
	}
	{
		code im;
		const std::pair<const char*, u32> imports[] =
		{
			{ "spu_escape", 1 }, { "spu_dispatch", 0 }, { "spu_exec_check_state", 2 }, { "spu_read_channel", 3 }, { "spu_read_channel_count", 3 },
			{ "spu_write_channel", 4 }, { "spu_exec_mfc_cmd", 1 }, { "spu_check_interrupts", 3 }, { "spu_syscall", 5 }, { "spu_unknown", 5 },
			{ "spu_web_fatal", 5 }, { "spu_read_in_mbox", 2 }, { "spu_read_decrementer", 2 }, { "spu_read_events", 2 }, { "spu_get_events", 3 },
			{ "spu_list_unstall", 5 }, { "get_timebased_time", 6 },
		};
		static_assert(std::size(imports) == f_import_count);
		im.uleb(std::size(imports) + 1);
		for (const auto& [name, type] : imports)
		{
			im.uleb(3); im.bytes("env", 3);
			im.uleb(std::strlen(name)); im.bytes(name, std::strlen(name));
			im.emit8(0x00); im.uleb(type);
		}
		im.uleb(3); im.bytes("env", 3);
		im.uleb(6); im.bytes("memory", 6);
		im.emit8(0x02); im.emit8(0x03); im.uleb(0); im.uleb(65536); // shared, any size up to 4 GiB
		section(2, im);
	}
	{
		code f;
		f.uleb(1);
		f.uleb(0);
		section(3, f);
	}
	{
		code e;
		e.uleb(1);
		e.uleb(m_export_name.size()); e.bytes(m_export_name.data(), m_export_name.size());
		e.emit8(0x00); e.uleb(f_import_count);
		section(7, e);
	}
	{
		code body;
		body.uleb(3);                  // local groups
		body.uleb(4); body.emit8(0x7f);   // pc, t0, t1, t2
		body.uleb(4); body.emit8(0x7b);   // v0, v1, v2, v3
		body.uleb(1); body.emit8(0x7e);   // i64 scratch
		body.bytes(m_code.b.data(), m_code.b.size());
		code cs;
		cs.uleb(1);
		cs.uleb(body.b.size());
		cs.bytes(body.b.data(), body.b.size());
		section(10, cs);
	}
	m_module = std::move(m.b);
	return true;
}

std::vector<u8> spu_web_compile_ls(const be_t<u32>* ls, u32 pc, std::string& export_name, u32& entry, std::string& why)
{
	thread_local std::unique_ptr<spu_wasm_recompiler> compiler;
	if (!compiler) compiler = std::make_unique<spu_wasm_recompiler>();
	spu_program program = compiler->analyse(ls, pc & 0x3fffc);
	if (program.data.empty())
	{
		why = "analyser produced no program";
		return {};
	}
	entry = program.entry_point;
	compiler->compile(std::move(program));
	why = compiler->last_refusal();
	export_name = compiler->last_export_name();
	return compiler->take_module();
}

// ---------------------------------------------------------------------------------------------
// Instructions. Register layout: 16-byte-reversed quadword, preferred slot in lane 3.

#define REFUSE(name) void spu_wasm_recompiler::name(spu_opcode_t) { refuse(#name); }

void spu_wasm_recompiler::UNK(spu_opcode_t op) { refuse(fmt::format("unknown opcode 0x%08x", op.opcode)); }

// No-ops and hints
void spu_wasm_recompiler::NOP(spu_opcode_t) {}
void spu_wasm_recompiler::LNOP(spu_opcode_t) {}
void spu_wasm_recompiler::HBR(spu_opcode_t) {}
void spu_wasm_recompiler::HBRA(spu_opcode_t) {}
void spu_wasm_recompiler::HBRR(spu_opcode_t) {}

// Rare control instructions: the interpreter executes them
void spu_wasm_recompiler::STOP(spu_opcode_t) { bail_to_interpreter(); }
void spu_wasm_recompiler::STOPD(spu_opcode_t) { bail_to_interpreter(); }
void spu_wasm_recompiler::SYNC(spu_opcode_t) { bail_to_interpreter(); }
void spu_wasm_recompiler::DSYNC(spu_opcode_t) { bail_to_interpreter(); }
void spu_wasm_recompiler::MFSPR(spu_opcode_t op) { m_code.v128_const(k_zero16); gpr_store(op.rt); } // all SPRs read as zero
void spu_wasm_recompiler::MTSPR(spu_opcode_t) { bail_to_interpreter(); }
void spu_wasm_recompiler::IRET(spu_opcode_t) { bail_to_interpreter(); }
void spu_wasm_recompiler::BISLED(spu_opcode_t) { bail_to_interpreter(); }
void spu_wasm_recompiler::FSCRRD(spu_opcode_t op) { m_code.v128_const(k_zero16); gpr_store(op.rt); }
void spu_wasm_recompiler::FSCRWR(spu_opcode_t) { bail_to_interpreter(); }

// Immediates
void spu_wasm_recompiler::IL(spu_opcode_t op) { splat32(op.si16); gpr_store(op.rt); }
void spu_wasm_recompiler::ILHU(spu_opcode_t op) { splat32(op.i16 << 16); gpr_store(op.rt); }
void spu_wasm_recompiler::ILH(spu_opcode_t op) { splat16(op.i16); gpr_store(op.rt); }
void spu_wasm_recompiler::ILA(spu_opcode_t op) { splat32(op.i18); gpr_store(op.rt); }
void spu_wasm_recompiler::IOHL(spu_opcode_t op) { gpr_load(op.rt); splat32(op.i16); m_code.simd(simd_v128_or); gpr_store(op.rt); }

void spu_wasm_recompiler::FSMBI(spu_opcode_t op)
{
	u8 v[16];
	for (u32 i = 0; i < 16; i++) v[i] = (op.i16 >> i) & 1 ? 0xff : 0;
	m_code.v128_const(v);
	gpr_store(op.rt);
}

// Loads and stores
void spu_wasm_recompiler::LQD(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	m_code.i32c(op.si10 * 16);
	m_code.op(op_i32_add);
	m_code.i32c(0x3fff0);
	m_code.op(op_i32_and);
	ls_load_reversed();
	gpr_store(op.rt);
}

void spu_wasm_recompiler::LQX(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	gpr_lane3(op.rb);
	m_code.op(op_i32_add);
	m_code.i32c(0x3fff0);
	m_code.op(op_i32_and);
	ls_load_reversed();
	gpr_store(op.rt);
}

void spu_wasm_recompiler::LQA(spu_opcode_t op)
{
	m_code.i32c(static_cast<s32>(spu_ls_target(0, op.i16)));
	ls_load_reversed();
	gpr_store(op.rt);
}

void spu_wasm_recompiler::LQR(spu_opcode_t op)
{
	m_code.i32c(static_cast<s32>(spu_ls_target(m_pc, op.i16)));
	ls_load_reversed();
	gpr_store(op.rt);
}

void spu_wasm_recompiler::STQD(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	m_code.i32c(op.si10 * 16);
	m_code.op(op_i32_add);
	m_code.i32c(0x3fff0);
	m_code.op(op_i32_and);
	ls_store_reversed(op.rt);
}

void spu_wasm_recompiler::STQX(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	gpr_lane3(op.rb);
	m_code.op(op_i32_add);
	m_code.i32c(0x3fff0);
	m_code.op(op_i32_and);
	ls_store_reversed(op.rt);
}

void spu_wasm_recompiler::STQA(spu_opcode_t op)
{
	m_code.i32c(static_cast<s32>(spu_ls_target(0, op.i16)));
	ls_store_reversed(op.rt);
}

void spu_wasm_recompiler::STQR(spu_opcode_t op)
{
	m_code.i32c(static_cast<s32>(spu_ls_target(m_pc, op.i16)));
	ls_store_reversed(op.rt);
}

// Integer arithmetic
#define BINARY_V(name, opcode, first, second) \
	void spu_wasm_recompiler::name(spu_opcode_t op) { gpr_load(op.first); gpr_load(op.second); m_code.simd(opcode); gpr_store(op.rt); }
#define BINARY_IMM32(name, opcode, imm_first) \
	void spu_wasm_recompiler::name(spu_opcode_t op) { if (imm_first) { splat32(op.si10); gpr_load(op.ra); } else { gpr_load(op.ra); splat32(op.si10); } m_code.simd(opcode); gpr_store(op.rt); }
#define BINARY_IMM16(name, opcode, imm_first) \
	void spu_wasm_recompiler::name(spu_opcode_t op) { if (imm_first) { splat16(op.si10); gpr_load(op.ra); } else { gpr_load(op.ra); splat16(op.si10); } m_code.simd(opcode); gpr_store(op.rt); }

BINARY_V(A, simd_i32x4_add, ra, rb)
BINARY_V(AH, simd_i16x8_add, ra, rb)
BINARY_V(SF, simd_i32x4_sub, rb, ra)
BINARY_V(SFH, simd_i16x8_sub, rb, ra)
BINARY_V(AND, simd_v128_and, ra, rb)
BINARY_V(OR, simd_v128_or, ra, rb)
BINARY_V(XOR, simd_v128_xor, ra, rb)
BINARY_V(ANDC, simd_v128_andnot, ra, rb)
BINARY_V(CEQ, simd_i32x4_eq, ra, rb)
BINARY_V(CEQH, simd_i16x8_eq, ra, rb)
BINARY_V(CEQB, simd_i8x16_eq, ra, rb)
BINARY_V(CGT, simd_i32x4_gt_s, ra, rb)
BINARY_V(CGTH, simd_i16x8_gt_s, ra, rb)
BINARY_V(CGTB, simd_i8x16_gt_s, ra, rb)
BINARY_V(CLGT, simd_i32x4_gt_u, ra, rb)
BINARY_V(CLGTH, simd_i16x8_gt_u, ra, rb)
BINARY_V(CLGTB, simd_i8x16_gt_u, ra, rb)
BINARY_IMM32(AI, simd_i32x4_add, true)
BINARY_IMM16(AHI, simd_i16x8_add, true)
BINARY_IMM32(SFI, simd_i32x4_sub, true)
BINARY_IMM16(SFHI, simd_i16x8_sub, true)
BINARY_IMM32(ANDI, simd_v128_and, false)
BINARY_IMM16(ANDHI, simd_v128_and, false)
BINARY_IMM32(ORI, simd_v128_or, false)
BINARY_IMM16(ORHI, simd_v128_or, false)
BINARY_IMM32(XORI, simd_v128_xor, false)
BINARY_IMM16(XORHI, simd_v128_xor, false)
BINARY_IMM32(CEQI, simd_i32x4_eq, false)
BINARY_IMM16(CEQHI, simd_i16x8_eq, false)
BINARY_IMM32(CGTI, simd_i32x4_gt_s, false)
BINARY_IMM16(CGTHI, simd_i16x8_gt_s, false)
BINARY_IMM32(CLGTI, simd_i32x4_gt_u, false)
BINARY_IMM16(CLGTHI, simd_i16x8_gt_u, false)

void spu_wasm_recompiler::ANDBI(spu_opcode_t op) { gpr_load(op.ra); splat8(op.i8); m_code.simd(simd_v128_and); gpr_store(op.rt); }
void spu_wasm_recompiler::ORBI(spu_opcode_t op) { gpr_load(op.ra); splat8(op.i8); m_code.simd(simd_v128_or); gpr_store(op.rt); }
void spu_wasm_recompiler::XORBI(spu_opcode_t op) { gpr_load(op.ra); splat8(op.i8); m_code.simd(simd_v128_xor); gpr_store(op.rt); }
void spu_wasm_recompiler::CEQBI(spu_opcode_t op) { gpr_load(op.ra); splat8(op.i8); m_code.simd(simd_i8x16_eq); gpr_store(op.rt); }
void spu_wasm_recompiler::CGTBI(spu_opcode_t op) { gpr_load(op.ra); splat8(op.i8); m_code.simd(simd_i8x16_gt_s); gpr_store(op.rt); }
void spu_wasm_recompiler::CLGTBI(spu_opcode_t op) { gpr_load(op.ra); splat8(op.i8); m_code.simd(simd_i8x16_gt_u); gpr_store(op.rt); }

void spu_wasm_recompiler::NOR(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_v128_or); m_code.simd(simd_v128_not); gpr_store(op.rt); }
void spu_wasm_recompiler::NAND(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_v128_and); m_code.simd(simd_v128_not); gpr_store(op.rt); }
void spu_wasm_recompiler::ORC(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_v128_not); m_code.simd(simd_v128_or); gpr_store(op.rt); }
void spu_wasm_recompiler::EQV(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_v128_xor); m_code.simd(simd_v128_not); gpr_store(op.rt); }

void spu_wasm_recompiler::SELB(spu_opcode_t op)
{
	// (rc & rb) | (~rc & ra) = bitselect(rb, ra, rc)
	gpr_load(op.rb);
	gpr_load(op.ra);
	gpr_load(op.rc);
	m_code.simd(simd_v128_bitselect);
	gpr_store(op.rt4);
}

void spu_wasm_recompiler::SHUFB(spu_opcode_t op)
{
	// x = ~c & 0x1f; bytes from {rb (0..15), ra (16..31)}; then c's special selectors
	gpr_load(op.rc);
	m_code.local_set(l_v0);
	gpr_load(op.rb);
	m_code.local_get(l_v0);
	m_code.simd(simd_v128_not);
	splat8(0x1f);
	m_code.simd(simd_v128_and);
	m_code.local_tee(l_v1);        // x
	m_code.simd(simd_swizzle);     // rb bytes for x < 16, zero otherwise
	gpr_load(op.ra);
	m_code.local_get(l_v1);
	splat8(16);
	m_code.simd(simd_i8x16_sub);   // x - 16 (wraps out of range for x < 16)
	m_code.simd(simd_swizzle);
	m_code.simd(simd_v128_or);
	m_code.local_set(l_v2);        // res
	// cmp0: c < 0 (top bit); cmp1: (c & 0xc0) == 0xc0; cmp2: (c & 0xe0) == 0xc0
	m_code.local_get(l_v0);
	splat8(0xc0);
	m_code.simd(simd_v128_and);
	splat8(0xc0);
	m_code.simd(simd_i8x16_eq);
	m_code.local_get(l_v0);
	splat8(0xe0);
	m_code.simd(simd_v128_and);
	splat8(0xc0);
	m_code.simd(simd_i8x16_eq);
	m_code.simd(simd_i8x16_avgr_u); // special values
	m_code.local_get(l_v2);
	m_code.v128_const(k_zero16);
	m_code.local_get(l_v0);
	m_code.simd(simd_i8x16_gt_s);   // cmp0 (0 > c)
	m_code.simd(simd_v128_andnot);  // res & ~cmp0
	m_code.simd(simd_v128_or);
	gpr_store(op.rt4);
}

// Generate-controls-for-insertion: base mask with the element t replaced (branch free through bitselect)
static constexpr u8 k_iota8[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
static constexpr u8 k_iota16[16] = { 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0 };
static constexpr u8 k_iota64[16] = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0 };

void spu_wasm_recompiler::insertion_mask(u32 width_log2)
{
	// i32 t (element index) on the stack
	m_code.local_set(l_t0);
	// v128::from64(0x18191A1B1C1D1E1F, 0x1011121314151617): the first argument is the low qword
	m_code.v128_const32(0x1c1d1e1f, 0x18191a1b, 0x14151617, 0x10111213); // base
	switch (width_log2)
	{
	case 0: splat8(0x03); m_code.v128_const(k_iota8); m_code.local_get(l_t0); m_code.simd(simd_i8x16_splat); m_code.simd(simd_i8x16_eq); break;
	case 1: splat16(0x0203); m_code.v128_const(k_iota16); m_code.local_get(l_t0); m_code.simd(simd_i16x8_splat); m_code.simd(simd_i16x8_eq); break;
	case 2: splat32(0x00010203); m_code.v128_const32(0, 1, 2, 3); m_code.local_get(l_t0); m_code.simd(simd_i32x4_splat); m_code.simd(simd_i32x4_eq); break;
	default: m_code.v128_const32(0x04050607, 0x00010203, 0x04050607, 0x00010203); m_code.v128_const(k_iota64); m_code.local_get(l_t0); m_code.op(op_i64_extend_i32_u); m_code.simd(simd_i64x2_splat); m_code.simd(simd_i64x2_eq); break;
	}
	// stack: base, special, mask -> bitselect(special, base, mask)? bitselect(v1, v2, c) = (v1 & c) | (v2 & ~c): want special where mask
	// reorder: we pushed base first; rebuild as (special, base, mask)
	m_code.local_set(l_v0); // mask
	m_code.local_set(l_v1); // special
	m_code.local_set(l_v2); // base
	m_code.local_get(l_v1);
	m_code.local_get(l_v2);
	m_code.local_get(l_v0);
	m_code.simd(simd_v128_bitselect);
}

void spu_wasm_recompiler::cxd_index(spu_opcode_t op, bool x_form, u32 mask, u32 shift)
{
	// t = (~(index + ra.lane3) & mask) >> shift with index = i7 (D forms) or rb.lane3 (X forms)
	gpr_lane3(op.ra);
	if (x_form) gpr_lane3(op.rb); else m_code.i32c(static_cast<s32>(op.i7));
	m_code.op(op_i32_add);
	m_code.i32c(-1);
	m_code.op(op_i32_xor);
	m_code.i32c(static_cast<s32>(mask));
	m_code.op(op_i32_and);
	if (shift) { m_code.i32c(shift); m_code.op(op_i32_shr_u); }
}

void spu_wasm_recompiler::CBD(spu_opcode_t op) { cxd_index(op, false, 0xf, 0); insertion_mask(0); gpr_store(op.rt); }
void spu_wasm_recompiler::CHD(spu_opcode_t op) { cxd_index(op, false, 0xe, 1); insertion_mask(1); gpr_store(op.rt); }
void spu_wasm_recompiler::CWD(spu_opcode_t op) { cxd_index(op, false, 0xc, 2); insertion_mask(2); gpr_store(op.rt); }
void spu_wasm_recompiler::CDD(spu_opcode_t op) { cxd_index(op, false, 0x8, 3); insertion_mask(3); gpr_store(op.rt); }
void spu_wasm_recompiler::CBX(spu_opcode_t op) { cxd_index(op, true, 0xf, 0); insertion_mask(0); gpr_store(op.rt); }
void spu_wasm_recompiler::CHX(spu_opcode_t op) { cxd_index(op, true, 0xe, 1); insertion_mask(1); gpr_store(op.rt); }
void spu_wasm_recompiler::CWX(spu_opcode_t op) { cxd_index(op, true, 0xc, 2); insertion_mask(2); gpr_store(op.rt); }
void spu_wasm_recompiler::CDX(spu_opcode_t op) { cxd_index(op, true, 0x8, 3); insertion_mask(3); gpr_store(op.rt); }

// Shifts and rotates
void spu_wasm_recompiler::SHLI(spu_opcode_t op)
{
	const u32 n = op.i7 & 0x3f;
	if (n >= 32)
	{
		m_code.v128_const(k_zero16);
	}
	else
	{
		gpr_load(op.ra);
		m_code.i32c(n);
		m_code.simd(simd_i32x4_shl);
	}
	gpr_store(op.rt);
}

void spu_wasm_recompiler::SHLHI(spu_opcode_t op)
{
	const u32 n = op.i7 & 0x1f;
	if (n >= 16)
	{
		m_code.v128_const(k_zero16);
	}
	else
	{
		gpr_load(op.ra);
		m_code.i32c(n);
		m_code.simd(simd_i16x8_shl);
	}
	gpr_store(op.rt);
}

void spu_wasm_recompiler::SHL(spu_opcode_t op)
{
	// per lane: u32(u64(a) << (b & 0x3f))
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i64_extend_i32_u);
		m_code.local_get(l_v1); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.i32c(0x3f); m_code.op(op_i32_and); m_code.op(op_i64_extend_i32_u);
		m_code.op(op_i64_shl);
		m_code.op(op_i32_wrap_i64);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTMA(spu_opcode_t op)
{
	// per lane: s32(s64(a) >> ((0 - b) & 0x3f))
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i64_extend_i32_s);
		m_code.i32c(0); m_code.local_get(l_v1); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i32_sub); m_code.i32c(0x3f); m_code.op(op_i32_and); m_code.op(op_i64_extend_i32_u);
		m_code.op(op_i64_shr_s);
		m_code.op(op_i32_wrap_i64);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::CLZ(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i32_clz);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::XSBH(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(8); m_code.simd(simd_i16x8_shl); m_code.i32c(8); m_code.simd(simd_i16x8_shr_s); gpr_store(op.rt);
}

void spu_wasm_recompiler::XSHW(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(16); m_code.simd(simd_i32x4_shl); m_code.i32c(16); m_code.simd(simd_i32x4_shr_s); gpr_store(op.rt);
}

void spu_wasm_recompiler::XSWD(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(32); m_code.simd(simd_i64x2_shl); m_code.i32c(32); m_code.simd(simd_i64x2_shr_s); gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTQBYI(spu_opcode_t op)
{
	// byte i <- a[(i - s) & 15]
	const u32 s = op.i7 & 0xf;
	u8 idx[16];
	for (u32 i = 0; i < 16; i++) idx[i] = (i - s) & 15;
	gpr_load(op.ra);
	m_code.v128_const(idx);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTQBY(spu_opcode_t op)
{
	// idx[i] = (i - (rb.lane3 & 15)) & 15
	static constexpr u8 iota[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
	gpr_load(op.ra);
	m_code.v128_const(iota);
	gpr_lane3(op.rb);
	m_code.simd(simd_i8x16_splat);
	m_code.simd(simd_i8x16_sub);
	splat8(15);
	m_code.simd(simd_v128_and);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::SHLQBYI(spu_opcode_t op)
{
	// byte i <- (i >= s) ? a[i - s] : 0 for s < 32 (out-of-range swizzle indices read as zero)
	const u32 s = op.i7 & 0x1f;
	u8 idx[16];
	for (u32 i = 0; i < 16; i++) idx[i] = i >= s ? static_cast<u8>(i - s) : 0x80;
	gpr_load(op.ra);
	m_code.v128_const(idx);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTQMBII(spu_opcode_t op)
{
	// n = (0 - i7) & 7: lanes as u64: lo = (a.lo >> n) | (a.hi << (64 - n)); hi = a.hi >> n
	const u32 n = (0 - op.i7) & 7;
	if (n == 0)
	{
		gpr_load(op.ra);
		gpr_store(op.rt);
		return;
	}
	gpr_load(op.ra);
	m_code.local_tee(l_v0);
	m_code.i32c(n);
	m_code.simd(simd_i64x2_shr_u);
	m_code.local_get(l_v0);
	m_code.v128_const(k_zero16);
	m_code.shuffle(k_high_to_low);
	m_code.i32c(64 - n);
	m_code.simd(simd_i64x2_shl);
	m_code.simd(simd_v128_or);
	gpr_store(op.rt);
}

// Branches
void spu_wasm_recompiler::BR(spu_opcode_t op) { branch_to(spu_branch_target(m_pc, op.i16)); }
void spu_wasm_recompiler::BRA(spu_opcode_t op) { branch_to(spu_branch_target(0, op.i16)); }

void spu_wasm_recompiler::BRSL(spu_opcode_t op)
{
	m_code.i32c(static_cast<s32>(spu_branch_target(m_pc + 4)));
	from32r();
	gpr_store(op.rt);
	branch_to(spu_branch_target(m_pc, op.i16));
}

void spu_wasm_recompiler::BRASL(spu_opcode_t op)
{
	m_code.i32c(static_cast<s32>(spu_branch_target(m_pc + 4)));
	from32r();
	gpr_store(op.rt);
	branch_to(spu_branch_target(0, op.i16));
}

void spu_wasm_recompiler::BRZ(spu_opcode_t op)
{
	gpr_lane3(op.rt);
	m_code.op(op_i32_eqz);
	m_code.if_void();
	m_depth++;
	branch_to(spu_branch_target(m_pc, op.i16));
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::BRNZ(spu_opcode_t op)
{
	gpr_lane3(op.rt);
	m_code.if_void();
	m_depth++;
	branch_to(spu_branch_target(m_pc, op.i16));
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::BRHZ(spu_opcode_t op)
{
	m_code.local_get(l_thread);
	m_code.i32_load(off_gpr + op.rt * 16 + 12);
	m_code.i32c(0xffff);
	m_code.op(op_i32_and);
	m_code.op(op_i32_eqz);
	m_code.if_void();
	m_depth++;
	branch_to(spu_branch_target(m_pc, op.i16));
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::BRHNZ(spu_opcode_t op)
{
	m_code.local_get(l_thread);
	m_code.i32_load(off_gpr + op.rt * 16 + 12);
	m_code.i32c(0xffff);
	m_code.op(op_i32_and);
	m_code.if_void();
	m_depth++;
	branch_to(spu_branch_target(m_pc, op.i16));
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::BI(spu_opcode_t op)
{
	if (op.de)
	{
		bail_to_interpreter(); // interrupt state change
		return;
	}
	gpr_lane3(op.ra);
	branch_dynamic();
}

void spu_wasm_recompiler::BISL(spu_opcode_t op)
{
	if (op.de)
	{
		bail_to_interpreter();
		return;
	}
	gpr_lane3(op.ra);
	m_code.local_set(l_t0);
	m_code.i32c(static_cast<s32>(spu_branch_target(m_pc + 4)));
	from32r();
	gpr_store(op.rt);
	m_code.local_get(l_t0);
	branch_dynamic();
}


// Halts: the interpreter performs the halt when the condition holds
void spu_wasm_recompiler::HEQI(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	m_code.i32c(op.si10);
	m_code.op(op_i32_eq);
	m_code.if_void();
	m_depth++;
	bail_to_interpreter();
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::HGTI(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	m_code.i32c(op.si10);
	m_code.op(op_i32_gt_s);
	m_code.if_void();
	m_depth++;
	bail_to_interpreter();
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::HLGTI(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	m_code.i32c(op.si10);
	m_code.op(op_i32_gt_u);
	m_code.if_void();
	m_depth++;
	bail_to_interpreter();
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::HEQ(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	gpr_lane3(op.rb);
	m_code.op(op_i32_eq);
	m_code.if_void();
	m_depth++;
	bail_to_interpreter();
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::HGT(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	gpr_lane3(op.rb);
	m_code.op(op_i32_gt_s);
	m_code.if_void();
	m_depth++;
	bail_to_interpreter();
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::HLGT(spu_opcode_t op)
{
	gpr_lane3(op.ra);
	gpr_lane3(op.rb);
	m_code.op(op_i32_gt_u);
	m_code.if_void();
	m_depth++;
	bail_to_interpreter();
	m_depth--;
	m_code.end();
}

// Channels
void spu_wasm_recompiler::RDCH(spu_opcode_t op)
{
	store_pc(m_pc); // the helper escapes to the interpreter loop when the read would block
	m_code.local_get(l_thread);
	m_code.i32c(op.ra);
	m_code.call(f_read_channel);
	from32r();
	gpr_store(op.rt);
	state_test(m_pc + 4);
}

void spu_wasm_recompiler::RCHCNT(spu_opcode_t op)
{
	m_code.local_get(l_thread);
	m_code.i32c(op.ra);
	m_code.call(f_read_channel_count);
	from32r();
	gpr_store(op.rt);
}

void spu_wasm_recompiler::WRCH(spu_opcode_t op)
{
	store_pc(m_pc);
	m_code.local_get(l_thread);
	m_code.i32c(op.ra);
	gpr_lane3(op.rt);
	m_code.call(f_write_channel);
	state_test(m_pc + 4);
}

// Floating point (SPU single precision has no denormals; NaN results are sign-only extended values)
void spu_wasm_recompiler::FM(spu_opcode_t op)
{
	// denormal operand mask: exponent bits of a or b all zero
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	// primary = a * b
	m_code.local_get(l_v0); m_code.local_get(l_v1); m_code.simd(simd_f32x4_mul); m_code.local_set(l_v2);
	// denorm_operand_mask = ((a & exp) == 0) | ((b & exp) == 0)   [f32 compare against 0.0 with sign-agnostic zero: use integer eq]
	m_code.local_get(l_v0); splat32(0x7f800000); m_code.simd(simd_v128_and); m_code.v128_const(k_zero16); m_code.simd(simd_i32x4_eq);
	m_code.local_get(l_v1); splat32(0x7f800000); m_code.simd(simd_v128_and); m_code.v128_const(k_zero16); m_code.simd(simd_i32x4_eq);
	m_code.simd(simd_v128_or);
	m_code.local_set(l_v0); // v0 = denorm_operand_mask
	// flushed = primary & ~(denorm_result_mask | denorm_operand_mask); denorm_result_mask = (primary & exp) == 0
	m_code.local_get(l_v2);
	m_code.local_get(l_v2); splat32(0x7f800000); m_code.simd(simd_v128_and); m_code.v128_const(k_zero16); m_code.simd(simd_i32x4_eq);
	m_code.local_get(l_v0); m_code.simd(simd_v128_or);
	m_code.simd(simd_v128_andnot);
	m_code.local_set(l_v1); // v1 = flushed
	// nan_check = (primary & exp) == exp
	m_code.local_get(l_v2); splat32(0x7f800000); m_code.simd(simd_v128_and); splat32(0x7f800000); m_code.simd(simd_i32x4_eq);
	m_code.local_set(l_v2); // v2 = nan_check (primary no longer needed except for extended)
	// extended = (sign(a) ^ sign(b)) | (primary & ~sign); primary = a * b recomputed
	gpr_load(op.ra); splat32(0x80000000); m_code.simd(simd_v128_and);
	gpr_load(op.rb); splat32(0x80000000); m_code.simd(simd_v128_and);
	m_code.simd(simd_v128_xor);
	gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f32x4_mul); splat32(0x80000000); m_code.simd(simd_v128_andnot);
	m_code.simd(simd_v128_or);
	m_code.local_get(l_v0); m_code.simd(simd_v128_andnot); // final_extended = extended & ~denorm_operand_mask
	// result = (flushed & ~nan) | (final_extended & nan) = bitselect(final_extended, flushed, nan)
	m_code.local_get(l_v1);
	m_code.local_get(l_v2);
	m_code.simd(simd_v128_bitselect);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::FMA(spu_opcode_t op)
{
	// a, b with all-exponent (inf/nan) operands zeroed, then a * b + c
	gpr_load(op.ra); m_code.local_tee(l_v0); splat32(0x7f800000); m_code.simd(simd_v128_and); splat32(0x7f800000); m_code.simd(simd_i32x4_ne);
	m_code.local_get(l_v0); m_code.simd(simd_v128_and);
	gpr_load(op.rb); m_code.local_tee(l_v1); splat32(0x7f800000); m_code.simd(simd_v128_and); splat32(0x7f800000); m_code.simd(simd_i32x4_ne);
	m_code.local_get(l_v1); m_code.simd(simd_v128_and);
	m_code.simd(simd_f32x4_mul);
	gpr_load(op.rc);
	m_code.simd(simd_f32x4_add);
	gpr_store(op.rt4);
}

// Shifts by immediate: SSE semantics saturate (count >= width gives 0 / sign fill); wasm counts wrap
void spu_wasm_recompiler::ROTMI(spu_opcode_t op)
{
	const u32 n = (0 - op.i7) & 0x3f;
	if (n >= 32) { m_code.v128_const(k_zero16); } else { gpr_load(op.ra); m_code.i32c(n); m_code.simd(simd_i32x4_shr_u); }
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTMAI(spu_opcode_t op)
{
	const u32 n = std::min<u32>((0 - op.i7) & 0x3f, 31);
	gpr_load(op.ra); m_code.i32c(n); m_code.simd(simd_i32x4_shr_s); gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTI(spu_opcode_t op)
{
	const u32 n = op.i7 & 0x1f;
	gpr_load(op.ra);
	if (n)
	{
		m_code.local_tee(l_v0); m_code.i32c(n); m_code.simd(simd_i32x4_shl);
		m_code.local_get(l_v0); m_code.i32c(32 - n); m_code.simd(simd_i32x4_shr_u);
		m_code.simd(simd_v128_or);
	}
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTHI(spu_opcode_t op)
{
	const u32 n = op.i7 & 0xf;
	gpr_load(op.ra);
	if (n)
	{
		m_code.local_tee(l_v0); m_code.i32c(n); m_code.simd(simd_i16x8_shl);
		m_code.local_get(l_v0); m_code.i32c(16 - n); m_code.simd(simd_i16x8_shr_u);
		m_code.simd(simd_v128_or);
	}
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTHMI(spu_opcode_t op)
{
	const u32 n = (0 - op.i7) & 0x1f;
	if (n >= 16) { m_code.v128_const(k_zero16); } else { gpr_load(op.ra); m_code.i32c(n); m_code.simd(simd_i16x8_shr_u); }
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTMAHI(spu_opcode_t op)
{
	const u32 n = std::min<u32>((0 - op.i7) & 0x1f, 15);
	gpr_load(op.ra); m_code.i32c(n); m_code.simd(simd_i16x8_shr_s); gpr_store(op.rt);
}

// Per-lane variable shifts and rotates (scalar per lane, as the interpreter)
void spu_wasm_recompiler::ROT(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane);
		m_code.local_get(l_v1); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane);
		m_code.op(0x77); // i32.rotl
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTM(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i64_extend_i32_u);
		m_code.i32c(0); m_code.local_get(l_v1); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i32_sub); m_code.i32c(0x3f); m_code.op(op_i32_and); m_code.op(op_i64_extend_i32_u);
		m_code.op(op_i64_shr_u);
		m_code.op(op_i32_wrap_i64);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::per_lane16(auto&& emit_scalar)
{
	m_code.local_get(l_v0);
	m_code.local_set(l_v2);
	for (u32 lane = 0; lane < 8; lane++)
	{
		m_code.local_get(l_v2);
		emit_scalar(lane); // pushes the i32 result (low 16 bits used)
		m_code.simd(simd_i16x8_replace_lane);
		m_code.emit8(lane);
		m_code.local_set(l_v2);
	}
	m_code.local_get(l_v2);
}

void spu_wasm_recompiler::ROTH(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane16([&](u32 lane)
	{
		// rotl16: ((a << n) | (a >> (16 - n))) & 0xffff with n = b & 15
		m_code.local_get(l_v0); m_code.simd(simd_i16x8_extract_lane_u); m_code.emit8(lane); m_code.local_set(l_t0);
		m_code.local_get(l_v1); m_code.simd(simd_i16x8_extract_lane_u); m_code.emit8(lane); m_code.i32c(15); m_code.op(op_i32_and); m_code.local_set(l_t1);
		m_code.local_get(l_t0); m_code.local_get(l_t1); m_code.op(op_i32_shl);
		m_code.local_get(l_t0); m_code.i32c(16); m_code.local_get(l_t1); m_code.op(op_i32_sub); m_code.op(op_i32_shr_u);
		m_code.op(op_i32_or);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTHM(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane16([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i16x8_extract_lane_u); m_code.emit8(lane);
		m_code.i32c(0); m_code.local_get(l_v1); m_code.simd(simd_i16x8_extract_lane_u); m_code.emit8(lane); m_code.op(op_i32_sub); m_code.i32c(0x1f); m_code.op(op_i32_and);
		m_code.op(op_i32_shr_u); // u32 >> n, n < 32
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTMAH(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane16([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(0x18 /* i16x8.extract_lane_s */); m_code.emit8(lane);
		m_code.i32c(0); m_code.local_get(l_v1); m_code.simd(simd_i16x8_extract_lane_u); m_code.emit8(lane); m_code.op(op_i32_sub); m_code.i32c(0x1f); m_code.op(op_i32_and);
		m_code.op(op_i32_shr_s);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::SHLH(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	per_lane16([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i16x8_extract_lane_u); m_code.emit8(lane);
		m_code.local_get(l_v1); m_code.simd(simd_i16x8_extract_lane_u); m_code.emit8(lane); m_code.i32c(0x1f); m_code.op(op_i32_and);
		m_code.op(op_i32_shl);
	});
	gpr_store(op.rt);
}

// Quadword bit shifts (n in 0..7 across the two 64-bit lanes); n == 0 must copy since wasm shift counts wrap
void spu_wasm_recompiler::quad_bit_shift(u32 kind, bool dynamic, u32 imm)
{
	// kind 0: ROTQBI (rotate left), 1: SHLQBI (shift left), 2: ROTQMBI (shift right by (-n)&7)
	static constexpr u8 k_swap64[16] = { 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7 };
	static constexpr u8 k_low_to_high[16] = { 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7 };
	// n
	if (dynamic)
	{
		gpr_lane3(m_op.rb);
		m_code.local_set(l_t0);
		if (kind == 2) { m_code.i32c(0); m_code.local_get(l_t0); m_code.op(op_i32_sub); m_code.local_set(l_t0); }
		m_code.local_get(l_t0); m_code.i32c(7); m_code.op(op_i32_and); m_code.local_set(l_t0);
	}
	else
	{
		m_code.i32c(kind == 2 ? ((0 - imm) & 7) : (imm & 7));
		m_code.local_set(l_t0);
	}
	gpr_load(m_op.ra);
	m_code.local_set(l_v0);
	m_code.local_get(l_t0);
	m_code.if_void(); // n != 0
	m_code.local_get(l_v0);
	m_code.local_get(l_t0);
	m_code.simd(kind == 2 ? simd_i64x2_shr_u : simd_i64x2_shl);
	m_code.local_get(l_v0);
	m_code.v128_const(k_zero16);
	m_code.shuffle(kind == 0 ? k_swap64 : kind == 1 ? k_low_to_high : k_high_to_low);
	m_code.i32c(64);
	m_code.local_get(l_t0);
	m_code.op(op_i32_sub);
	m_code.simd(kind == 2 ? simd_i64x2_shl : simd_i64x2_shr_u);
	m_code.simd(simd_v128_or);
	m_code.local_set(l_v0);
	m_code.end();
	m_code.local_get(l_v0);
	gpr_store(m_op.rt);
}

void spu_wasm_recompiler::ROTQBI(spu_opcode_t op) { m_op = op; quad_bit_shift(0, true, 0); }
void spu_wasm_recompiler::SHLQBI(spu_opcode_t op) { m_op = op; quad_bit_shift(1, true, 0); }
void spu_wasm_recompiler::ROTQMBI(spu_opcode_t op) { m_op = op; quad_bit_shift(2, true, 0); }
void spu_wasm_recompiler::ROTQBII(spu_opcode_t op) { m_op = op; quad_bit_shift(0, false, op.i7); }
void spu_wasm_recompiler::SHLQBII(spu_opcode_t op) { m_op = op; quad_bit_shift(1, false, op.i7); }

// Quadword byte shifts (swizzle with an index vector; out-of-range indices read zero)
void spu_wasm_recompiler::ROTQMBYI(spu_opcode_t op)
{
	const u32 k = (0 - op.i7) & 0x1f;
	u8 idx[16];
	for (u32 i = 0; i < 16; i++) idx[i] = i + k < 16 ? static_cast<u8>(i + k) : 0x80;
	gpr_load(op.ra); m_code.v128_const(idx); m_code.simd(simd_swizzle); gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTQMBY(spu_opcode_t op)
{
	// idx[i] = i + ((0 - rb.lane3) & 0x1f), zero when >= 16
	gpr_load(op.ra);
	m_code.v128_const(k_iota8);
	m_code.i32c(0); gpr_lane3(op.rb); m_code.op(op_i32_sub); m_code.i32c(0x1f); m_code.op(op_i32_and);
	m_code.simd(simd_i8x16_splat);
	m_code.simd(simd_i8x16_add);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::SHLQBY(spu_opcode_t op)
{
	// idx[i] = i - (rb.lane3 & 0x1f), zero when negative
	gpr_load(op.ra);
	m_code.v128_const(k_iota8);
	gpr_lane3(op.rb); m_code.i32c(0x1f); m_code.op(op_i32_and);
	m_code.simd(simd_i8x16_splat);
	m_code.simd(simd_i8x16_sub);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

// Gathers, masks and reductions
void spu_wasm_recompiler::ORX(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(0);
	m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(1); m_code.op(op_i32_or);
	m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(2); m_code.op(op_i32_or);
	m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(3); m_code.op(op_i32_or);
	from32r();
	gpr_store(op.rt);
}

void spu_wasm_recompiler::GB(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(31); m_code.simd(simd_i32x4_shl); m_code.simd(simd_i32x4_bitmask); from32r(); gpr_store(op.rt);
}

void spu_wasm_recompiler::GBH(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(15); m_code.simd(simd_i16x8_shl); m_code.simd(simd_i16x8_bitmask); from32r(); gpr_store(op.rt);
}

void spu_wasm_recompiler::GBB(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(7); m_code.simd(simd_i8x16_shl); m_code.simd(simd_i8x16_bitmask); from32r(); gpr_store(op.rt);
}

void spu_wasm_recompiler::FSM(spu_opcode_t op)
{
	gpr_lane3(op.ra); m_code.simd(simd_i32x4_splat);
	m_code.v128_const32(1, 2, 4, 8); m_code.simd(simd_v128_and);
	m_code.v128_const32(1, 2, 4, 8); m_code.simd(simd_i32x4_eq);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::FSMH(spu_opcode_t op)
{
	gpr_lane3(op.ra); m_code.simd(simd_i16x8_splat);
	m_code.v128_const32(0x00020001, 0x00080004, 0x00200010, 0x00800040); m_code.simd(simd_v128_and);
	m_code.v128_const32(0x00020001, 0x00080004, 0x00200010, 0x00800040); m_code.simd(simd_i16x8_eq);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::FSMB(spu_opcode_t op)
{
	// bytes 0..7 from bits 0..7 of the low byte of the preferred halfword, bytes 8..15 from the high byte
	static constexpr u8 k_bits[16] = { 1, 2, 4, 8, 16, 32, 64, 128, 1, 2, 4, 8, 16, 32, 64, 128 };
	static constexpr u8 k_lo_hi[16] = { 12, 12, 12, 12, 12, 12, 12, 12, 13, 13, 13, 13, 13, 13, 13, 13 };
	gpr_load(op.ra);
	m_code.v128_const(k_lo_hi); m_code.simd(simd_swizzle); // byte 12 (low byte of lane 3) / byte 13 broadcast
	m_code.v128_const(k_bits); m_code.simd(simd_v128_and);
	m_code.v128_const(k_bits); m_code.simd(simd_i8x16_eq);
	gpr_store(op.rt);
}

// Carry and borrow
void spu_wasm_recompiler::CG(spu_opcode_t op)
{
	gpr_load(op.rb); splat32(0x80000000); m_code.simd(simd_v128_xor);
	gpr_load(op.ra); splat32(0x7fffffff); m_code.simd(simd_v128_xor);
	m_code.simd(simd_i32x4_gt_s);
	m_code.i32c(31); m_code.simd(simd_i32x4_shr_u);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::BG(spu_opcode_t op)
{
	// gtu32(a, b) + 1: 1 when b >= a (unsigned)
	gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_i32x4_gt_u); splat32(1); m_code.simd(simd_i32x4_add);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::CGX(spu_opcode_t op)
{
	// rt = ((rt & 1) + ra + rb) >> 32 per lane (64-bit arithmetic)
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	gpr_load(op.rt); m_code.local_set(l_v2);
	m_code.local_get(l_v2); m_code.local_set(l_v3);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v3); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.i32c(1); m_code.op(op_i32_and); m_code.op(op_i64_extend_i32_u);
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i64_extend_i32_u); m_code.op(op_i64_add);
		m_code.local_get(l_v1); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i64_extend_i32_u); m_code.op(op_i64_add);
		m_code.i64c(32); m_code.op(op_i64_shr_u); m_code.op(op_i32_wrap_i64);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ADDX(spu_opcode_t op)
{
	// rt = ra + rb + (rt & 1)
	gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_i32x4_add);
	gpr_load(op.rt); splat32(1); m_code.simd(simd_v128_and); m_code.simd(simd_i32x4_add);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::SFX(spu_opcode_t op)
{
	// rt = rb - ra - (1 - (rt & 1)) = rb - ra + (rt & 1) - 1
	gpr_load(op.rb); gpr_load(op.ra); m_code.simd(simd_i32x4_sub);
	gpr_load(op.rt); splat32(1); m_code.simd(simd_v128_and); m_code.simd(simd_i32x4_add);
	splat32(1); m_code.simd(simd_i32x4_sub);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::BGX(spu_opcode_t op)
{
	// rt = (rb + (rt & 1) > ra) ? 1 : 0 as unsigned 64-bit arithmetic: ((rt & 1) + rb - ra) > 0 with borrow semantics
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	gpr_load(op.rt); m_code.local_set(l_v3);
	per_lane32([&](u32 lane)
	{
		// borrow = (b + carry_in) >= a  where carry_in = rt & 1 (as u64)
		m_code.local_get(l_v1); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i64_extend_i32_u);
		m_code.local_get(l_v3); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.i32c(1); m_code.op(op_i32_and); m_code.op(op_i64_extend_i32_u); m_code.op(op_i64_add);
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.op(op_i64_extend_i32_u);
		m_code.op(0x56); // i64.gt_u: b + carry_in > a  <=>  b - a - (1 - carry_in) >= 0
	});
	gpr_store(op.rt);
}

// Single precision add/sub (plain, as the interpreter's gv_addfs/gv_subfs)
void spu_wasm_recompiler::FA(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f32x4_add); gpr_store(op.rt); }
void spu_wasm_recompiler::FS(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f32x4_sub); gpr_store(op.rt); }

// Multiplies (16 x 16 -> 32 per word lane)
void spu_wasm_recompiler::MPY(spu_opcode_t op)
{
	gpr_load(op.ra); splat32(0xffff); m_code.simd(simd_v128_and);
	gpr_load(op.rb); splat32(0xffff); m_code.simd(simd_v128_and);
	m_code.simd(simd_i32x4_dot_i16x8_s);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYA(spu_opcode_t op)
{
	gpr_load(op.rc);
	gpr_load(op.ra); splat32(0xffff); m_code.simd(simd_v128_and);
	gpr_load(op.rb); splat32(0xffff); m_code.simd(simd_v128_and);
	m_code.simd(simd_i32x4_dot_i16x8_s);
	m_code.simd(simd_i32x4_add);
	gpr_store(op.rt4);
}

void spu_wasm_recompiler::MPYS(spu_opcode_t op)
{
	gpr_load(op.ra); splat32(0xffff); m_code.simd(simd_v128_and);
	gpr_load(op.rb); splat32(0xffff); m_code.simd(simd_v128_and);
	m_code.simd(simd_i32x4_dot_i16x8_s);
	m_code.i32c(16); m_code.simd(simd_i32x4_shr_s);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYI(spu_opcode_t op)
{
	gpr_load(op.ra); splat32(op.si10 & 0xffff); m_code.simd(simd_i32x4_dot_i16x8_s); gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYU(spu_opcode_t op)
{
	gpr_load(op.ra); splat32(0xffff); m_code.simd(simd_v128_and);
	gpr_load(op.rb); splat32(0xffff); m_code.simd(simd_v128_and);
	m_code.simd(simd_i32x4_mul);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYUI(spu_opcode_t op)
{
	gpr_load(op.ra); splat32(0xffff); m_code.simd(simd_v128_and);
	splat32(op.si10 & 0xffff);
	m_code.simd(simd_i32x4_mul);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYH(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	gpr_load(op.rb); splat32(0xffff); m_code.simd(simd_v128_and);
	m_code.simd(simd_i32x4_mul);
	m_code.i32c(16); m_code.simd(simd_i32x4_shl);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYHH(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	gpr_load(op.rb); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	m_code.simd(simd_i32x4_dot_i16x8_s);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYHHA(spu_opcode_t op)
{
	gpr_load(op.rt);
	gpr_load(op.ra); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	gpr_load(op.rb); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	m_code.simd(simd_i32x4_dot_i16x8_s);
	m_code.simd(simd_i32x4_add);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYHHU(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	gpr_load(op.rb); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	m_code.simd(simd_i32x4_mul);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::MPYHHAU(spu_opcode_t op)
{
	gpr_load(op.rt);
	gpr_load(op.ra); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	gpr_load(op.rb); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);
	m_code.simd(simd_i32x4_mul);
	m_code.simd(simd_i32x4_add);
	gpr_store(op.rt);
}

// Byte sums
void spu_wasm_recompiler::SUMB(spu_opcode_t op)
{
	// sa/sb: per halfword the sum of its two bytes; result low halfword = sum of a's dword bytes, high halfword = b's
	gpr_load(op.ra); m_code.local_tee(l_v0); m_code.i32c(8); m_code.simd(simd_i16x8_shr_u);
	m_code.local_get(l_v0); splat16(0xff); m_code.simd(simd_v128_and);
	m_code.simd(simd_i16x8_add); m_code.local_set(l_v0); // sa
	gpr_load(op.rb); m_code.local_tee(l_v1); m_code.i32c(8); m_code.simd(simd_i16x8_shr_u);
	m_code.local_get(l_v1); splat16(0xff); m_code.simd(simd_v128_and);
	m_code.simd(simd_i16x8_add); m_code.local_set(l_v1); // sb
	m_code.local_get(l_v0); m_code.i32c(16); m_code.simd(simd_i32x4_shr_u);      // s1
	m_code.local_get(l_v0); splat32(0xffff); m_code.simd(simd_v128_and);          // s2
	m_code.simd(simd_i16x8_add);
	m_code.local_get(l_v1); m_code.i32c(16); m_code.simd(simd_i32x4_shl);        // s3
	m_code.local_get(l_v1); splat32(0xffff0000); m_code.simd(simd_v128_and);      // s4
	m_code.simd(simd_i16x8_add);
	m_code.simd(simd_v128_or);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::AVGB(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_i8x16_avgr_u); gpr_store(op.rt); }

void spu_wasm_recompiler::ABSDB(spu_opcode_t op)
{
	gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_i8x16_max_u);
	gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_i8x16_min_u);
	m_code.simd(simd_i8x16_sub);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::CNTB(spu_opcode_t op) { gpr_load(op.ra); m_code.simd(simd_i8x16_popcnt); gpr_store(op.rt); }

// Fused multiply-subtract forms (inf/nan operands of the product zeroed as in FMA)
void spu_wasm_recompiler::fm_masked_product(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_tee(l_v0); splat32(0x7f800000); m_code.simd(simd_v128_and); splat32(0x7f800000); m_code.simd(simd_i32x4_ne);
	m_code.local_get(l_v0); m_code.simd(simd_v128_and);
	gpr_load(op.rb); m_code.local_tee(l_v1); splat32(0x7f800000); m_code.simd(simd_v128_and); splat32(0x7f800000); m_code.simd(simd_i32x4_ne);
	m_code.local_get(l_v1); m_code.simd(simd_v128_and);
	m_code.simd(simd_f32x4_mul);
}

void spu_wasm_recompiler::FMS(spu_opcode_t op) { fm_masked_product(op); gpr_load(op.rc); m_code.simd(simd_f32x4_sub); gpr_store(op.rt4); }
void spu_wasm_recompiler::FNMS(spu_opcode_t op) { gpr_load(op.rc); fm_masked_product(op); m_code.simd(simd_f32x4_sub); gpr_store(op.rt4); }

// Float compares
void spu_wasm_recompiler::FCEQ(spu_opcode_t op) { gpr_load(op.rb); gpr_load(op.ra); m_code.simd(simd_f32x4_eq); gpr_store(op.rt); }

void spu_wasm_recompiler::FCMEQ(spu_opcode_t op)
{
	gpr_load(op.rb); splat32(0x7fffffff); m_code.simd(simd_v128_and);
	gpr_load(op.ra); splat32(0x7fffffff); m_code.simd(simd_v128_and);
	m_code.simd(simd_f32x4_eq);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::fcgt_operand(u32 reg)
{
	// nan (extended) values lowered by clearing the last exponent bit; denormals flushed to zero
	gpr_load(reg); m_code.local_set(l_v0);
	m_code.local_get(l_v0); m_code.local_get(l_v0); m_code.simd(simd_f32x4_ne);            // nan_check
	m_code.local_set(l_v1);
	m_code.local_get(l_v0); splat32(0x00800000); m_code.simd(simd_v128_andnot);            // lowered
	m_code.local_get(l_v0);
	m_code.local_get(l_v1);
	m_code.simd(simd_v128_bitselect);                                                      // nan ? lowered : original
	m_code.local_get(l_v0); splat32(0x7f800000); m_code.simd(simd_v128_and); m_code.v128_const(k_zero16); m_code.simd(simd_i32x4_eq); // denorm
	m_code.simd(simd_v128_andnot);                                                         // & ~denorm
}

void spu_wasm_recompiler::FCGT(spu_opcode_t op)
{
	fcgt_operand(op.rb); m_code.local_set(l_v2);
	fcgt_operand(op.ra);
	m_code.local_get(l_v2);
	m_code.local_set(l_v3); // final_b
	m_code.local_set(l_v2); // final_a
	m_code.local_get(l_v3); m_code.local_get(l_v2); m_code.simd(simd_f32x4_lt); // final_b < final_a
	gpr_store(op.rt);
}

// Conditional indirect branches
void spu_wasm_recompiler::conditional_indirect(spu_opcode_t op, bool halfword, bool branch_if_zero)
{
	if (op.de)
	{
		bail_to_interpreter();
		return;
	}
	m_code.local_get(l_thread);
	m_code.i32_load(off_gpr + op.rt * 16 + 12);
	if (halfword) { m_code.i32c(0xffff); m_code.op(op_i32_and); }
	if (branch_if_zero) m_code.op(op_i32_eqz);
	m_code.if_void();
	m_depth++;
	gpr_lane3(op.ra);
	branch_dynamic();
	m_depth--;
	m_code.end();
}

void spu_wasm_recompiler::BIZ(spu_opcode_t op) { conditional_indirect(op, false, true); }
void spu_wasm_recompiler::BINZ(spu_opcode_t op) { conditional_indirect(op, false, false); }
void spu_wasm_recompiler::BIHZ(spu_opcode_t op) { conditional_indirect(op, true, true); }
void spu_wasm_recompiler::BIHNZ(spu_opcode_t op) { conditional_indirect(op, true, false); }

// Byte shifts by bit count (rb.lane3 >> 3)
void spu_wasm_recompiler::ROTQBYBI(spu_opcode_t op)
{
	gpr_load(op.ra);
	m_code.v128_const(k_iota8);
	gpr_lane3(op.rb); m_code.i32c(3); m_code.op(op_i32_shr_u);
	m_code.simd(simd_i8x16_splat);
	m_code.simd(simd_i8x16_sub);
	splat8(15);
	m_code.simd(simd_v128_and);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::ROTQMBYBI(spu_opcode_t op)
{
	gpr_load(op.ra);
	m_code.v128_const(k_iota8);
	m_code.i32c(0); gpr_lane3(op.rb); m_code.i32c(3); m_code.op(op_i32_shr_u); m_code.op(op_i32_sub); m_code.i32c(0x1f); m_code.op(op_i32_and);
	m_code.simd(simd_i8x16_splat);
	m_code.simd(simd_i8x16_add);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::SHLQBYBI(spu_opcode_t op)
{
	gpr_load(op.ra);
	m_code.v128_const(k_iota8);
	gpr_lane3(op.rb); m_code.i32c(3); m_code.op(op_i32_shr_u); m_code.i32c(0x1f); m_code.op(op_i32_and);
	m_code.simd(simd_i8x16_splat);
	m_code.simd(simd_i8x16_sub);
	m_code.simd(simd_swizzle);
	gpr_store(op.rt);
}

// Float compare of magnitudes
void spu_wasm_recompiler::FCMGT(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	gpr_load(op.rb); m_code.local_set(l_v1);
	// nan_mask = (nan_a ^ nan_b) & ~nan_b
	m_code.local_get(l_v0); m_code.local_get(l_v0); m_code.simd(simd_f32x4_ne);
	m_code.local_get(l_v1); m_code.local_get(l_v1); m_code.simd(simd_f32x4_ne); m_code.local_tee(l_v2);
	m_code.simd(simd_v128_xor);
	m_code.local_get(l_v2);
	m_code.simd(simd_v128_andnot);
	m_code.local_set(l_v3);
	// final_b magnitude, final_a magnitude (denormals flushed)
	m_code.local_get(l_v1); m_code.local_get(l_v1); splat32(0x7f800000); m_code.simd(simd_v128_and); m_code.v128_const(k_zero16); m_code.simd(simd_i32x4_eq); m_code.simd(simd_v128_andnot);
	splat32(0x7fffffff); m_code.simd(simd_v128_and);
	m_code.local_get(l_v0); m_code.local_get(l_v0); splat32(0x7f800000); m_code.simd(simd_v128_and); m_code.v128_const(k_zero16); m_code.simd(simd_i32x4_eq); m_code.simd(simd_v128_andnot);
	splat32(0x7fffffff); m_code.simd(simd_v128_and);
	m_code.simd(simd_f32x4_lt); // |final_b| < |final_a|
	m_code.local_get(l_v3);
	m_code.simd(simd_v128_or);
	gpr_store(op.rt);
}

// Reciprocal estimates through RPCS3's lookup tables (the tables live in this module's memory)
void spu_wasm_recompiler::FREST(spu_opcode_t op)
{
	const u32 fraction_lut = static_cast<u32>(reinterpret_cast<uptr>(spu_frest_fraction_lut));
	const u32 exponent_lut = static_cast<u32>(reinterpret_cast<uptr>(spu_frest_exponent_lut));
	gpr_load(op.ra); m_code.local_set(l_v0);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.local_set(l_t0);
		m_code.local_get(l_t0); m_code.i32c(18); m_code.op(op_i32_shr_u); m_code.i32c(0x1f); m_code.op(op_i32_and); m_code.i32c(2); m_code.op(op_i32_shl); m_code.i32_load(fraction_lut);
		m_code.local_get(l_t0); m_code.i32c(23); m_code.op(op_i32_shr_u); m_code.i32c(0xff); m_code.op(op_i32_and); m_code.i32c(2); m_code.op(op_i32_shl); m_code.i32_load(exponent_lut);
		m_code.op(op_i32_or);
		m_code.local_get(l_t0); m_code.i32c(static_cast<s32>(0x80000000)); m_code.op(op_i32_and);
		m_code.op(op_i32_or);
	});
	gpr_store(op.rt);
}

void spu_wasm_recompiler::FRSQEST(spu_opcode_t op)
{
	const u32 fraction_lut = static_cast<u32>(reinterpret_cast<uptr>(spu_frsqest_fraction_lut));
	const u32 exponent_lut = static_cast<u32>(reinterpret_cast<uptr>(spu_frsqest_exponent_lut));
	gpr_load(op.ra); m_code.local_set(l_v0);
	per_lane32([&](u32 lane)
	{
		m_code.local_get(l_v0); m_code.simd(simd_i32x4_extract_lane); m_code.emit8(lane); m_code.local_set(l_t0);
		m_code.local_get(l_t0); m_code.i32c(18); m_code.op(op_i32_shr_u); m_code.i32c(0x3f); m_code.op(op_i32_and); m_code.i32c(2); m_code.op(op_i32_shl); m_code.i32_load(fraction_lut);
		m_code.local_get(l_t0); m_code.i32c(23); m_code.op(op_i32_shr_u); m_code.i32c(0xff); m_code.op(op_i32_and); m_code.i32c(2); m_code.op(op_i32_shl); m_code.i32_load(exponent_lut);
		m_code.op(op_i32_or);
	});
	gpr_store(op.rt);
}

// Float interpolate
void spu_wasm_recompiler::FI(spu_opcode_t op)
{
	const u32 exp2_m13 = std::bit_cast<u32>(std::exp2(-13.f));
	const u32 exp2_m19 = std::bit_cast<u32>(std::exp2(-19.f));
	// base = (rb & 0x007ffc00) | 0x3f800000
	gpr_load(op.rb); splat32(0x007ffc00); m_code.simd(simd_v128_and); splat32(0x3f800000); m_code.simd(simd_v128_or);
	// step * y
	gpr_load(op.rb); splat32(0x000003ff); m_code.simd(simd_v128_and); m_code.simd(simd_f32x4_convert_i32x4_s); splat32(exp2_m13); m_code.simd(simd_f32x4_mul);
	gpr_load(op.ra); splat32(0x0007ffff); m_code.simd(simd_v128_and); m_code.simd(simd_f32x4_convert_i32x4_s); splat32(exp2_m19); m_code.simd(simd_f32x4_mul);
	m_code.simd(simd_f32x4_mul);
	m_code.simd(simd_f32x4_sub);          // base - step * y
	splat32(0xff800000); m_code.simd(simd_v128_andnot); // & ~mask_se
	gpr_load(op.rb); splat32(0xff800000); m_code.simd(simd_v128_and);
	m_code.simd(simd_v128_or);
	gpr_store(op.rt);
}

// Conversions (scale = 2^n as a float, infinite beyond the float range as in RPCS3's table)
static u32 spu_scale_bits(s32 n)
{
	return std::bit_cast<u32>(static_cast<float>(std::exp2(static_cast<double>(n))));
}

void spu_wasm_recompiler::CFLTS(spu_opcode_t op)
{
	gpr_load(op.ra); splat32(spu_scale_bits(173 - static_cast<s32>(op.i8))); m_code.simd(simd_f32x4_mul); m_code.local_set(l_v0);
	m_code.local_get(l_v0); m_code.simd(simd_i32x4_trunc_sat_f32x4_s);
	// SSE cvttps yields 0x80000000 for NaN where saturation yields 0
	m_code.local_get(l_v0); m_code.local_get(l_v0); m_code.simd(simd_f32x4_ne); splat32(0x80000000); m_code.simd(simd_v128_and);
	m_code.simd(simd_v128_or);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::CFLTU(spu_opcode_t op)
{
	gpr_load(op.ra); splat32(spu_scale_bits(173 - static_cast<s32>(op.i8))); m_code.simd(simd_f32x4_mul);
	m_code.v128_const(k_zero16); m_code.simd(simd_f32x4_max);
	m_code.simd(simd_i32x4_trunc_sat_f32x4_u);
	gpr_store(op.rt);
}

void spu_wasm_recompiler::CSFLT(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.simd(simd_f32x4_convert_i32x4_s); splat32(spu_scale_bits(static_cast<s32>(op.i8) - 155)); m_code.simd(simd_f32x4_mul); gpr_store(op.rt);
}

void spu_wasm_recompiler::CUFLT(spu_opcode_t op)
{
	gpr_load(op.ra); m_code.local_set(l_v0);
	m_code.local_get(l_v0); splat32(0x7fffffff); m_code.simd(simd_v128_and); m_code.simd(simd_f32x4_convert_i32x4_s);
	m_code.local_get(l_v0); m_code.i32c(31); m_code.simd(simd_i32x4_shr_s); splat32(0x4f000000); m_code.simd(simd_v128_and); // 2^31 where negative
	m_code.simd(simd_f32x4_add);
	splat32(spu_scale_bits(static_cast<s32>(op.i8) - 155)); m_code.simd(simd_f32x4_mul);
	gpr_store(op.rt);
}

// Double precision
void spu_wasm_recompiler::FESD(spu_opcode_t op)
{
	static constexpr u8 k_lanes_1_3[16] = { 4, 5, 6, 7, 12, 13, 14, 15, 0, 1, 2, 3, 8, 9, 10, 11 };
	gpr_load(op.ra); m_code.v128_const(k_zero16); m_code.shuffle(k_lanes_1_3); m_code.simd(simd_f64x2_promote_low_f32x4); gpr_store(op.rt);
}

void spu_wasm_recompiler::FRDS(spu_opcode_t op)
{
	static constexpr u8 k_spread[16] = { 8, 9, 10, 11, 0, 1, 2, 3, 12, 13, 14, 15, 4, 5, 6, 7 };
	gpr_load(op.ra); m_code.simd(simd_f32x4_demote_f64x2_zero); m_code.v128_const(k_zero16); m_code.shuffle(k_spread); gpr_store(op.rt);
}

void spu_wasm_recompiler::DFA(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f64x2_add); gpr_store(op.rt); }
void spu_wasm_recompiler::DFS(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f64x2_sub); gpr_store(op.rt); }
void spu_wasm_recompiler::DFM(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f64x2_mul); gpr_store(op.rt); }
void spu_wasm_recompiler::DFMA(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f64x2_mul); gpr_load(op.rt); m_code.simd(simd_f64x2_add); gpr_store(op.rt); }
void spu_wasm_recompiler::DFMS(spu_opcode_t op) { gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f64x2_mul); gpr_load(op.rt); m_code.simd(simd_f64x2_sub); gpr_store(op.rt); }
void spu_wasm_recompiler::DFNMS(spu_opcode_t op) { gpr_load(op.rt); gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f64x2_mul); m_code.simd(simd_f64x2_sub); gpr_store(op.rt); }
void spu_wasm_recompiler::DFNMA(spu_opcode_t op)
{
	gpr_load(op.ra); gpr_load(op.rb); m_code.simd(simd_f64x2_mul); gpr_load(op.rt); m_code.simd(simd_f64x2_add);
	m_code.v128_const32(0, 0x80000000, 0, 0x80000000); m_code.simd(simd_v128_xor);
	gpr_store(op.rt);
}

// Not lowered yet: the program stays on the interpreter
REFUSE(DFCGT) REFUSE(DFCMGT) REFUSE(DFTSV) REFUSE(DFCEQ) REFUSE(DFCMEQ)

#undef REFUSE
#undef BINARY_V
#undef BINARY_IMM32
#undef BINARY_IMM16

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <map>

EM_JS(int, rpcs3_web_spu_wasm_validate, (const u8* bytes, u32 size), {
	try { return WebAssembly.validate(HEAPU8.subarray(bytes, bytes + size)) ? 1 : 0; } catch (e) { return 0; }
});

// Compiles every program of an SPU cache image (be size|crc<<16, be entry, words) through the
// wasm recompiler on a synthetic local store and validates the modules: a JSON report
extern std::string spu_web_wasm_selftest(const u8* cache, u32 size)
{
	std::vector<be_t<u32>> ls(SPU_LS_SIZE / 4);
	u32 programs = 0, compiled = 0, validated = 0, bytes = 0;
	std::map<std::string, u32> refusals;
	std::string first_invalid;
	for (u32 off = 0; off + 8 <= size;)
	{
		const u32 size_crc = (cache[off] << 24) | (cache[off + 1] << 16) | (cache[off + 2] << 8) | cache[off + 3];
		const u32 words = size_crc & 0xffff;
		const u32 entry = (cache[off + 4] << 24) | (cache[off + 5] << 16) | (cache[off + 6] << 8) | cache[off + 7];
		if (!words || off + 8 + words * 4 > size) break;
		std::fill(ls.begin(), ls.end(), be_t<u32>{0});
		for (u32 i = 0; i < words && (entry / 4 + i) < ls.size(); i++)
		{
			u32 raw;
			std::memcpy(&raw, cache + off + 8 + i * 4, 4);
			ls[entry / 4 + i] = std::bit_cast<be_t<u32>>(raw);
		}
		programs++;
		std::string name, why;
		u32 found_entry = 0;
		const auto module = spu_web_compile_ls(ls.data(), entry, name, found_entry, why);
		if (module.empty())
		{
			// reason without the pc prefix
			const auto colon = why.find(": ");
			refusals[colon == std::string::npos ? why : why.substr(colon + 2)]++;
		}
		else
		{
			compiled++;
			bytes += ::size32(module);
			if (rpcs3_web_spu_wasm_validate(module.data(), ::size32(module)))
			{
				validated++;
			}
			else if (first_invalid.empty())
			{
				first_invalid = name;
			}
		}
		off += 8 + words * 4;
	}
	std::string out = fmt::format("{\"programs\":%u,\"compiled\":%u,\"validated\":%u,\"bytes\":%u,\"firstInvalid\":\"%s\",\"refusals\":{", programs, compiled, validated, bytes, first_invalid);
	std::vector<std::pair<u32, std::string>> sorted;
	for (const auto& [why, n] : refusals) sorted.emplace_back(n, why);
	std::sort(sorted.rbegin(), sorted.rend());
	for (usz i = 0; i < sorted.size() && i < 40; i++)
	{
		fmt::append(out, "%s\"%s\":%u", i ? "," : "", sorted[i].second, sorted[i].first);
	}
	out += "}}";
	return out;
}
#endif

#ifdef __EMSCRIPTEN__
// Hot load without messages: compiled module bytes stay in a registry in wasm memory, the
// compiling SPU thread registers (entry, table index) immediately, and every SPU thread places
// the modules it has not placed yet into its own worker's function table right before
// dispatching (rpcs3_web_spu_hot_sync in rpcs3_web_pre.js). Pool workers busy in wasm never
// process posted messages, so nothing may depend on message delivery.
extern void spu_web_aot_register(const u32* pairs, u32 count);

EM_JS(u32, rpcs3_web_spu_hot_sync, (), {
	return rpcs3SpuHotSyncImpl() >>> 0;
});

namespace
{
	struct spu_web_hot_entry
	{
		u32 entry;
		u32 index;
		std::vector<u8> bytes;
		// kind 1: a dylink side module from the LLVM tier (web/host/rpcs3_spu_llvm_main.cpp); its
		// element segment occupies [elem_base, elem_base + table_size) and its data lives at memory_base
		u32 kind = 0;
		u32 elem_base = 0;
		u32 table_size = 0;
		u32 memory_base = 0;
		u32 imports_table = 0;
	};

	// LLVM tier hand-off: an SPU LLVM worker thread (spu_llvm_worker, SPUCommonRecompiler.cpp) fills a
	// slot with its local-store snapshot and waits; the module thread forwards the slot to a compiler
	// worker (rpcs3-spu-llvm.mjs) and writes the side module back
	struct spu_web_llvm_request
	{
		atomic_t<u32> state{0}; // 0 free, 1 filling, 2 ready, 3 taken by the module thread, 4 done, 5 failed, 6 abandoned
		u32 pc = 0;
		u8* result = nullptr; // malloc'd by the module thread, freed by the waiting worker
		u32 result_size = 0;
		u32 memory_size = 0;
		u32 memory_align = 0;
		u32 table_size = 0;
		u32 imports_table = 0;
		alignas(16) u8 ls[SPU_LS_SIZE];
	};

	constexpr u32 spu_web_llvm_slots = 8;
	spu_web_llvm_request* g_spu_web_llvm_requests = nullptr;
	atomic_t<u32> g_spu_web_llvm_enabled{0};
	atomic_t<u32> g_spu_web_llvm_requested{0}, g_spu_web_llvm_failed{0}, g_spu_web_llvm_abandoned{0}, g_spu_web_llvm_registered{0}, g_spu_web_llvm_bytes{0};

	shared_mutex g_spu_web_hot_mutex;
	std::map<std::string, u32> g_spu_web_hot_refusals;
	std::deque<spu_web_hot_entry> g_spu_web_hot_entries; // stable addresses
	atomic_t<u32> g_spu_web_hot_count{0};                 // entries published (release)
	atomic_t<u32> g_spu_web_hot_compiled{0}, g_spu_web_hot_refused{0}, g_spu_web_hot_bytes{0};
	atomic_t<u32> g_spu_web_hot_base{0};                  // first hot table index (dispatch hot path reads it)
	constexpr u32 spu_web_hot_limit = 65536;              // programs per run
	// Per hot table slot (index - base): 1 for an LLVM-tier side module, so dispatches count per tier
	atomic_t<u8> g_spu_web_hot_kinds[spu_web_hot_limit * 2]{};

	// One padded slot per SPU thread: these count every dispatch, so they must not share a line
	struct alignas(128) spu_web_tier_counts
	{
		atomic_t<u64> hot{0};
		atomic_t<u64> llvm{0};
	};

	std::array<spu_web_tier_counts, 8> g_spu_web_tier_counts{};
}

// The region above the bundles is shared with the PPU runtime tier (PPUWebRecompiler.cpp)
extern void web_hot_table_set_base(u32 base);
extern u32 web_hot_table_base();
extern u32 web_hot_table_reserve(u32 count);

extern void spu_web_set_hot_table_base(u32 base)
{
	std::lock_guard lock(g_spu_web_hot_mutex);
	web_hot_table_set_base(base);
	g_spu_web_hot_base = base;
}

extern u32 spu_web_hot_count()
{
	return g_spu_web_hot_count.load();
}

extern u32 spu_web_hot_table_base()
{
	return g_spu_web_hot_base.load();
}

// Dispatch loop: a hot-region candidate ran (SPUThread.cpp), counted into the calling thread's slot
extern void spu_web_note_hot_dispatch(u32 index, u32 thread_slot)
{
	const u32 slot = index - g_spu_web_hot_base.load();
	auto& counts = g_spu_web_tier_counts[thread_slot % g_spu_web_tier_counts.size()];

	if (slot < spu_web_hot_limit * 2 && g_spu_web_hot_kinds[slot].load())
	{
		counts.llvm.raw()++;
	}
	else
	{
		counts.hot.raw()++;
	}
}

extern u32 spu_web_hot_index(u32 i)
{
	std::lock_guard lock(g_spu_web_hot_mutex);
	return i < g_spu_web_hot_entries.size() ? g_spu_web_hot_entries[i].index : 0;
}

extern const u8* spu_web_hot_bytes(u32 i)
{
	std::lock_guard lock(g_spu_web_hot_mutex);
	return i < g_spu_web_hot_entries.size() ? g_spu_web_hot_entries[i].bytes.data() : nullptr;
}

extern u32 spu_web_hot_size(u32 i)
{
	std::lock_guard lock(g_spu_web_hot_mutex);
	return i < g_spu_web_hot_entries.size() ? ::size32(g_spu_web_hot_entries[i].bytes) : 0;
}

// Compiles the program at the thread's pc once per distinct code image at that address
extern void spu_web_llvm_set_enabled(bool enabled)
{
	std::lock_guard lock(g_spu_web_hot_mutex);
	if (enabled && !g_spu_web_llvm_requests) g_spu_web_llvm_requests = new spu_web_llvm_request[spu_web_llvm_slots];
	g_spu_web_llvm_enabled = enabled ? 1 : 0;
}

// Module thread: next ready slot (taken), -1 when none
extern s32 spu_web_llvm_poll()
{
	if (!g_spu_web_llvm_requests) return -1;
	for (u32 i = 0; i < spu_web_llvm_slots; i++)
	{
		u32 expected = 2;
		if (g_spu_web_llvm_requests[i].state.compare_exchange(expected, 3)) return static_cast<s32>(i);
	}
	return -1;
}

extern const u8* spu_web_llvm_slot_ls(u32 i)
{
	return i < spu_web_llvm_slots ? g_spu_web_llvm_requests[i].ls : nullptr;
}

extern u32 spu_web_llvm_slot_pc(u32 i)
{
	return i < spu_web_llvm_slots ? g_spu_web_llvm_requests[i].pc : 0;
}

// Module thread: the compiler worker's answer for a taken slot (bytes from malloc, null on failure)
extern void spu_web_llvm_slot_finish(u32 i, u8* bytes, u32 size, u32 memory_size, u32 memory_align, u32 table_size, u32 imports_table)
{
	if (i >= spu_web_llvm_slots) return;
	auto& slot = g_spu_web_llvm_requests[i];

	if (slot.state.load() == 6)
	{
		// The waiting worker gave up (shutdown)
		std::free(bytes);
		slot.state.store(0);
		return;
	}

	slot.result = bytes;
	slot.result_size = size;
	slot.memory_size = memory_size;
	slot.memory_align = memory_align;
	slot.table_size = table_size;
	slot.imports_table = imports_table;
	slot.state.store(bytes ? 4 : 5);
}

extern void spu_web_aot_register_front(const u32* pairs, u32 count);
extern u32 spu_web_llvm_register(const u8* bytes, u32 size, u32 entry, u32 memory_size, u32 memory_align, u32 table_size, u32 imports_table);

// SPU LLVM worker thread: compile the snapshot in a compiler worker and register the side module
extern bool spu_web_llvm_compile_remote(const be_t<u32>* ls, u32 entry)
{
	if (!g_spu_web_llvm_enabled) return false;

	spu_web_llvm_request* slot = nullptr;

	while (!slot)
	{
		for (u32 i = 0; i < spu_web_llvm_slots && !slot; i++)
		{
			u32 expected = 0;
			if (g_spu_web_llvm_requests[i].state.compare_exchange(expected, 1)) slot = &g_spu_web_llvm_requests[i];
		}

		if (!slot)
		{
			if (thread_ctrl::state() == thread_state::aborting) return false;
			thread_ctrl::wait_for(1000);
		}
	}

	std::memcpy(slot->ls, ls, SPU_LS_SIZE);
	slot->pc = entry;
	slot->result = nullptr;
	slot->state.store(2);
	g_spu_web_llvm_requested++;
	spu_log.notice("SPU LLVM tier: 0x%05x handed to a compiler worker (slot %u)", entry, static_cast<u32>(slot - g_spu_web_llvm_requests));

	while (slot->state.load() < 4)
	{
		if (thread_ctrl::state() == thread_state::aborting)
		{
			// Emulation is stopping: leave the slot to the module thread's answer (it frees the bytes
			// and releases the slot)
			g_spu_web_llvm_abandoned++;
			u32 expected = 2;
			if (slot->state.compare_exchange(expected, 0)) return false;
			slot->state.store(6);
			return false;
		}

		thread_ctrl::wait_for(500);
	}

	const bool ok = slot->state.load() == 4;

	if (ok)
	{
		const u32 index = spu_web_llvm_register(slot->result, slot->result_size, entry, slot->memory_size, slot->memory_align, slot->table_size, slot->imports_table);
		spu_log.notice("SPU LLVM tier: 0x%05x registered at table index %u (%u bytes)", entry, index, slot->result_size);
	}
	else
	{
		g_spu_web_llvm_failed++;
		spu_log.error("SPU LLVM tier: 0x%05x failed in the compiler worker", entry);
	}

	std::free(slot->result);
	slot->result = nullptr;
	slot->state.store(0);
	return ok;
}

// Registers a compiled side module as the first dispatch candidate of its entry; returns its table index
extern u32 spu_web_llvm_register(const u8* bytes, u32 size, u32 entry, u32 memory_size, u32 memory_align, u32 table_size, u32 imports_table)
{
	std::vector<u8> module(bytes, bytes + size);
	u32 memory_base = 0;
	if (memory_size)
	{
		const u32 align = std::max<u32>(16, 1u << std::min<u32>(memory_align, 16)); // dylink.0 carries log2
		const auto allocation = reinterpret_cast<uptr>(std::malloc(memory_size + align));
		memory_base = static_cast<u32>((allocation + align - 1) & ~uptr{align - 1});
		std::memset(reinterpret_cast<void*>(static_cast<uptr>(memory_base)), 0, memory_size);
	}
	u32 index;
	{
		std::lock_guard lock(g_spu_web_hot_mutex);
		// Reserved under this lock so the registry stays in index order, which is what lets a worker
		// decide from the highest index it placed whether a published entry is placed here
		const u32 elem_base = web_hot_table_reserve(table_size + 1);
		index = elem_base + table_size;
		g_spu_web_hot_entries.push_back({ entry, index, std::move(module), 1, elem_base, table_size, memory_base, imports_table });
		if (const u32 slot = index - g_spu_web_hot_base.load(); slot < spu_web_hot_limit * 2) g_spu_web_hot_kinds[slot].store(1);
		g_spu_web_hot_count.store(::size32(g_spu_web_hot_entries));
	}
	g_spu_web_llvm_registered++;
	g_spu_web_llvm_bytes += size;
	const u32 pair[2] = { entry, index };
	spu_web_aot_register_front(pair, 1);
	return index;
}

// Eight words for the per-worker placement (rpcs3_web_pre.js): kind, index, bytes, size, elem base, table size, memory base, imports table
extern void spu_web_hot_info(u32 i, u32* out)
{
	std::lock_guard lock(g_spu_web_hot_mutex);
	if (i >= g_spu_web_hot_entries.size())
	{
		std::fill_n(out, 8, 0);
		return;
	}
	const auto& e = g_spu_web_hot_entries[i];
	out[0] = e.kind;
	out[1] = e.index;
	out[2] = static_cast<u32>(reinterpret_cast<uptr>(e.bytes.data()));
	out[3] = ::size32(e.bytes);
	out[4] = e.elem_base;
	out[5] = e.table_size;
	out[6] = e.memory_base;
	out[7] = e.imports_table;
}

void spu_wasm_recompiler::init()
{
	if (!m_spurt)
	{
		m_spurt = &g_fxo->get<spu_runtime>();
	}
}

// A built module becomes a dispatch candidate of its entry; returns the table index
static u32 spu_web_hot_register_module(u32 entry, std::vector<u8> module)
{
	g_spu_web_hot_compiled++;
	g_spu_web_hot_bytes += ::size32(module);
	u32 index;
	{
		std::lock_guard lock(g_spu_web_hot_mutex);
		index = web_hot_table_reserve(1);
		g_spu_web_hot_entries.push_back({ entry, index, std::move(module) });
		g_spu_web_hot_count.store(::size32(g_spu_web_hot_entries));
	}
	const u32 pair[2] = { entry, index };
	spu_web_aot_register(pair, 1);
	return index;
}

// SPUCommonRecompiler.cpp: hands an item to the SPU LLVM thread (spu_llvm::registered)
extern void spu_web_llvm_enqueue_item(u64 hash, spu_item* item);

spu_function_t spu_wasm_recompiler::compile(spu_program&& _func)
{
	init();

	// One item per (program, entry): a second miss on a registered or refused program returns here
	const auto add_loc = m_spurt->add_empty(std::move(_func));

	if (!add_loc)
	{
		return nullptr;
	}

	if (const auto compiled = add_loc->compiled.load())
	{
		return compiled;
	}

	const spu_program& func = add_loc->data;

	if (!build(func))
	{
		// Stays on the interpreter; the marker keeps the next miss from retrying
		g_spu_web_hot_refused++;
		const auto colon = m_refusal.find(": ");
		{
			std::lock_guard lock(g_spu_web_hot_mutex);
			if (g_spu_web_hot_refusals.size() < 256) g_spu_web_hot_refusals[colon == std::string::npos ? m_refusal : m_refusal.substr(colon + 2)]++;
		}
		add_loc->compiled = spu_runtime::tr_interpreter;
		add_loc->compiled.notify_all();
		return nullptr;
	}

	spu_web_hot_register_module(func.entry_point, take_module());
	add_loc->compiled = spu_runtime::tr_interpreter;

	if (g_cfg.core.spu_decoder == spu_decoder_type::llvm)
	{
		// Send work to the SPU LLVM thread, as the native fast tier does
		spu_web_llvm_enqueue_item(m_hash_start, add_loc);
	}

	add_loc->compiled.notify_all();
	return add_loc->compiled;
}

// Dispatch miss in spu_web_interpreter_loop: the sequence of spu_recompiler_base::dispatch
extern bool spu_web_try_compile(spu_thread& spu)
{
	if (!spu.jit || !web_hot_table_base() || spu._ref<u32>(spu.pc) == 0u)
	{
		return false;
	}

	spu.jit->init();
	auto program = spu.jit->analyse(spu._ptr<u32>(0), spu.pc);
	return spu.jit->compile(std::move(program)) != nullptr;
}

extern std::string spu_web_hot_report()
{
	std::lock_guard lock(g_spu_web_hot_mutex);
	std::string out = fmt::format("{\"compiled\":%u,\"registered\":%u,\"refused\":%u,\"bytes\":%u,\"refusals\":{", +g_spu_web_hot_compiled, ::size32(g_spu_web_hot_entries), +g_spu_web_hot_refused, +g_spu_web_hot_bytes);
	std::vector<std::pair<u32, std::string>> sorted;
	for (const auto& [why, n] : g_spu_web_hot_refusals) sorted.emplace_back(n, why);
	std::sort(sorted.rbegin(), sorted.rend());
	for (usz i = 0; i < sorted.size() && i < 24; i++) fmt::append(out, "%s\"%s\":%u", i ? "," : "", sorted[i].second, sorted[i].first);
	u64 hot_dispatches = 0, llvm_dispatches = 0;
	for (const auto& counts : g_spu_web_tier_counts)
	{
		hot_dispatches += counts.hot.load();
		llvm_dispatches += counts.llvm.load();
	}
	fmt::append(out, "},\"dispatches\":%u,\"llvm\":{\"enabled\":%u,\"requested\":%u,\"failed\":%u,\"abandoned\":%u,\"registered\":%u,\"bytes\":%u,\"dispatches\":%u}}", hot_dispatches, +g_spu_web_llvm_enabled, +g_spu_web_llvm_requested, +g_spu_web_llvm_failed, +g_spu_web_llvm_abandoned, +g_spu_web_llvm_registered, +g_spu_web_llvm_bytes, llvm_dispatches);
	return out;
}
#endif

