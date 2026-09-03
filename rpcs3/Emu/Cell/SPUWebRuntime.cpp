#include "stdafx.h"

#include "SPURecompiler.h"
#include "SPUWasmRecompiler.h"
#include "SPUInterpreter.h"
#include "SPUOpcodes.h"

#include "util/simd.hpp"
#include "util/v128.hpp"

#include <algorithm>
#include <bit>
#include <csetjmp>
#include <cstring>

const extern spu_decoder<spu_itype> g_spu_itype;

namespace
{
	thread_local std::jmp_buf* s_escape_context = nullptr;

	[[noreturn]] void web_spu_escape(spu_thread*)
	{
		if (s_escape_context)
		{
			std::longjmp(*s_escape_context, 1);
		}

		__builtin_trap();
	}

	[[noreturn]] void web_spu_tail_escape(spu_thread* spu, spu_function_t, u8*)
	{
		web_spu_escape(spu);
	}

	[[noreturn]] void web_spu_gateway(spu_thread&, void*, u8*)
	{
		__builtin_trap();
	}
}

// Compiled blocks running on the SPU pthread escape through the same buffer the interpreter uses
[[noreturn]] void spu_web_escape_now(spu_thread* spu)
{
	web_spu_escape(spu);
}

void spu_web_set_escape_context(std::jmp_buf* context) noexcept
{
	s_escape_context = context;
#if defined(RPCS3_PORTABLE_SPU_INTERPRETER)
	spu_runtime::g_escape = &web_spu_escape;
	spu_runtime::g_tail_escape = &web_spu_tail_escape;
#endif
}

#if !defined(RPCS3_PORTABLE_SPU_INTERPRETER)
std::array<atomic_t<spu_function_t>, (1 << 20)>* const spu_runtime::g_dispatcher = nullptr;
const spu_function_t spu_runtime::g_gateway = &web_spu_gateway;
void (*const spu_runtime::g_escape)(spu_thread*) = &web_spu_escape;
void (*const spu_runtime::g_tail_escape)(spu_thread*, spu_function_t, u8*) = &web_spu_tail_escape;
std::array<u64, 256> spu_runtime::g_interpreter_table{};

// The x86 trampolines have no wasm equivalent; the LLVM recompiler names them only to type its
// helper calls, and returns tr_interpreter as the non-null "exported" marker.
const spu_function_t spu_runtime::tr_dispatch = &web_spu_gateway;
const spu_function_t spu_runtime::tr_branch = &web_spu_gateway;
const spu_function_t spu_runtime::tr_interpreter = &web_spu_gateway;
const spu_function_t spu_runtime::tr_all = &web_spu_gateway;

// The native registry dedupes by code words alone because a native function serves every entry of
// its program; a wasm side module serves one exported entry, so a new entry into identical code is
// a new item (otherwise compile() would wait for a `compiled` flag the web path never sets).
spu_item* spu_runtime::add_empty(spu_program&& data)
{
	if (data.data.empty())
	{
		return nullptr;
	}

	spu_item* prev = nullptr;

	const auto ret = m_stuff[data.data[0] >> 12].push_if([&](spu_item& _new, spu_item& _old)
	{
		if (_new.data == _old.data && _new.data.entry_point == _old.data.entry_point)
		{
			prev = &_old;
			return false;
		}

		return true;
	}, std::move(data));

	if (ret)
	{
		return ret;
	}

	return prev;
}
spu_function_t spu_runtime::g_interpreter = nullptr;

spu_cache::spu_cache(const std::string& loc)
	: m_file(loc, fs::read + fs::write + fs::create + fs::append)
{
}

spu_cache::~spu_cache() = default;

// The browser keeps no SPU program cache file (the LLVM tier registers into the live table instead)
void spu_cache::add(const spu_program&)
{
}

// This hook only mines embedded SPU programs for the native LLVM
// precompilation cache. The browser selects RPCS3's static interpreter, so
// there is no JIT cache to populate and execution does not consume this data.
void utilize_spu_data_segment(u32, const void*, u32)
{
}

