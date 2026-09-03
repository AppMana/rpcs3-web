#pragma once

// SPU program -> WebAssembly recompiler for the web build.
//
// A backend port of RPCS3's SPU recompiler at the spu_recompiler_base seam (the ASMJIT
// recompiler lowers instruction by instruction to x86; this one lowers to wasm SIMD). The
// module it produces follows the contract of the SPU LLVM recompiler's wasm mode, which is
// what the SPU AOT bundle parts use, so the runtime loads it through the same table path:
//
//   export "__spu-0x<entry>-<hash>": (thread: i32, ls: i32, arg2: i64) -> ()
//   imports env.memory and the env.spu_* helpers rpcs3-spu-aot-table.mjs binds
//
// Prologue: escape when the thread state is set; verify the local store against the
// program words (mismatch: block_failure++, spu_dispatch, return). Body: the program's
// blocks under a loop / br_table dispatch on pc, in address order so fallthrough is free.
// Leaving the program stores pc and returns; the SPU thread loop re-dispatches.
//
// Instructions come from SPUInterpreter.cpp semantics on RPCS3's register layout (a
// register is the 16-byte-reversed local-store quadword; preferred slot = lane 3). An
// instruction without a lowering makes compile() refuse the program, which then stays on
// the interpreter: coverage grows without ever running wrong code.

#include "SPURecompiler.h"

#include <vector>

class spu_wasm_recompiler final : public spu_recompiler_base
{
public:
	spu_wasm_recompiler();
	~spu_wasm_recompiler() override;

	void init() override;

	// The fast tier of the web build, in the role spu_fast plays natively: registers the program
	// with spu_runtime (add_empty), builds its module into the hot registry as a dispatch
	// candidate, and hands the item to the SPU LLVM thread when the decoder is llvm. Returns the
	// non-null marker spu_runtime::tr_interpreter for a registered program (wasm has no native
	// entry address), nullptr when the program was refused.
	spu_function_t compile(spu_program&&) override;

	// Module construction alone (the self-test and the native differential lanes): the bytes are
	// in take_module(), empty after a refusal
	bool build(const spu_program& func);

	// Module bytes of the last successful build (empty after a refusal)
	std::vector<u8> take_module();

	const std::string& last_export_name() const { return m_export_name; }
	const std::string& last_refusal() const { return m_refusal; }

	// Emits every instruction; the decoder calls these (spu_decoder<spu_wasm_recompiler>)
#define SPU_WASM_INSTRUCTION(name) void name(spu_opcode_t op);
	SPU_WASM_INSTRUCTION(UNK)
	SPU_WASM_INSTRUCTION(STOP)
	SPU_WASM_INSTRUCTION(LNOP)
	SPU_WASM_INSTRUCTION(SYNC)
	SPU_WASM_INSTRUCTION(DSYNC)
	SPU_WASM_INSTRUCTION(MFSPR)
	SPU_WASM_INSTRUCTION(RDCH)
	SPU_WASM_INSTRUCTION(RCHCNT)
	SPU_WASM_INSTRUCTION(SF)
	SPU_WASM_INSTRUCTION(OR)
	SPU_WASM_INSTRUCTION(BG)
	SPU_WASM_INSTRUCTION(SFH)
	SPU_WASM_INSTRUCTION(NOR)
	SPU_WASM_INSTRUCTION(ABSDB)
	SPU_WASM_INSTRUCTION(ROT)
	SPU_WASM_INSTRUCTION(ROTM)
	SPU_WASM_INSTRUCTION(ROTMA)
	SPU_WASM_INSTRUCTION(SHL)
	SPU_WASM_INSTRUCTION(ROTH)
	SPU_WASM_INSTRUCTION(ROTHM)
	SPU_WASM_INSTRUCTION(ROTMAH)
	SPU_WASM_INSTRUCTION(SHLH)
	SPU_WASM_INSTRUCTION(ROTI)
	SPU_WASM_INSTRUCTION(ROTMI)
	SPU_WASM_INSTRUCTION(ROTMAI)
	SPU_WASM_INSTRUCTION(SHLI)
	SPU_WASM_INSTRUCTION(ROTHI)
	SPU_WASM_INSTRUCTION(ROTHMI)
	SPU_WASM_INSTRUCTION(ROTMAHI)
	SPU_WASM_INSTRUCTION(SHLHI)
	SPU_WASM_INSTRUCTION(A)
	SPU_WASM_INSTRUCTION(AND)
	SPU_WASM_INSTRUCTION(CG)
	SPU_WASM_INSTRUCTION(AH)
	SPU_WASM_INSTRUCTION(NAND)
	SPU_WASM_INSTRUCTION(AVGB)
	SPU_WASM_INSTRUCTION(MTSPR)
	SPU_WASM_INSTRUCTION(WRCH)
	SPU_WASM_INSTRUCTION(BIZ)
	SPU_WASM_INSTRUCTION(BINZ)
	SPU_WASM_INSTRUCTION(BIHZ)
	SPU_WASM_INSTRUCTION(BIHNZ)
	SPU_WASM_INSTRUCTION(STOPD)
	SPU_WASM_INSTRUCTION(STQX)
	SPU_WASM_INSTRUCTION(BI)
	SPU_WASM_INSTRUCTION(BISL)
	SPU_WASM_INSTRUCTION(IRET)
	SPU_WASM_INSTRUCTION(BISLED)
	SPU_WASM_INSTRUCTION(HBR)
	SPU_WASM_INSTRUCTION(GB)
	SPU_WASM_INSTRUCTION(GBH)
	SPU_WASM_INSTRUCTION(GBB)
	SPU_WASM_INSTRUCTION(FSM)
	SPU_WASM_INSTRUCTION(FSMH)
	SPU_WASM_INSTRUCTION(FSMB)
	SPU_WASM_INSTRUCTION(FREST)
	SPU_WASM_INSTRUCTION(FRSQEST)
	SPU_WASM_INSTRUCTION(LQX)
	SPU_WASM_INSTRUCTION(ROTQBYBI)
	SPU_WASM_INSTRUCTION(ROTQMBYBI)
	SPU_WASM_INSTRUCTION(SHLQBYBI)
	SPU_WASM_INSTRUCTION(CBX)
	SPU_WASM_INSTRUCTION(CHX)
	SPU_WASM_INSTRUCTION(CWX)
	SPU_WASM_INSTRUCTION(CDX)
	SPU_WASM_INSTRUCTION(ROTQBI)
	SPU_WASM_INSTRUCTION(ROTQMBI)
	SPU_WASM_INSTRUCTION(SHLQBI)
	SPU_WASM_INSTRUCTION(ROTQBY)
	SPU_WASM_INSTRUCTION(ROTQMBY)
	SPU_WASM_INSTRUCTION(SHLQBY)
	SPU_WASM_INSTRUCTION(ORX)
	SPU_WASM_INSTRUCTION(CBD)
	SPU_WASM_INSTRUCTION(CHD)
	SPU_WASM_INSTRUCTION(CWD)
	SPU_WASM_INSTRUCTION(CDD)
	SPU_WASM_INSTRUCTION(ROTQBII)
	SPU_WASM_INSTRUCTION(ROTQMBII)
	SPU_WASM_INSTRUCTION(SHLQBII)
	SPU_WASM_INSTRUCTION(ROTQBYI)
	SPU_WASM_INSTRUCTION(ROTQMBYI)
	SPU_WASM_INSTRUCTION(SHLQBYI)
	SPU_WASM_INSTRUCTION(NOP)
	SPU_WASM_INSTRUCTION(CGT)
	SPU_WASM_INSTRUCTION(XOR)
	SPU_WASM_INSTRUCTION(CGTH)
	SPU_WASM_INSTRUCTION(EQV)
	SPU_WASM_INSTRUCTION(CGTB)
	SPU_WASM_INSTRUCTION(SUMB)
	SPU_WASM_INSTRUCTION(HGT)
	SPU_WASM_INSTRUCTION(CLZ)
	SPU_WASM_INSTRUCTION(XSWD)
	SPU_WASM_INSTRUCTION(XSHW)
	SPU_WASM_INSTRUCTION(CNTB)
	SPU_WASM_INSTRUCTION(XSBH)
	SPU_WASM_INSTRUCTION(CLGT)
	SPU_WASM_INSTRUCTION(ANDC)
	SPU_WASM_INSTRUCTION(FCGT)
	SPU_WASM_INSTRUCTION(DFCGT)
	SPU_WASM_INSTRUCTION(FA)
	SPU_WASM_INSTRUCTION(FS)
	SPU_WASM_INSTRUCTION(FM)
	SPU_WASM_INSTRUCTION(CLGTH)
	SPU_WASM_INSTRUCTION(ORC)
	SPU_WASM_INSTRUCTION(FCMGT)
	SPU_WASM_INSTRUCTION(DFCMGT)
	SPU_WASM_INSTRUCTION(DFA)
	SPU_WASM_INSTRUCTION(DFS)
	SPU_WASM_INSTRUCTION(DFM)
	SPU_WASM_INSTRUCTION(CLGTB)
	SPU_WASM_INSTRUCTION(HLGT)
	SPU_WASM_INSTRUCTION(DFMA)
	SPU_WASM_INSTRUCTION(DFMS)
	SPU_WASM_INSTRUCTION(DFNMS)
	SPU_WASM_INSTRUCTION(DFNMA)
	SPU_WASM_INSTRUCTION(CEQ)
	SPU_WASM_INSTRUCTION(MPYHHU)
	SPU_WASM_INSTRUCTION(ADDX)
	SPU_WASM_INSTRUCTION(SFX)
	SPU_WASM_INSTRUCTION(CGX)
	SPU_WASM_INSTRUCTION(BGX)
	SPU_WASM_INSTRUCTION(MPYHHA)
	SPU_WASM_INSTRUCTION(MPYHHAU)
	SPU_WASM_INSTRUCTION(FSCRRD)
	SPU_WASM_INSTRUCTION(FESD)
	SPU_WASM_INSTRUCTION(FRDS)
	SPU_WASM_INSTRUCTION(FSCRWR)
	SPU_WASM_INSTRUCTION(DFTSV)
	SPU_WASM_INSTRUCTION(FCEQ)
	SPU_WASM_INSTRUCTION(DFCEQ)
	SPU_WASM_INSTRUCTION(MPY)
	SPU_WASM_INSTRUCTION(MPYH)
	SPU_WASM_INSTRUCTION(MPYHH)
	SPU_WASM_INSTRUCTION(MPYS)
	SPU_WASM_INSTRUCTION(CEQH)
	SPU_WASM_INSTRUCTION(FCMEQ)
	SPU_WASM_INSTRUCTION(DFCMEQ)
	SPU_WASM_INSTRUCTION(MPYU)
	SPU_WASM_INSTRUCTION(CEQB)
	SPU_WASM_INSTRUCTION(FI)
	SPU_WASM_INSTRUCTION(HEQ)
	SPU_WASM_INSTRUCTION(CFLTS)
	SPU_WASM_INSTRUCTION(CFLTU)
	SPU_WASM_INSTRUCTION(CSFLT)
	SPU_WASM_INSTRUCTION(CUFLT)
	SPU_WASM_INSTRUCTION(BRZ)
	SPU_WASM_INSTRUCTION(STQA)
	SPU_WASM_INSTRUCTION(BRNZ)
	SPU_WASM_INSTRUCTION(BRHZ)
	SPU_WASM_INSTRUCTION(BRHNZ)
	SPU_WASM_INSTRUCTION(STQR)
	SPU_WASM_INSTRUCTION(BRA)
	SPU_WASM_INSTRUCTION(LQA)
	SPU_WASM_INSTRUCTION(BRASL)
	SPU_WASM_INSTRUCTION(BR)
	SPU_WASM_INSTRUCTION(FSMBI)
	SPU_WASM_INSTRUCTION(BRSL)
	SPU_WASM_INSTRUCTION(LQR)
	SPU_WASM_INSTRUCTION(IL)
	SPU_WASM_INSTRUCTION(ILHU)
	SPU_WASM_INSTRUCTION(ILH)
	SPU_WASM_INSTRUCTION(IOHL)
	SPU_WASM_INSTRUCTION(ORI)
	SPU_WASM_INSTRUCTION(ORHI)
	SPU_WASM_INSTRUCTION(ORBI)
	SPU_WASM_INSTRUCTION(SFI)
	SPU_WASM_INSTRUCTION(SFHI)
	SPU_WASM_INSTRUCTION(ANDI)
	SPU_WASM_INSTRUCTION(ANDHI)
	SPU_WASM_INSTRUCTION(ANDBI)
	SPU_WASM_INSTRUCTION(AI)
	SPU_WASM_INSTRUCTION(AHI)
	SPU_WASM_INSTRUCTION(STQD)
	SPU_WASM_INSTRUCTION(LQD)
	SPU_WASM_INSTRUCTION(XORI)
	SPU_WASM_INSTRUCTION(XORHI)
	SPU_WASM_INSTRUCTION(XORBI)
	SPU_WASM_INSTRUCTION(CGTI)
	SPU_WASM_INSTRUCTION(CGTHI)
	SPU_WASM_INSTRUCTION(CGTBI)
	SPU_WASM_INSTRUCTION(HGTI)
	SPU_WASM_INSTRUCTION(CLGTI)
	SPU_WASM_INSTRUCTION(CLGTHI)
	SPU_WASM_INSTRUCTION(CLGTBI)
	SPU_WASM_INSTRUCTION(HLGTI)
	SPU_WASM_INSTRUCTION(MPYI)
	SPU_WASM_INSTRUCTION(MPYUI)
	SPU_WASM_INSTRUCTION(CEQI)
	SPU_WASM_INSTRUCTION(CEQHI)
	SPU_WASM_INSTRUCTION(CEQBI)
	SPU_WASM_INSTRUCTION(HEQI)
	SPU_WASM_INSTRUCTION(HBRA)
	SPU_WASM_INSTRUCTION(HBRR)
	SPU_WASM_INSTRUCTION(ILA)
	SPU_WASM_INSTRUCTION(SELB)
	SPU_WASM_INSTRUCTION(SHUFB)
	SPU_WASM_INSTRUCTION(MPYA)
	SPU_WASM_INSTRUCTION(FNMS)
	SPU_WASM_INSTRUCTION(FMA)
	SPU_WASM_INSTRUCTION(FMS)
#undef SPU_WASM_INSTRUCTION

private:
	// Byte buffer with wasm encodings
	struct code
	{
		std::vector<u8> b;
		void emit8(u32 v) { b.push_back(static_cast<u8>(v)); }
		void uleb(u64 v);
		void sleb(s64 v);
		void bytes(const void* p, usz n);
		void op(u32 opcode) { emit8(opcode); }
		void simd(u32 opcode) { emit8(0xfd); uleb(opcode); }
		void i32c(s32 v) { op(0x41); sleb(v); }
		void i64c(s64 v) { op(0x42); sleb(v); }
		void local_get(u32 i) { op(0x20); uleb(i); }
		void local_set(u32 i) { op(0x21); uleb(i); }
		void local_tee(u32 i) { op(0x22); uleb(i); }
		void call(u32 f) { op(0x10); uleb(f); }
		void br(u32 depth) { op(0x0c); uleb(depth); }
		void br_if(u32 depth) { op(0x0d); uleb(depth); }
		void block_void() { op(0x02); emit8(0x40); }
		void loop_void() { op(0x03); emit8(0x40); }
		void if_void() { op(0x04); emit8(0x40); }
		void else_() { op(0x05); }
		void end() { op(0x0b); }
		void ret() { op(0x0f); }
		void i32_load(u32 offset) { op(0x28); uleb(2); uleb(offset); }
		void i32_store(u32 offset) { op(0x36); uleb(2); uleb(offset); }
		void i64_load(u32 offset) { op(0x29); uleb(3); uleb(offset); }
		void i64_store(u32 offset) { op(0x37); uleb(3); uleb(offset); }
		void v128_load(u32 offset) { simd(0); uleb(4); uleb(offset); }
		void v128_store(u32 offset) { simd(11); uleb(4); uleb(offset); }
		void v128_const(const u8* bytes16) { simd(12); bytes(bytes16, 16); }
		void v128_const32(u32 a, u32 b, u32 c, u32 d);
		void shuffle(const u8* lanes16) { simd(13); bytes(lanes16, 16); }
	};