// Kept byte-for-byte equivalent to RPCS3's shared function discovery logic in
// SPUCommonRecompiler.cpp. It is analysis used by RawSPU loading as well as by
// recompilers, and must remain available when the native JIT backends are not.
std::vector<u32> spu_thread::discover_functions(u32 base_addr, std::span<const u8> ls, bool is_known_addr, u32 /*entry*/)
{
	std::vector<u32> calls;
	std::vector<u32> branches;

	calls.reserve(100);

	const v128 brasl_mask = is_known_addr ? v128::from32p(0x62u << 23) : v128::from32p(umax);

	for (u32 i = base_addr, end_ls = std::min<u32>(base_addr + ::size32(ls), SPU_LS_SIZE); i < end_ls; i = utils::align<u32>(i + 1, 0x10))
	{
		be_t<v128> inst_be{};

		if (end_ls - i < 16)
		{
			std::memcpy(&inst_be, ls.data() + (i - base_addr), end_ls - i);
		}
		else
		{
			inst_be = read_from_ptr<be_t<v128>>(ls, i - base_addr);
		}

		const v128 inst = inst_be;
		const v128 cleared_i16 = gv_and32(inst, v128::from32p(std::rotl<u32>(~0xffff, 7)));
		const v128 eq_brsl = gv_eq32(cleared_i16, v128::from32p(0x66u << 23));
		const v128 eq_brasl = gv_eq32(cleared_i16, brasl_mask);
		const v128 eq_br = gv_eq32(cleared_i16, v128::from32p(0x64u << 23));
		const v128 result = eq_brsl | eq_brasl;

		if (!gv_testz(result))
		{
			for (u32 j = 0; j < 4; j++)
			{
				if (result.u32r[j]) calls.push_back(i + j * 4);
			}
		}

		if (!gv_testz(eq_br))
		{
			for (u32 j = 0; j < 4; j++)
			{
				if (eq_br.u32r[j]) branches.push_back(i + j * 4);
			}
		}
	}

	calls.erase(std::remove_if(calls.begin(), calls.end(), [&](u32 caller)
	{
		return !is_exec_code(caller, ls, base_addr, true) || !is_exec_code(caller + 4, ls, base_addr, true);
	}), calls.end());

	branches.erase(std::remove_if(branches.begin(), branches.end(), [&](u32 caller)
	{
		return !is_exec_code(caller, ls, base_addr, true);
	}), branches.end());

	std::vector<u32> addrs;

	for (u32 addr : calls)
	{
		const spu_opcode_t op{read_from_ptr<be_t<u32>>(ls, addr - base_addr)};
		const u32 func = op_branch_targets(addr, op)[0];

		if (func == umax || addr + 4 == func || func == addr || std::count(addrs.begin(), addrs.end(), func)) continue;
		if (std::count(calls.begin(), calls.end(), func)) continue;

		addrs.push_back(func);

		for (u32 next = func, it = 10; it && next >= base_addr && next < std::min<u32>(base_addr + ::size32(ls), 0x3FFF0); it--, next += 4)
		{
			const spu_opcode_t test_op{read_from_ptr<be_t<u32>>(ls, next - base_addr)};
			const auto type = g_spu_itype.decode(test_op.opcode);

			if (type & spu_itype::branch && type != spu_itype::BR) break;
			if (type == spu_itype::UNK || !test_op.opcode) break;
			if (type != spu_itype::BR) continue;

			const u32 target = op_branch_targets(next, op)[0];
			if (target == umax || addr + 4 == target || target == addr || std::count(addrs.begin(), addrs.end(), target)) break;
			if (target >= func && target <= next) break;
			if (!is_exec_code(target, ls, base_addr, true)) break;

			addrs.push_back(target);
			break;
		}
	}

	for (u32 addr : branches)
	{
		const spu_opcode_t op{read_from_ptr<be_t<u32>>(ls, addr - base_addr)};
		const u32 func = op_branch_targets(addr, op)[0];

		if (func == umax || addr + 4 == func || func == addr || !addr) continue;

		for (u32 next = func, it = 10; it && next >= base_addr && next < std::min<u32>(base_addr + ::size32(ls), 0x3FFF0); it--, next += 4)
		{
			const spu_opcode_t test_op{read_from_ptr<be_t<u32>>(ls, next - base_addr)};
			const auto type = g_spu_itype.decode(test_op.opcode);

			if (type & spu_itype::branch) break;
			if (type == spu_itype::UNK || !test_op.opcode) break;

			bool is_func = false;
			if (type == spu_itype::AI && test_op.rt == 1u && test_op.ra == 1u)
			{
				if (test_op.si10 >= 0) break;
				is_func = true;
			}

			if (!is_func) continue;
			addr = SPU_LS_SIZE + 4;
			if (std::count(addrs.begin(), addrs.end(), func)) break;
			addrs.push_back(func);
			break;
		}

		for (u32 back = addr - 4, it = 10; it && back >= base_addr && back < std::min<u32>(base_addr + ::size32(ls), 0x3FFF0); it--, back -= 4)
		{
			const spu_opcode_t test_op{read_from_ptr<be_t<u32>>(ls, back - base_addr)};
			const auto type = g_spu_itype.decode(test_op.opcode);

			if (type & spu_itype::branch) break;

			bool is_tail = false;
			if (type == spu_itype::AI && test_op.rt == 1u && test_op.ra == 1u)
			{
				if (test_op.si10 <= 0) break;
				is_tail = true;
			}
			else if (!(type & spu_itype::zregmod))
			{
				const u32 op_rt = type & spu_itype::_quadrop ? +test_op.rt4 : +test_op.rt;
				if (op_rt >= 80u && (type != spu_itype::LQD || test_op.ra != 1u)) break;
			}

			if (!is_tail) continue;
			if (std::count(addrs.begin(), addrs.end(), func)) break;
			addrs.push_back(func);
			break;
		}
	}

	std::sort(addrs.begin(), addrs.end());
	return addrs;
}
#endif

#if !defined(RPCS3_PORTABLE_SPU_INTERPRETER)
// The analysis half of SPUCommonRecompiler.cpp is compiled on the web (spu_recompiler_base::analyse
// feeds the SPU AOT miss recorder); the native JIT runtime it names has no web implementation.
// The native portable-interpreter lane links the native recompilers alongside this file.
spu_runtime::spu_runtime()
{
}

// The web's fast tier in asmjit's role: the SPU->wasm recompiler
std::unique_ptr<spu_recompiler_base> spu_recompiler_base::make_asmjit_recompiler()
{
	return std::make_unique<spu_wasm_recompiler>();
}
#endif