	// Locals of the program function
	enum : u32 { l_thread = 0, l_ls = 1, l_arg2 = 2, l_pc = 3, l_t0 = 4, l_t1 = 5, l_t2 = 6, l_v0 = 7, l_v1 = 8, l_v2 = 9, l_v3 = 10, l_i64 = 11 };
	// Imports (function indices)
	enum : u32
	{
		f_escape = 0, f_dispatch, f_check_state, f_read_channel, f_read_channel_count, f_write_channel, f_mfc_cmd,
		f_check_interrupts, f_syscall, f_unknown, f_fatal, f_read_in_mbox, f_read_decrementer, f_read_events, f_get_events, f_list_unstall,
		f_get_tb, f_import_count
	};

	void refuse(const std::string& why);
	bool refused() const { return !m_refusal.empty(); }

	// Emission helpers
	void gpr_load(u32 reg);              // pushes v128
	void gpr_store(u32 reg);             // pops v128 (thread pointer pushed by the helper)
	void gpr_store_begin();              // pushes the thread pointer for a later gpr_store_end
	void gpr_store_end(u32 reg);
	void gpr_lane3(u32 reg);             // pushes i32 preferred slot
	void splat32(u32 value);             // pushes v128
	void splat16(u32 value);
	void splat8(u32 value);
	void from32r();                      // pops i32, pushes v128 {0,0,0,x}
	void ls_load_reversed();             // pops i32 LS address, pushes v128 register image
	void ls_store_reversed(u32 reg);     // pops i32 LS address, stores gpr[reg]
	void reverse16();                    // v128 byte reversal of the top of stack
	void store_pc(u32 pc);               // thread.pc = pc
	void store_pc_local();               // thread.pc = local pc
	void branch_to(u32 target);          // in-program: re-dispatch; else store pc and exit
	void branch_dynamic();               // pops i32 target
	void exit_program();                 // store pc local then exit
	void bail_to_interpreter();          // pc = current instruction; exit (rare/hard instructions)
	void state_test(u32 next_pc);        // after a helper: escape if the state requires it
	void per_lane32(auto&& emit_scalar); // scalar per lane helper (extract/replace)
	void per_lane16(auto&& emit_scalar);
	void insertion_mask(u32 width_log2); // pops i32 element index, pushes the generate-controls mask
	void cxd_index(spu_opcode_t op, bool x_form, u32 mask, u32 shift);
	void quad_bit_shift(u32 kind, bool dynamic, u32 imm);
	void fm_masked_product(spu_opcode_t op);
	void fcgt_operand(u32 reg);
	void conditional_indirect(spu_opcode_t op, bool halfword, bool branch_if_zero);
	spu_opcode_t m_op{};

	u32 m_pc = 0;                        // address of the instruction being lowered
	u32 m_lower = 0;                     // program range
	u32 m_upper = 0;
	u32 m_depth = 0;                     // nesting depth of the current position relative to the dispatch loop
	u32 m_loop_depth = 0;                // br depth reaching the dispatch loop from m_depth == 0
	u32 m_exit_depth = 0;
	std::vector<bool> m_is_block_start;  // per word of the program
	code m_code;
	std::vector<u8> m_module;
	std::string m_export_name;
	std::string m_refusal;
};

// Compiles a program found at pc in the thread's local store; returns the module bytes and the
// export name, or empty bytes when the program is refused (reason in `why`).
std::vector<u8> spu_web_compile_ls(const be_t<u32>* ls, u32 pc, std::string& export_name, u32& entry, std::string& why);
