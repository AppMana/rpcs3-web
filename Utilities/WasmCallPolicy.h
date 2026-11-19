#pragma once

#include "WasmStubMap.h"
#include <charconv>
#include <cstdint>
#include <llvm/Analysis/ValueTracking.h>
#include <llvm/IR/Attributes.h>
#include <llvm/IR/Constants.h>
#include <llvm/IR/IRBuilder.h>
#include <llvm/IR/Instructions.h>
#include <llvm/IR/Module.h>
#include <llvm/Support/FormatVariadic.h>
#include <llvm/Transforms/Utils/BasicBlockUtils.h>
#include <llvm/Transforms/Utils/Cloning.h>
#include <vector>

namespace wasm_codegen
{
	inline bool extract_const_u32(const llvm::Value* v, uint32_t& out)
	{
		if (!v) return false;
		if (const auto* ci = llvm::dyn_cast<llvm::ConstantInt>(v))
		{
			out = static_cast<uint32_t>(ci->getZExtValue());
			return true;
		}
		if (const auto* trunc = llvm::dyn_cast<llvm::TruncInst>(v))
		{
			return extract_const_u32(trunc->getOperand(0), out);
		}
		if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(v); bin && bin->getOpcode() == llvm::Instruction::Add)
		{
			const auto* c0 = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(0));
			const auto* c1 = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1));
			if (c0 && c1)
			{
				out = static_cast<uint32_t>(c0->getZExtValue() + c1->getZExtValue());
				return true;
			}
		}
		return false;
	}

	// Mark PPU runtime helper declarations and block arguments as non-capturing so LLVM BasicAA
	// proves that guest memory helpers (@rpcs3_web_vm_read*_raw / @rpcs3_web_vm_write*_raw)
	// cannot alias %1 (ppu_thread*) or %0 (AOT dispatch table).
	inline void mark_nocapture_helpers(llvm::Module& module)
	{
		auto& ctx = module.getContext();
		const auto nocap = llvm::Attribute::getWithCaptureInfo(ctx, llvm::CaptureInfo::none());
		for (auto& fn : module)
		{
			if (fn.isDeclaration())
			{
				const auto name = fn.getName();
				if ((name == "__check" || name == "__syscall" || name == "__hle_call_fnid"
					|| name == "__lwarx" || name == "__ldarx" || name == "__stwcx"
					|| name == "__stdcx" || name == "__trap" || name == "__error" || name == "__lv1call")
					&& fn.arg_size() >= 1 && fn.getArg(0)->getType()->isPointerTy())
				{
					fn.addParamAttr(0, nocap);
				}
				if (name == "rpcs3_web_vm_read8_raw" || name == "rpcs3_web_vm_read16_raw"
					|| name == "rpcs3_web_vm_read32_raw" || name == "rpcs3_web_vm_read64_raw")
				{
					fn.addFnAttr(llvm::Attribute::NoUnwind);
					fn.addFnAttr(llvm::Attribute::WillReturn);
					fn.setMemoryEffects(llvm::MemoryEffects::inaccessibleMemOnly(llvm::ModRefInfo::ModRef));
				}
				if (name == "rpcs3_web_vm_write8_raw" || name == "rpcs3_web_vm_write16_raw"
					|| name == "rpcs3_web_vm_write32_raw" || name == "rpcs3_web_vm_write64_raw")
				{
					fn.addFnAttr(llvm::Attribute::NoUnwind);
					fn.addFnAttr(llvm::Attribute::WillReturn);
					fn.setMemoryEffects(llvm::MemoryEffects::inaccessibleMemOnly(llvm::ModRefInfo::ModRef));
				}
				continue;
			}
			if (!fn.getName().starts_with("__0x") || fn.arg_size() != 7) continue;
			fn.addParamAttr(0, llvm::Attribute::NoAlias);
			fn.addParamAttr(0, nocap);
			fn.addParamAttr(1, llvm::Attribute::NoAlias);
			fn.addParamAttr(1, nocap);
			fn.addParamAttr(1, llvm::Attribute::getWithDereferenceableBytes(ctx, 2048));
			fn.addParamAttr(1, llvm::Attribute::getWithAlignment(ctx, llvm::Align(16)));
			for (auto& bb : fn)
			{
				for (auto& inst : bb)
				{
					auto* call = llvm::dyn_cast<llvm::CallInst>(&inst);
					if (!call || !call->isMustTailCall() || call->arg_size() != 7) continue;
					call->addParamAttr(0, nocap);
					call->addParamAttr(1, nocap);
				}
			}
		}
	}

	inline bool parse_guest_fn_pc(llvm::StringRef name, uint32_t& out)
	{
		if (!name.starts_with("__0x")) return false;
		const auto hex = name.substr(4);
		return std::from_chars(hex.data(), hex.data() + hex.size(), out, 16).ec == std::errc{};
	}

	inline uint32_t find_const_lr_for_call(llvm::Function& function, const llvm::CallInst* call)
	{
		const llvm::BasicBlock* bb = call ? call->getParent() : nullptr;
		for (unsigned depth = 0; bb && depth < 4; ++depth)
		{
			for (auto it = depth == 0 ? call->getIterator() : bb->end(); it != bb->begin();)
			{
				const auto* store = llvm::dyn_cast<llvm::StoreInst>(&*--it);
				if (!store) continue;

				const auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(store->getPointerOperand());
				if (!gep || gep->getPointerOperand() != function.getArg(1) || gep->getNumIndices() != 2) continue;

				const auto* idx0 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(1));
				const auto* idx1 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(2));
				if (!idx0 || !idx1 || !idx0->isZero() || idx1->getZExtValue() != 163) continue;

				uint32_t lr = 0;
				return extract_const_u32(store->getValueOperand(), lr) ? lr : 0;
			}

			bb = bb->getSinglePredecessor();
		}

		return 0;
	}

	// Rewrite .sceStub.text import callers, .sceStub.text trampolines, and indirect bctr/bctrl
	// calls into direct @__hle_call_fnid calls and inline same-shard return continuations.
	inline unsigned lower_import_stub_calls(llvm::Module& module, std::span<const sce_stub_entry> stubs = active_sce_stubs(), bool is_relocatable_wasm = false)
	{
		if (stubs.empty()) return 0;
		auto& ctx = module.getContext();
		auto* i32_ty = llvm::Type::getInt32Ty(ctx);
		auto* i64_ty = llvm::Type::getInt64Ty(ctx);
		auto* ptr_ty = llvm::PointerType::getUnqual(ctx);
		auto* hle_fn_ty = llvm::FunctionType::get(i32_ty, {ptr_ty, i32_ty, i32_ty, i32_ty}, false);
		auto* vm_w64_ty = llvm::FunctionType::get(llvm::Type::getVoidTy(ctx), {i32_ty, i64_ty}, false);
		auto* vm_r32_ty = llvm::FunctionType::get(i32_ty, {i32_ty}, false);
		const auto nocap = llvm::Attribute::getWithCaptureInfo(ctx, llvm::CaptureInfo::none());
		llvm::FunctionCallee hle_callee;
		llvm::FunctionCallee vm_w64_callee;
		llvm::FunctionCallee vm_r32_callee;
		unsigned rewritten = 0;

		struct hle_inline_candidate_t
		{
			llvm::Function* caller = nullptr;
			llvm::BasicBlock* direct_bb = nullptr;
			llvm::CallInst* d_call = nullptr;
			llvm::Value* r1_val = nullptr;
			llvm::Value* r2_be = nullptr;
		};
		std::vector<hle_inline_candidate_t> inline_candidates;

		for (auto& function : module)
		{
			if (function.isDeclaration() || !function.getName().starts_with("__0x") || function.arg_size() != 7) continue;

			uint32_t func_pc = 0;
			parse_guest_fn_pc(function.getName(), func_pc);
			const auto* self_stub = lookup_sce_stub_in(stubs, func_pc);
			if (!self_stub && is_relocatable_wasm && !stubs.empty())
			{
				self_stub = lookup_sce_stub_in(stubs, func_pc + (stubs.front().stub_pc & 0xff000000u));
			}
			if (is_relocatable_wasm && !self_stub) continue;

			uint32_t const_lr = 0;
			bool writes_r0 = false;
			bool writes_r1 = false;
			bool writes_r2 = false;
			llvm::Value* r0_latest = function.getArg(4);
			llvm::Value* r1_latest = function.getArg(5);
			llvm::Value* r2_latest = function.getArg(6);
			llvm::BasicBlock* bailout_bb = nullptr;
			llvm::StoreInst* cia_store = nullptr;
			llvm::Type* context_ty = nullptr;
			llvm::Value* target_pc_val = nullptr;
			llvm::CallInst* indirect_musttail_call = nullptr;
			llvm::CallInst* direct_stub_call = nullptr;
			const sce_stub_entry* target_stub = nullptr;

			for (auto& bb : function)
			{
				for (auto& inst : bb)
				{
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst); call && call->isMustTailCall() && call->arg_size() == 7)
					{
						if (auto* callee = call->getCalledFunction())
						{
							uint32_t callee_pc = 0;
							if (!self_stub && parse_guest_fn_pc(callee->getName(), callee_pc))
							{
								if (const auto* st = lookup_sce_stub_in(stubs, callee_pc))
								{
									direct_stub_call = call;
									target_stub = st;
								}
							}
						}
						else
						{
							indirect_musttail_call = call;
						}
					}
					auto* store = llvm::dyn_cast<llvm::StoreInst>(&inst);
					if (!store) continue;
					auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(store->getPointerOperand());
					if (!gep || gep->getPointerOperand() != function.getArg(1) || gep->getNumIndices() != 2) continue;
					if (!context_ty) context_ty = gep->getSourceElementType();
					auto* idx0 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(1));
					auto* idx1 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(2));
					if (!idx0 || !idx1 || !idx0->isZero()) continue;
					const uint64_t field = idx1->getZExtValue();
					if (field == 3) writes_r0 = true;
					else if (field == 4) writes_r1 = true;
					else if (field == 5) writes_r2 = true;
					else if (field == 166 && store->getValueOperand()->getType()->isIntegerTy(32)
						&& llvm::isa<llvm::ReturnInst>(bb.getTerminator()))
					{
						bailout_bb = &bb;
						cia_store = store;
						context_ty = gep->getSourceElementType();
						target_pc_val = store->getValueOperand();
					}
				}
			}

			if (!self_stub && bailout_bb && target_pc_val && !target_stub)
			{
				uint32_t cia_const = 0;
				if (extract_const_u32(target_pc_val, cia_const))
				{
					target_stub = lookup_sce_stub_in(stubs, cia_const);
				}
			}

			// A self stub can be entered through the runtime dispatcher, where the
			// stub lookup may only become available from the CIA store. Treat that
			// case exactly like lookup_sce_stub_in(func_pc): the function-entry
			// r0/r1/r2 are the caller values, while the indirect call operands are
			// already post-descriptor-load values (including the HLE r2=0).
			const bool function_is_direct_hle_stub = self_stub
				|| (target_stub && target_stub->is_direct_hle && target_stub->stub_pc == func_pc);

			bool have_exact_regs = false;
			if (function_is_direct_hle_stub)
			{
				// A self stub can also dispatch to a compiled LLE PRX through the
				// indirect call path. Keep that path intact, but lower its separate
				// HLE fallback even when the surrounding page-test CFG does not have
				// the caller-rewrite predecessor shape matched below.
			}
			else if (indirect_musttail_call && bailout_bb)
			{
				auto* call_bb = indirect_musttail_call->getParent();
				auto* slot_bb = call_bb->getSinglePredecessor();
				auto* pred_bb = slot_bb ? slot_bb->getSinglePredecessor() : nullptr;
				auto* pred_br = pred_bb ? llvm::dyn_cast<llvm::BranchInst>(pred_bb->getTerminator()) : nullptr;
				if (pred_br && pred_br->isConditional()
					&& ((pred_br->getSuccessor(0) == bailout_bb && pred_br->getSuccessor(1) == slot_bb)
						|| (pred_br->getSuccessor(1) == bailout_bb && pred_br->getSuccessor(0) == slot_bb)))
				{
					const_lr = find_const_lr_for_call(function, indirect_musttail_call);
					r0_latest = indirect_musttail_call->getArgOperand(4);
					r1_latest = indirect_musttail_call->getArgOperand(5);
					r2_latest = indirect_musttail_call->getArgOperand(6);
					have_exact_regs = true;
					// Only collapse slot_bb -> call_bb for caller-side stub rewrites (which pass faddr | 0x80000000
					// to @__hle_call_fnid, handling both HLE and LLE). Inside self_stub (@__0x<stub_pc>), keep
					// slot_bb -> call_bb intact so indirect calls to compiled LLE PRXs musttail in pure Wasm while
					// HLE targets (slot == 0) fall through to bailout_bb -> @__hle_call_fnid.
					if (target_stub && target_stub->is_direct_hle)
					{
						llvm::BranchInst::Create(bailout_bb, pred_br->getIterator());
						pred_br->eraseFromParent();
						for (auto& phi : bailout_bb->phis())
						{
							if (const int incoming = phi.getBasicBlockIndex(slot_bb); incoming >= 0)
							{
								phi.removeIncomingValue(static_cast<unsigned>(incoming));
							}
						}
						call_bb->eraseFromParent();
						slot_bb->eraseFromParent();
					}
				}
				else
				{
					continue;
				}
			}
			else if (!self_stub && direct_stub_call && target_stub && target_stub->is_direct_hle && context_ty)
			{
				const_lr = find_const_lr_for_call(function, direct_stub_call);
				r0_latest = direct_stub_call->getArgOperand(4);
				r1_latest = direct_stub_call->getArgOperand(5);
				r2_latest = direct_stub_call->getArgOperand(6);
				have_exact_regs = true;
				bailout_bb = direct_stub_call->getParent();
				direct_stub_call->eraseFromParent();
			}

			if (!context_ty || !bailout_bb) continue;
			if (!(target_stub && target_stub->is_direct_hle) && !(self_stub && self_stub->is_direct_hle)) continue;
			if (!have_exact_regs && !function_is_direct_hle_stub && (writes_r0 || writes_r1 || writes_r2))
			{
				llvm::IRBuilder<> ir_regs(bailout_bb->getTerminator());
				if (writes_r0)
				{
					auto* g0 = ir_regs.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_regs.getInt32(0), ir_regs.getInt32(3)});
					r0_latest = ir_regs.CreateAlignedLoad(i64_ty, g0, llvm::Align(8));
				}
				if (writes_r1)
				{
					auto* g1 = ir_regs.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_regs.getInt32(0), ir_regs.getInt32(4)});
					r1_latest = ir_regs.CreateAlignedLoad(i64_ty, g1, llvm::Align(8));
				}
				if (writes_r2)
				{
					auto* g2 = ir_regs.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_regs.getInt32(0), ir_regs.getInt32(5)});
					r2_latest = ir_regs.CreateAlignedLoad(i64_ty, g2, llvm::Align(8));
				}
			}

			if (!hle_callee)
			{
				hle_callee = module.getOrInsertFunction("__hle_call_fnid", hle_fn_ty);
				if (auto* fn = llvm::dyn_cast<llvm::Function>(hle_callee.getCallee()))
				{
					fn->addParamAttr(0, nocap);
				}
			}

			const auto ensure_vm_helpers = [&]()
			{
				if (!vm_w64_callee)
				{
					vm_w64_callee = module.getOrInsertFunction("rpcs3_web_vm_write64_raw", vm_w64_ty);
				}
				if (!vm_r32_callee)
				{
					vm_r32_callee = module.getOrInsertFunction("rpcs3_web_vm_read32_raw", vm_r32_ty);
				}
			};

			auto* term = bailout_bb->getTerminator();
			llvm::IRBuilder<> ir(term);

			// Case A: Caller of an LLE .sprx stub (!target_stub->is_direct_hle).
			// Inline the OPD read and 1-hop dispatch into the caller so it never visits 0004YN.
			if (target_stub && !target_stub->is_direct_hle)
			{
				ensure_vm_helpers();
				if (cia_store)
				{
					cia_store->eraseFromParent();
					cia_store = nullptr;
				}
				auto* bswap32 = llvm::Intrinsic::getOrInsertDeclaration(&module, llvm::Intrinsic::bswap, {i32_ty});
				auto* bswap64 = llvm::Intrinsic::getOrInsertDeclaration(&module, llvm::Intrinsic::bswap, {i64_ty});

				auto* opd_be = ir.CreateCall(vm_r32_callee, {ir.getInt32(target_stub->faddr)}, "lle_opdbe");
				auto* opd_addr = ir.CreateCall(bswap32, {opd_be}, "lle_opd");
				auto* opd_addr64 = ir.CreateZExt(opd_addr, i64_ty);
				auto* gep_r12 = ir.CreateInBoundsGEP(context_ty, function.getArg(1), {ir.getInt32(0), ir.getInt32(15)});
				ir.CreateAlignedStore(opd_addr64, gep_r12, llvm::Align(8));

				auto* gep_r1 = ir.CreateInBoundsGEP(context_ty, function.getArg(1), {ir.getInt32(0), ir.getInt32(4)});
				ir.CreateAlignedStore(r1_latest, gep_r1, llvm::Align(8));

				auto* toc_off = ir.CreateAdd(r1_latest, ir.getInt64(40));
				auto* toc_addr = ir.CreateTrunc(toc_off, i32_ty);
				auto* r2_be = ir.CreateCall(bswap64, {r2_latest});
				ir.CreateCall(vm_w64_callee, {toc_addr, r2_be});

				auto* tpc_be = ir.CreateCall(vm_r32_callee, {opd_addr}, "lle_tpcbe");
				auto* tpc = ir.CreateCall(bswap32, {tpc_be}, "lle_tpc");
				auto* tpc64 = ir.CreateZExt(tpc, i64_ty);
				auto* gep_r0 = ir.CreateInBoundsGEP(context_ty, function.getArg(1), {ir.getInt32(0), ir.getInt32(3)});
				ir.CreateAlignedStore(tpc64, gep_r0, llvm::Align(8));

				auto* r2_ptr = ir.CreateAdd(opd_addr, ir.getInt32(4));
				auto* nr2_be = ir.CreateCall(vm_r32_callee, {r2_ptr}, "lle_nr2be");
				auto* nr2 = ir.CreateCall(bswap32, {nr2_be}, "lle_nr2");
				auto* nr2_64 = ir.CreateZExt(nr2, i64_ty);
				auto* gep_r2 = ir.CreateInBoundsGEP(context_ty, function.getArg(1), {ir.getInt32(0), ir.getInt32(5)});
				ir.CreateAlignedStore(nr2_64, gep_r2, llvm::Align(8));

				auto* gep_ctr = ir.CreateInBoundsGEP(context_ty, function.getArg(1), {ir.getInt32(0), ir.getInt32(164)});
				ir.CreateAlignedStore(tpc64, gep_ctr, llvm::Align(8));

				auto* lle_l2 = llvm::BasicBlock::Create(ctx, "lle_l2", &function);
				auto* lle_c = llvm::BasicBlock::Create(ctx, "lle_c", &function);
				auto* lle_miss = llvm::BasicBlock::Create(ctx, "lle_m", &function);

				auto* hi = ir.CreateLShr(tpc, ir.getInt32(16));
				auto* p_gep = ir.CreateGEP(i32_ty, function.getArg(0), hi);
				auto* page = ir.CreateAlignedLoad(i32_ty, p_gep, llvm::Align(4));
				ir.CreateCondBr(ir.CreateICmpNE(page, ir.getInt32(0)), lle_l2, lle_miss);
				term->eraseFromParent();

				llvm::IRBuilder<> irl2(lle_l2);
				auto* lo = irl2.CreateAnd(tpc, irl2.getInt32(65535));
				auto* slot = irl2.CreateLShr(lo, irl2.getInt32(2));
				auto* page_ptr = irl2.CreateIntToPtr(page, ptr_ty);
				auto* bundled_gep = irl2.CreateGEP(i32_ty, page_ptr, slot);
				auto* bundled_idx = irl2.CreateAlignedLoad(i32_ty, bundled_gep, llvm::Align(4));
				auto* tier_base = irl2.CreateGEP(irl2.getInt8Ty(), page_ptr, irl2.getInt32(0x10000));
				auto* tier_gep = irl2.CreateGEP(i32_ty, tier_base, slot);
				auto* tier_idx = irl2.CreateAlignedLoad(i32_ty, tier_gep, llvm::Align(4));
				auto* fn_idx = irl2.CreateSelect(irl2.CreateICmpEQ(bundled_idx, irl2.getInt32(0)), tier_idx, bundled_idx);
				auto* callable = irl2.CreateICmpULT(irl2.CreateSub(fn_idx, irl2.getInt32(1)), irl2.getInt32(0x7fffffff));
				irl2.CreateCondBr(callable, lle_c, lle_miss);

				llvm::IRBuilder<> irlc(lle_c);
				auto* gep_cia_hit = irlc.CreateInBoundsGEP(context_ty, function.getArg(1), {irlc.getInt32(0), irlc.getInt32(166)});
				irlc.CreateAlignedStore(tpc, gep_cia_hit, llvm::Align(4));
				auto* lle_seg0_base = irlc.CreateGEP(irlc.getInt8Ty(), function.getArg(0), irlc.getInt32(0x40000));
				auto* lle_seg0_gep = irlc.CreateGEP(i32_ty, lle_seg0_base, hi);
				auto* lle_next_seg0 = irlc.CreateZExt(irlc.CreateAlignedLoad(i32_ty, lle_seg0_gep, llvm::Align(4)), i64_ty);
				auto* fn_ptr = irlc.CreateIntToPtr(fn_idx, ptr_ty);
				auto* call = irlc.CreateCall(function.getFunctionType(), fn_ptr, {
					function.getArg(0), function.getArg(1), lle_next_seg0, function.getArg(3),
					tpc64, r1_latest, nr2_64
				});
				call->setTailCallKind(llvm::CallInst::TCK_MustTail);
				call->addParamAttr(0, nocap);
				call->addParamAttr(1, nocap);
				irlc.CreateRetVoid();

				llvm::IRBuilder<> irlm(lle_miss);
				auto* gep_cia = irlm.CreateInBoundsGEP(context_ty, function.getArg(1), {irlm.getInt32(0), irlm.getInt32(166)});
				irlm.CreateAlignedStore(tpc, gep_cia, llvm::Align(4));
				irlm.CreateRetVoid();

				bailout_bb = lle_miss;
				term = bailout_bb->getTerminator();
				target_pc_val = tpc;
			}

			llvm::IRBuilder<> ir_hle(term);
			// Register values tracked while scanning the function may come from a sibling
			// branch that does not dominate this bailout block. The translator flushes the
			// current GPRs to the context before a guest tail call, so reload them at the HLE
			// insertion point. This keeps the rewrite SSA-correct across joins and branches.
			const auto load_context_gpr = [&](uint32_t field, const llvm::Twine& name) -> llvm::Value*
			{
				if (!context_ty) return nullptr;
				auto* gep = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(field)});
				return ir_hle.CreateAlignedLoad(i64_ty, gep, llvm::Align(8), name);
			};
			// A self stub has already executed its descriptor loads by the time the
			// HLE fallback is inserted. Those loads overwrite r0/r2 with the target
			// OPD values, so use the registers captured on entry to the stub. Caller
			// rewrites likewise carry exact pre-call registers in r0_latest/r1_latest/
			// r2_latest. Reloading the context in either case destroys the caller's
			// TOC and stack pointer before the HLE hook runs.
			llvm::Value* r0_current = nullptr;
			llvm::Value* r1_current = nullptr;
			llvm::Value* r2_current = nullptr;
			if (have_exact_regs || function_is_direct_hle_stub)
			{
				r0_current = r0_latest;
				r1_current = r1_latest;
				r2_current = r2_latest;
			}
			else
			{
				r0_current = load_context_gpr(3, "hle_in_r0");
				r1_current = load_context_gpr(4, "hle_in_r1");
				r2_current = load_context_gpr(5, "hle_in_r2");
			}
			llvm::Value* r2_be_saved = nullptr;
			llvm::Value* hle_target_arg = target_pc_val;
			uint32_t hle_fnid_arg = 0;

			const sce_stub_entry* direct_stub = target_stub ? target_stub : self_stub;
			if (direct_stub && direct_stub->is_direct_hle)
			{
				ensure_vm_helpers();
				if (!cia_store)
				{
					auto* gep_cia = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(166)});
					ir_hle.CreateAlignedStore(ir_hle.getInt32(direct_stub->stub_pc), gep_cia, llvm::Align(4));
				}
				auto* bswap64 = llvm::Intrinsic::getOrInsertDeclaration(&module, llvm::Intrinsic::bswap, {i64_ty});
				auto* toc_off = ir_hle.CreateAdd(r1_current, ir_hle.getInt64(40));
				auto* toc_addr = ir_hle.CreateTrunc(toc_off, i32_ty);
				r2_be_saved = ir_hle.CreateCall(bswap64, {r2_current}, "hle_r2be");
				ir_hle.CreateCall(vm_w64_callee, {toc_addr, r2_be_saved});

				auto* gep0_pre = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(3)});
				ir_hle.CreateAlignedStore(r0_current, gep0_pre, llvm::Align(8));
				auto* gep2_pre = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(5)});
				ir_hle.CreateAlignedStore(r2_current, gep2_pre, llvm::Align(8));
				hle_target_arg = ir_hle.getInt32(direct_stub->faddr | 0x80000000u);
				hle_fnid_arg = direct_stub->fnid;
			}
			else
			{
				auto* gep0_pre = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(3)});
				ir_hle.CreateAlignedStore(r0_current, gep0_pre, llvm::Align(8));
				auto* gep2_pre = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(5)});
				ir_hle.CreateAlignedStore(r2_current, gep2_pre, llvm::Align(8));
			}

			auto* gep1_pre = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(4)});
			ir_hle.CreateAlignedStore(r1_current, gep1_pre, llvm::Align(8));
			auto* ret_pc = ir_hle.CreateCall(hle_callee, {
				function.getArg(1), hle_target_arg, ir_hle.getInt32(hle_fnid_arg), ir_hle.getInt32(const_lr)
			}, "hle_ret_pc");

			// The HLE hook may yield through JSPI and use the guest stack or TOC
			// registers internally. Restore the caller-visible ABI registers in
			// the generated continuation before dispatching back to guest code.
			// The C++ boundary also restores these values, but making the lowering
			// explicit keeps cached Wasm artifacts correct across suspension.
			auto* gep1_post = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(4)});
			ir_hle.CreateAlignedStore(r1_current, gep1_post, llvm::Align(8));
			auto* gep2_post = ir_hle.CreateInBoundsGEP(context_ty, function.getArg(1), {ir_hle.getInt32(0), ir_hle.getInt32(5)});
			ir_hle.CreateAlignedStore(r2_current, gep2_post, llvm::Align(8));

			auto* lookup1_bb = llvm::BasicBlock::Create(ctx, "hle_l1", &function);
			auto* lookup2_bb = llvm::BasicBlock::Create(ctx, "hle_l2", &function);
			auto* cont_bb = llvm::BasicBlock::Create(ctx, "hle_c", &function);
			auto* unwind_bb = llvm::BasicBlock::Create(ctx, "hle_x", &function);

			llvm::Function* direct_lr_fn = (!is_relocatable_wasm && const_lr)
				? module.getFunction(llvm::formatv("__0x{0:x}", const_lr).str())
				: nullptr;
			if (direct_lr_fn && !direct_lr_fn->isDeclaration())
			{
				auto* direct_bb = llvm::BasicBlock::Create(ctx, "hle_d", &function);
				auto* chk_bb = llvm::BasicBlock::Create(ctx, "hle_chk", &function);
				ir_hle.CreateCondBr(ir_hle.CreateICmpEQ(ret_pc, ir_hle.getInt32(const_lr), "hle_dok"), direct_bb, chk_bb);
				llvm::IRBuilder<> ir_chk(chk_bb);
				ir_chk.CreateCondBr(ir_chk.CreateICmpNE(ret_pc, ir_chk.getInt32(0), "hle_ok"), lookup1_bb, unwind_bb);

				llvm::IRBuilder<> ird(direct_bb);
				auto* d_gep_cia = ird.CreateInBoundsGEP(context_ty, function.getArg(1), {ird.getInt32(0), ird.getInt32(166)});
				ird.CreateAlignedStore(ird.getInt32(const_lr), d_gep_cia, llvm::Align(4));
				auto* d_gep0 = ird.CreateInBoundsGEP(context_ty, function.getArg(1), {ird.getInt32(0), ird.getInt32(3)});
				auto* d_r0 = ird.CreateAlignedLoad(i64_ty, d_gep0, llvm::Align(8), "hle_dr0");
				auto* d_gep1 = ird.CreateInBoundsGEP(context_ty, function.getArg(1), {ird.getInt32(0), ird.getInt32(4)});
				auto* d_r1 = ird.CreateAlignedLoad(i64_ty, d_gep1, llvm::Align(8), "hle_dr1");
				auto* d_gep2 = ird.CreateInBoundsGEP(context_ty, function.getArg(1), {ird.getInt32(0), ird.getInt32(5)});
				auto* d_r2 = ird.CreateAlignedLoad(i64_ty, d_gep2, llvm::Align(8), "hle_dr2");
				auto* d_call = ird.CreateCall(direct_lr_fn, {
					function.getArg(0), function.getArg(1), function.getArg(2), function.getArg(3),
					d_r0, d_r1, d_r2
				});
				d_call->setTailCallKind(llvm::CallInst::TCK_MustTail);
				d_call->addParamAttr(0, nocap);
				d_call->addParamAttr(1, nocap);
				ird.CreateRetVoid();
			}
			else
			{
				ir_hle.CreateCondBr(ir_hle.CreateICmpNE(ret_pc, ir_hle.getInt32(0), "hle_ok"), lookup1_bb, unwind_bb);
			}
			term->eraseFromParent();

			llvm::IRBuilder<> ir1(lookup1_bb);
			auto* hi = ir1.CreateLShr(ret_pc, ir1.getInt32(16));
			auto* p_gep = ir1.CreateGEP(i32_ty, function.getArg(0), hi);
			auto* page = ir1.CreateAlignedLoad(i32_ty, p_gep, llvm::Align(4));
			ir1.CreateCondBr(ir1.CreateICmpNE(page, ir1.getInt32(0)), lookup2_bb, unwind_bb);

			llvm::IRBuilder<> ir2(lookup2_bb);
			auto* lo = ir2.CreateAnd(ret_pc, ir2.getInt32(65535));
			auto* slot = ir2.CreateLShr(lo, ir2.getInt32(2));
			auto* page_ptr = ir2.CreateIntToPtr(page, ptr_ty);
			auto* bundled_gep = ir2.CreateGEP(i32_ty, page_ptr, slot);
			auto* bundled_idx = ir2.CreateAlignedLoad(i32_ty, bundled_gep, llvm::Align(4));
			auto* tier_base = ir2.CreateGEP(ir2.getInt8Ty(), page_ptr, ir2.getInt32(0x10000));
			auto* tier_gep = ir2.CreateGEP(i32_ty, tier_base, slot);
			auto* tier_idx = ir2.CreateAlignedLoad(i32_ty, tier_gep, llvm::Align(4));
			auto* fn_idx = ir2.CreateSelect(ir2.CreateICmpEQ(bundled_idx, ir2.getInt32(0)), tier_idx, bundled_idx);
			auto* callable = ir2.CreateICmpULT(ir2.CreateSub(fn_idx, ir2.getInt32(1)), ir2.getInt32(0x7fffffff));
			ir2.CreateCondBr(callable, cont_bb, unwind_bb);

			llvm::IRBuilder<> irc(cont_bb);
			auto* gep_cia_cont = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(166)});
			irc.CreateAlignedStore(ret_pc, gep_cia_cont, llvm::Align(4));
			auto* gep0 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(3)});
			auto* r0_after = irc.CreateAlignedLoad(i64_ty, gep0, llvm::Align(8), "hle_r0");
			auto* gep1 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(4)});
			auto* r1_after = irc.CreateAlignedLoad(i64_ty, gep1, llvm::Align(8), "hle_r1");
			auto* gep2 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(5)});
			auto* r2_after = irc.CreateAlignedLoad(i64_ty, gep2, llvm::Align(8), "hle_r2");
			auto* cont_seg0_base = irc.CreateGEP(irc.getInt8Ty(), function.getArg(0), irc.getInt32(0x40000));
			auto* cont_seg0_gep = irc.CreateGEP(i32_ty, cont_seg0_base, hi);
			auto* cont_next_seg0 = irc.CreateZExt(irc.CreateAlignedLoad(i32_ty, cont_seg0_gep, llvm::Align(4)), i64_ty);
			auto* fn_ptr = irc.CreateIntToPtr(fn_idx, ptr_ty);
			auto* call = irc.CreateCall(function.getFunctionType(), fn_ptr, {
				function.getArg(0), function.getArg(1), cont_next_seg0, function.getArg(3),
				r0_after, r1_after, r2_after
			});
			call->setTailCallKind(llvm::CallInst::TCK_MustTail);
			call->addParamAttr(0, nocap);
			call->addParamAttr(1, nocap);
			irc.CreateRetVoid();

			llvm::IRBuilder<> iru(unwind_bb);
			iru.CreateRetVoid();

			++rewritten;
		}

		// Pass 2: Inline same-shard return continuations (@__0x<const_lr>) into HLE callers
		// and fold away the redundant ppu.state volatile check and 40(r1) TOC reload.
		for (const auto& cand : inline_candidates)
		{
			auto* callee = cand.d_call->getCalledFunction();
			if (!callee || callee->isDeclaration() || callee == cand.caller) continue;
			if (callee->getInstructionCount() > 160 || cand.caller->getInstructionCount() + callee->getInstructionCount() > 600) continue;

			const bool had_noalias0 = callee->getArg(0)->hasAttribute(llvm::Attribute::NoAlias);
			const bool had_noalias1 = callee->getArg(1)->hasAttribute(llvm::Attribute::NoAlias);
			if (had_noalias0) callee->removeParamAttr(0, llvm::Attribute::NoAlias);
			if (had_noalias1) callee->removeParamAttr(1, llvm::Attribute::NoAlias);

			llvm::InlineFunctionInfo ifi;
			const bool inlined_ok = llvm::InlineFunction(*cand.d_call, ifi).isSuccess();

			if (had_noalias0) callee->addParamAttr(0, llvm::Attribute::NoAlias);
			if (had_noalias1) callee->addParamAttr(1, llvm::Attribute::NoAlias);
			if (!inlined_ok) continue;

			// Fold the entry ppu.state volatile check strictly inside cand.direct_bb before any call.
			for (auto it = cand.direct_bb->begin(); it != cand.direct_bb->end();)
			{
				llvm::Instruction& inst = *it++;
				if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
				{
					const auto* fn = call->getCalledFunction();
					if (!fn || !fn->isIntrinsic()) break;
					continue;
				}
				if (auto* ld = llvm::dyn_cast<llvm::LoadInst>(&inst);
					ld && ld->isVolatile() && ld->getType()->isIntegerTy(32))
				{
					if (auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(ld->getPointerOperand());
						gep && gep->getPointerOperand() == cand.caller->getArg(1) && gep->getNumIndices() == 2)
					{
						const auto* i0 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(1));
						const auto* i1 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(2));
						if (i0 && i1 && i0->isZero() && i1->getZExtValue() == 1)
						{
							ld->replaceAllUsesWith(llvm::ConstantInt::get(i32_ty, 0));
							ld->eraseFromParent();
							break;
						}
					}
				}
			}

			// Fold 40(r1) TOC reload strictly in cand.direct_bb and its immediate dominating body block.
			llvm::SmallVector<llvm::BasicBlock*, 2> toc_bbs{cand.direct_bb};
			if (auto* br = llvm::dyn_cast<llvm::BranchInst>(cand.direct_bb->getTerminator()))
			{
				if (br->isUnconditional() && br->getSuccessor(0)->getSinglePredecessor() == cand.direct_bb)
				{
					toc_bbs.push_back(br->getSuccessor(0));
				}
				else if (br->isConditional())
				{
					if (const auto* ci = llvm::dyn_cast<llvm::ConstantInt>(br->getCondition()))
					{
						auto* taken = br->getSuccessor(ci->isOne() ? 0 : 1);
						if (taken->getSinglePredecessor() == cand.direct_bb) toc_bbs.push_back(taken);
					}
				}
			}

			bool folded_toc = false;
			bool stop_toc_fold = false;
			for (auto* bb : toc_bbs)
			{
				if (folded_toc || stop_toc_fold) break;
				for (auto it = bb->begin(); it != bb->end();)
				{
					llvm::Instruction& inst = *it++;
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
					{
						if (const auto* fn = call->getCalledFunction())
						{
							const auto name = fn->getName();
							if (name == "rpcs3_web_vm_read64_raw" && call->arg_size() == 1)
							{
								if (const auto* tr = llvm::dyn_cast<llvm::TruncInst>(call->getArgOperand(0)))
								{
									if (const auto* add = llvm::dyn_cast<llvm::BinaryOperator>(tr->getOperand(0));
										add && add->getOpcode() == llvm::Instruction::Add && add->getOperand(0) == cand.r1_val)
									{
										if (const auto* c40 = llvm::dyn_cast<llvm::ConstantInt>(add->getOperand(1));
											c40 && c40->getZExtValue() == 40)
										{
											call->replaceAllUsesWith(cand.r2_be);
											call->eraseFromParent();
											folded_toc = true;
											break;
										}
									}
								}
							}
							if (!fn->isIntrinsic() && !name.starts_with("rpcs3_web_vm_read"))
							{
								stop_toc_fold = true;
								break;
							}
						}
						else
						{
							stop_toc_fold = true;
							break;
						}
					}
				}
			}
		}

		if (rewritten > 0)
		{
			mark_nocapture_helpers(module);
		}
		return rewritten;
	}

	// Rewrite @__syscall(ptr %1, i64 %num) followed by ret void into a direct continuation
	// to @__0x<sc_pc + 4> when (ppu.state == 0 && ppu.cia == sc_pc + 4) after the syscall.
	inline unsigned lower_syscall_continuations(llvm::Module& module)
	{
		auto& ctx = module.getContext();
		auto* i32_ty = llvm::Type::getInt32Ty(ctx);
		auto* ptr_ty = llvm::PointerType::getUnqual(ctx);
		const auto nocap = llvm::Attribute::getWithCaptureInfo(ctx, llvm::CaptureInfo::none());
		unsigned rewritten = 0;

		for (auto& function : module)
		{
			if (function.isDeclaration() || !function.getName().starts_with("__0x") || function.arg_size() != 7) continue;

			llvm::BasicBlock* sc_bb = nullptr;
			llvm::CallInst* sc_call = nullptr;
			llvm::Type* context_ty = nullptr;
			llvm::Value* cia_gep_val = nullptr;
			uint32_t sc_pc = 0;
			bool has_sc_pc = false;
			bool is_reloc_sc = false;

			const auto match_reloc_sc_pc = [&](const llvm::Value* val, uint32_t& out_rel_pc) -> bool
			{
				const auto* tr = llvm::dyn_cast<llvm::TruncInst>(val);
				if (!tr) return false;
				const auto* add = llvm::dyn_cast<llvm::BinaryOperator>(tr->getOperand(0));
				if (!add || add->getOpcode() != llvm::Instruction::Add) return false;
				if (add->getOperand(0) == function.getArg(2))
				{
					if (const auto* ci = llvm::dyn_cast<llvm::ConstantInt>(add->getOperand(1)))
					{
						out_rel_pc = static_cast<uint32_t>(ci->getZExtValue());
						return true;
					}
				}
				if (add->getOperand(1) == function.getArg(2))
				{
					if (const auto* ci = llvm::dyn_cast<llvm::ConstantInt>(add->getOperand(0)))
					{
						out_rel_pc = static_cast<uint32_t>(ci->getZExtValue());
						return true;
					}
				}
				return false;
			};

			for (auto& bb : function)
			{
				if (!llvm::isa<llvm::ReturnInst>(bb.getTerminator())) continue;
				for (auto& inst : bb)
				{
					if (auto* store = llvm::dyn_cast<llvm::StoreInst>(&inst);
						store && store->getValueOperand()->getType()->isIntegerTy(32))
					{
						if (auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(store->getPointerOperand());
							gep && gep->getPointerOperand() == function.getArg(1) && gep->getNumIndices() == 2)
						{
							auto* idx0 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(1));
							auto* idx1 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(2));
							if (idx0 && idx1 && idx0->isZero() && idx1->getZExtValue() == 166)
							{
								if (extract_const_u32(store->getValueOperand(), sc_pc))
								{
									context_ty = gep->getSourceElementType();
									cia_gep_val = gep;
									has_sc_pc = true;
									is_reloc_sc = false;
								}
								else if (match_reloc_sc_pc(store->getValueOperand(), sc_pc))
								{
									context_ty = gep->getSourceElementType();
									cia_gep_val = gep;
									has_sc_pc = true;
									is_reloc_sc = true;
								}
							}
						}
					}
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
					{
						if (const auto* callee = call->getCalledFunction();
							callee && callee->getName() == "__syscall" && call->getNextNode() == bb.getTerminator())
						{
							sc_bb = &bb;
							sc_call = call;
							break;
						}
					}
				}
				if (sc_bb) break;
			}
			if (!sc_bb || !sc_call || !context_ty || !cia_gep_val || !has_sc_pc) continue;

			const uint32_t next_pc = sc_pc + 4;
			auto* term = sc_bb->getTerminator();
			llvm::IRBuilder<> ir(term);
			auto* state_gep = ir.CreateInBoundsGEP(context_ty, function.getArg(1), {ir.getInt32(0), ir.getInt32(1)});
			auto* state_val = ir.CreateAlignedLoad(i32_ty, state_gep, llvm::Align(4), true, "sc_st");
			auto* cia_val = ir.CreateAlignedLoad(i32_ty, cia_gep_val, llvm::Align(4), "sc_cia");
			llvm::Value* expected_next_cia = is_reloc_sc
				? ir.CreateAdd(ir.CreateTrunc(function.getArg(2), i32_ty), ir.getInt32(next_pc))
				: static_cast<llvm::Value*>(ir.getInt32(next_pc));
			auto* ok = ir.CreateAnd(ir.CreateICmpEQ(state_val, ir.getInt32(0)), ir.CreateICmpEQ(cia_val, expected_next_cia), "sc_ok");

			auto* cont_bb = llvm::BasicBlock::Create(ctx, "sc_c", &function);
			auto* unwind_bb = llvm::BasicBlock::Create(ctx, "sc_x", &function);

			llvm::Function* next_fn = module.getFunction(llvm::formatv("__0x{0:x}", next_pc).str());
			if (next_fn && !next_fn->isDeclaration())
			{
				ir.CreateCondBr(ok, cont_bb, unwind_bb);
				term->eraseFromParent();

				llvm::IRBuilder<> irc(cont_bb);
				auto* gep0 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(3)});
				auto* r0_after = irc.CreateAlignedLoad(irc.getInt64Ty(), gep0, llvm::Align(8), "sc_r0");
				auto* gep1 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(4)});
				auto* r1_after = irc.CreateAlignedLoad(irc.getInt64Ty(), gep1, llvm::Align(8), "sc_r1");
				auto* gep2 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(5)});
				auto* r2_after = irc.CreateAlignedLoad(irc.getInt64Ty(), gep2, llvm::Align(8), "sc_r2");
				auto* call = irc.CreateCall(next_fn, {
					function.getArg(0), function.getArg(1), function.getArg(2), function.getArg(3),
					r0_after, r1_after, r2_after
				});
				call->setTailCallKind(llvm::CallInst::TCK_MustTail);
				call->addParamAttr(0, nocap);
				call->addParamAttr(1, nocap);
				irc.CreateRetVoid();
			}
			else
			{
				auto* lookup1_bb = llvm::BasicBlock::Create(ctx, "sc_l1", &function);
				auto* lookup2_bb = llvm::BasicBlock::Create(ctx, "sc_l2", &function);
				ir.CreateCondBr(ok, lookup1_bb, unwind_bb);
				term->eraseFromParent();

				llvm::IRBuilder<> ir1(lookup1_bb);
				auto* sc_hi = ir1.CreateLShr(expected_next_cia, ir1.getInt32(16));
				auto* p_gep = ir1.CreateGEP(ir1.getInt32Ty(), function.getArg(0), sc_hi);
				auto* page = ir1.CreateAlignedLoad(ir1.getInt32Ty(), p_gep, llvm::Align(4));
				ir1.CreateCondBr(ir1.CreateICmpNE(page, ir1.getInt32(0)), lookup2_bb, unwind_bb);

				llvm::IRBuilder<> ir2(lookup2_bb);
				auto* page_ptr = ir2.CreateIntToPtr(page, ptr_ty);
				auto* slot = ir2.CreateLShr(ir2.CreateAnd(expected_next_cia, ir2.getInt32(0xffffu)), ir2.getInt32(2));
				auto* bundled_gep = ir2.CreateGEP(ir2.getInt32Ty(), page_ptr, slot);
				auto* bundled_idx = ir2.CreateAlignedLoad(ir2.getInt32Ty(), bundled_gep, llvm::Align(4));
				auto* tier_base = ir2.CreateGEP(ir2.getInt8Ty(), page_ptr, ir2.getInt32(0x10000));
				auto* tier_gep = ir2.CreateGEP(ir2.getInt32Ty(), tier_base, slot);
				auto* tier_idx = ir2.CreateAlignedLoad(ir2.getInt32Ty(), tier_gep, llvm::Align(4));
				auto* fn_idx = ir2.CreateSelect(ir2.CreateICmpEQ(bundled_idx, ir2.getInt32(0)), tier_idx, bundled_idx);
				auto* callable = ir2.CreateICmpULT(ir2.CreateSub(fn_idx, ir2.getInt32(1)), ir2.getInt32(0x7fffffff));
				ir2.CreateCondBr(callable, cont_bb, unwind_bb);

				llvm::IRBuilder<> irc(cont_bb);
				auto* gep0 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(3)});
				auto* r0_after = irc.CreateAlignedLoad(irc.getInt64Ty(), gep0, llvm::Align(8), "sc_r0");
				auto* gep1 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(4)});
				auto* r1_after = irc.CreateAlignedLoad(irc.getInt64Ty(), gep1, llvm::Align(8), "sc_r1");
				auto* gep2 = irc.CreateInBoundsGEP(context_ty, function.getArg(1), {irc.getInt32(0), irc.getInt32(5)});
				auto* r2_after = irc.CreateAlignedLoad(irc.getInt64Ty(), gep2, llvm::Align(8), "sc_r2");
				auto* fn_ptr = irc.CreateIntToPtr(fn_idx, ptr_ty);
				auto* call = irc.CreateCall(function.getFunctionType(), fn_ptr, {
					function.getArg(0), function.getArg(1), function.getArg(2), function.getArg(3),
					r0_after, r1_after, r2_after
				});
				call->setTailCallKind(llvm::CallInst::TCK_MustTail);
				call->addParamAttr(0, nocap);
				call->addParamAttr(1, nocap);
				irc.CreateRetVoid();
			}

			llvm::IRBuilder<> iru(unwind_bb);
			iru.CreateRetVoid();
			++rewritten;
		}
		return rewritten;
	}

	inline int get_known_align16_mod(const llvm::Value* v, const llvm::Function* func, unsigned depth = 0)
	{
		if (!func || func->arg_size() < 6 || !v || depth >= 8) return -1;
		const llvm::Value* r1 = func->getArg(5);
		if (v == r1) return 0;
		if (const auto* trunc = llvm::dyn_cast<llvm::TruncInst>(v))
		{
			return get_known_align16_mod(trunc->getOperand(0), func, depth + 1);
		}
		if (const auto* phi = llvm::dyn_cast<llvm::PHINode>(v))
		{
			if (phi->getNumIncomingValues() == 0) return -1;
			bool saw_non_self = false;
			for (unsigned i = 0; i < phi->getNumIncomingValues(); ++i)
			{
				const auto* inc = phi->getIncomingValue(i);
				if (inc == phi) continue;
				if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(inc);
					bin && bin->getOpcode() == llvm::Instruction::Add && bin->getOperand(0) == phi)
				{
					const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1));
					if (!c || (c->getZExtValue() & 15ULL) != 0) return -1;
					continue;
				}
				saw_non_self = true;
				if (get_known_align16_mod(inc, func, depth + 1) != 0) return -1;
			}
			return saw_non_self ? 0 : -1;
		}
		if (const auto* load = llvm::dyn_cast<llvm::LoadInst>(v))
		{
			if (const auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(load->getPointerOperand());
				gep && gep->getPointerOperand() == func->getArg(1) && gep->getNumIndices() == 2)
			{
				const auto* i0 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(1));
				const auto* i1 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(2));
				if (i0 && i1 && i0->isZero() && i1->getZExtValue() == 4) return 0;
			}
			return -1;
		}
		if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(v))
		{
			const auto op = bin->getOpcode();
			if (op == llvm::Instruction::And)
			{
				if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1)))
				{
					const uint64_t mask = c->getZExtValue();
					if ((mask & 15ULL) == 0) return 0;
					if (mask == 0xffffffffULL) return get_known_align16_mod(bin->getOperand(0), func, depth + 1);
				}
			}
			else if (op == llvm::Instruction::Add)
			{
				if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1)))
				{
					const int base_mod = get_known_align16_mod(bin->getOperand(0), func, depth + 1);
					if (base_mod >= 0)
					{
						return (base_mod + static_cast<int>(c->getZExtValue() & 15ULL)) & 15;
					}
				}
			}
			else if (op == llvm::Instruction::Or)
			{
				if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1)))
				{
					const int base_mod = get_known_align16_mod(bin->getOperand(0), func, depth + 1);
					const int c_mod = static_cast<int>(c->getZExtValue() & 15ULL);
					if (base_mod >= 0 && (base_mod & c_mod) == 0)
					{
						return (base_mod | c_mod) & 15;
					}
				}
			}
		}
		return -1;
	}

	inline bool is_ppu_stack_const_offset(const llvm::Value*, const llvm::Function*, unsigned = 0)
	{
		return false;
	}

	using stack_quad_cache_t = llvm::DenseMap<
		std::pair<const llvm::BasicBlock*, std::pair<const llvm::Value*, uint64_t>>,
		llvm::Value*>;

	inline llvm::Value* emit_branchless_stack_host_ptr(
		llvm::CallInst* call, llvm::Value* guest_addr, int mod16,
		llvm::Type* pages_ty, llvm::Value* pages, stack_quad_cache_t& quad_cache)
	{
		auto* call_bb = call->getParent();
		auto* func = call_bb->getParent();
		llvm::IRBuilder<> ir_call(call);
		auto& ctx = ir_call.getContext();
		auto* i32_ty = ir_call.getInt32Ty();

		const llvm::Value* base_key = guest_addr;
		uint64_t quad_off_key = 0;
		bool has_add_decomp = false;
		bool is_i64_base = false;

		if (const auto* trunc = llvm::dyn_cast<llvm::TruncInst>(guest_addr))
		{
			if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(trunc->getOperand(0));
				bin && bin->getOpcode() == llvm::Instruction::Add)
			{
				if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1));
					c && static_cast<int>(c->getZExtValue() & 15ULL) == mod16)
				{
					base_key = bin->getOperand(0);
					quad_off_key = c->getZExtValue() - static_cast<uint64_t>(mod16);
					has_add_decomp = true;
					is_i64_base = true;
				}
			}
			else if (mod16 == 0 && get_known_align16_mod(trunc->getOperand(0), func) == 0)
			{
				base_key = trunc->getOperand(0);
				quad_off_key = 0;
				has_add_decomp = true;
				is_i64_base = true;
			}
		}
		else if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(guest_addr);
			bin && bin->getOpcode() == llvm::Instruction::Add)
		{
			if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1));
				c && static_cast<int>(c->getZExtValue() & 15ULL) == mod16)
			{
				base_key = bin->getOperand(0);
				quad_off_key = (c->getZExtValue() - static_cast<uint64_t>(mod16)) & 0xffffffffULL;
				has_add_decomp = true;
			}
		}

		const llvm::BasicBlock* cache_bb = has_add_decomp ? nullptr : call_bb;
		if (auto it = quad_cache.find({cache_bb, {base_key, quad_off_key}}); it != quad_cache.end())
		{
			auto* quad_host = it->second;
			auto* host_addr = mod16 == 0 ? quad_host : ir_call.CreateAdd(quad_host, ir_call.getInt32(mod16), "vmsal");
			return ir_call.CreateIntToPtr(host_addr, llvm::PointerType::getUnqual(ctx), "vmspt");
		}

		llvm::Instruction* insert_pt = call;
		if (has_add_decomp)
		{
			if (auto* phi = llvm::dyn_cast<llvm::PHINode>(const_cast<llvm::Value*>(base_key)))
			{
				insert_pt = &*phi->getParent()->getFirstNonPHIIt();
			}
			else if (auto* inst = llvm::dyn_cast<llvm::Instruction>(const_cast<llvm::Value*>(base_key)))
			{
				if (inst->getNextNode()) insert_pt = inst->getNextNode();
			}
			else
			{
				insert_pt = &*func->getEntryBlock().getFirstNonPHIIt();
			}
		}
		else if (auto* gi = llvm::dyn_cast<llvm::Instruction>(guest_addr);
			gi && gi->getParent() != call_bb && !llvm::isa<llvm::PHINode>(gi) && gi->getNextNode())
		{
			insert_pt = gi->getNextNode();
		}

		llvm::IRBuilder<> ir(insert_pt);
		llvm::Value* quad_addr = guest_addr;
		if (has_add_decomp)
		{
			auto* base_val = const_cast<llvm::Value*>(base_key);
			if (is_i64_base)
			{
				auto* quad64 = quad_off_key == 0
					? base_val
					: ir.CreateAdd(base_val, llvm::ConstantInt::get(base_val->getType(), quad_off_key));
				quad_addr = ir.CreateTrunc(quad64, i32_ty);
			}
			else
			{
				quad_addr = quad_off_key == 0
					? base_val
					: ir.CreateAdd(base_val, ir.getInt32(static_cast<uint32_t>(quad_off_key)));
			}
		}
		else if (mod16 > 0)
		{
			quad_addr = ir.CreateAnd(guest_addr, ir.getInt32(~15u));
		}

		auto* page_idx = ir.CreateLShr(quad_addr, 12, "vmspi");
		auto* page_ptr = ir.CreateInBoundsGEP(pages_ty, pages, {ir.getInt32(0), page_idx}, "vmsp");
		auto* page_val = ir.CreateAlignedLoad(i32_ty, page_ptr, llvm::Align(4), true, "vmspv");
		auto* quad_off = ir.CreateAnd(quad_addr, 0xfff, "vmso");
		auto* quad_host = ir.CreateAdd(page_val, quad_off, "vmsa");

		quad_cache[{cache_bb, {base_key, quad_off_key}}] = quad_host;

		auto* host_addr = mod16 == 0 ? quad_host : ir_call.CreateAdd(quad_host, ir_call.getInt32(mod16), "vmsal");
		return ir_call.CreateIntToPtr(host_addr, llvm::PointerType::getUnqual(ctx), "vmspt");
	}

	inline llvm::Value* unwrap_v4f32_from_v4f64(llvm::Value* v, llvm::IRBuilder<>& ir)
	{
		if (auto* ext = llvm::dyn_cast<llvm::FPExtInst>(v))
		{
			if (auto* vt = llvm::dyn_cast<llvm::FixedVectorType>(ext->getSrcTy());
				vt && vt->getNumElements() == 4 && vt->getElementType()->isFloatTy())
			{
				return ext->getOperand(0);
			}
		}
		if (auto* uo = llvm::dyn_cast<llvm::UnaryOperator>(v); uo && uo->getOpcode() == llvm::Instruction::FNeg)
		{
			if (auto* ext = llvm::dyn_cast<llvm::FPExtInst>(uo->getOperand(0)))
			{
				if (auto* vt = llvm::dyn_cast<llvm::FixedVectorType>(ext->getSrcTy());
					vt && vt->getNumElements() == 4 && vt->getElementType()->isFloatTy())
				{
					return ir.CreateFNeg(ext->getOperand(0));
				}
			}
		}
		return nullptr;
	}

	// Simplify PPU stack alignment masks, AltiVec v4f64->v4f32 FMA & denormal/NaN flushes, and scalar fma->fmuladd.
	inline unsigned simplify_ppu_ir_before_opt(llvm::Module& module)
	{
		unsigned simplified = 0;
		for (auto& function : module)
		{
			if (function.isDeclaration() || !function.getName().starts_with("__0x") || function.arg_size() != 7) continue;
			for (auto& bb : function)
			{
				for (auto it = bb.begin(); it != bb.end();)
				{
					llvm::Instruction& inst = *it++;
					if (auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(&inst);
						bin && bin->getOpcode() == llvm::Instruction::And)
					{
						if (bin->getType()->isIntegerTy(64))
						{
							if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1)))
							{
								const int mod = get_known_align16_mod(bin->getOperand(0), &function);
								if (mod >= 0)
								{
									const uint64_t mask = c->getZExtValue();
									if (mask <= 15ULL)
									{
										bin->replaceAllUsesWith(llvm::ConstantInt::get(bin->getType(), static_cast<uint64_t>(mod) & mask));
										bin->eraseFromParent();
										++simplified;
										continue;
									}
									if ((mask == ~3ULL && (mod & 3) == 0)
										|| (mask == ~7ULL && (mod & 7) == 0)
										|| (mask == ~15ULL && (mod & 15) == 0))
									{
										bin->replaceAllUsesWith(bin->getOperand(0));
										bin->eraseFromParent();
										++simplified;
										continue;
									}
								}
							}
						}
						else if (auto* vt = llvm::dyn_cast<llvm::FixedVectorType>(bin->getType());
							vt && vt->getNumElements() == 4 && vt->getElementType()->isIntegerTy(32))
						{
							if (auto* xo = llvm::dyn_cast<llvm::BinaryOperator>(bin->getOperand(0));
								xo && xo->getOpcode() == llvm::Instruction::Xor)
							{
								if (auto* sh = llvm::dyn_cast<llvm::BinaryOperator>(xo->getOperand(0));
									sh && sh->getOpcode() == llvm::Instruction::LShr && llvm::isa<llvm::SExtInst>(sh->getOperand(0)))
								{
									bin->replaceAllUsesWith(bin->getOperand(1));
									bin->eraseFromParent();
									++simplified;
									continue;
								}
							}
						}
					}
					else if (auto* sel = llvm::dyn_cast<llvm::SelectInst>(&inst))
					{
						if (auto* vt = llvm::dyn_cast<llvm::FixedVectorType>(sel->getType());
							vt && vt->getNumElements() == 4 && vt->getElementType()->isFloatTy())
						{
							if (auto* cmp = llvm::dyn_cast<llvm::FCmpInst>(sel->getCondition());
								cmp && cmp->getPredicate() == llvm::FCmpInst::FCMP_UNO
								&& cmp->getOperand(0) == sel->getFalseValue()
								&& cmp->getOperand(1) == sel->getFalseValue())
							{
								sel->replaceAllUsesWith(sel->getFalseValue());
								sel->eraseFromParent();
								++simplified;
								continue;
							}
						}
					}
					else if (auto* trunc = llvm::dyn_cast<llvm::FPTruncInst>(&inst))
					{
						if (auto* vt = llvm::dyn_cast<llvm::FixedVectorType>(trunc->getType());
							vt && vt->getNumElements() == 4 && vt->getElementType()->isFloatTy())
						{
							if (auto* call = llvm::dyn_cast<llvm::CallInst>(trunc->getOperand(0));
								call && call->getIntrinsicID() == llvm::Intrinsic::fmuladd)
							{
								llvm::IRBuilder<> ir(trunc);
								auto* a = unwrap_v4f32_from_v4f64(call->getArgOperand(0), ir);
								auto* b = unwrap_v4f32_from_v4f64(call->getArgOperand(1), ir);
								auto* c = unwrap_v4f32_from_v4f64(call->getArgOperand(2), ir);
								if (a && b && c)
								{
									auto* fma32 = ir.CreateFAdd(ir.CreateFMul(a, b), c);
									trunc->replaceAllUsesWith(fma32);
									trunc->eraseFromParent();
									++simplified;
									continue;
								}
							}
						}
					}
					else if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
					{
						if (call->getIntrinsicID() == llvm::Intrinsic::fma)
						{
							llvm::IRBuilder<> ir(call);
							auto* fn = llvm::Intrinsic::getOrInsertDeclaration(&module, llvm::Intrinsic::fmuladd, {call->getType()});
							auto* repl = ir.CreateCall(fn, {call->getArgOperand(0), call->getArgOperand(1), call->getArgOperand(2)});
							call->replaceAllUsesWith(repl);
							call->eraseFromParent();
							++simplified;
							continue;
						}
					}
				}
			}
		}
		return simplified;
	}

	inline unsigned forward_ppu_vm_writes_to_reads(llvm::Module& module)
	{
		unsigned forwarded = 0;
		for (auto& function : module)
		{
			if (function.isDeclaration() || !function.getName().starts_with("__0x") || function.arg_size() != 7) continue;
			for (auto& bb : function)
			{
				llvm::Value* last_waddr = nullptr;
				llvm::Value* last_wval = nullptr;
				unsigned last_wbits = 0;
				for (auto it = bb.begin(); it != bb.end();)
				{
					llvm::Instruction& inst = *it++;
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
					{
						if (call->getIntrinsicID() == llvm::Intrinsic::bswap)
						{
							if (auto* inner = llvm::dyn_cast<llvm::CallInst>(call->getArgOperand(0));
								inner && inner->getIntrinsicID() == llvm::Intrinsic::bswap)
							{
								call->replaceAllUsesWith(inner->getArgOperand(0));
								call->eraseFromParent();
								++forwarded;
								continue;
							}
						}
						if (const auto* callee = call->getCalledFunction())
						{
							const auto name = callee->getName();
							if ((name == "rpcs3_web_vm_write8_raw" || name == "rpcs3_web_vm_write16_raw"
								|| name == "rpcs3_web_vm_write32_raw" || name == "rpcs3_web_vm_write64_raw")
								&& call->arg_size() == 2)
							{
								last_waddr = call->getArgOperand(0);
								last_wval = call->getArgOperand(1);
								last_wbits = last_wval->getType()->getPrimitiveSizeInBits();
								continue;
							}
							if ((name == "rpcs3_web_vm_read8_raw" || name == "rpcs3_web_vm_read16_raw"
								|| name == "rpcs3_web_vm_read32_raw" || name == "rpcs3_web_vm_read64_raw")
								&& call->arg_size() == 1)
							{
								const unsigned rbits = call->getType()->getPrimitiveSizeInBits();
								if (last_waddr && call->getArgOperand(0) == last_waddr && rbits == last_wbits)
								{
									call->replaceAllUsesWith(last_wval);
									call->eraseFromParent();
									++forwarded;
								}
								continue;
							}
						}
					}
					if (inst.mayWriteToMemory())
					{
						if (auto* store = llvm::dyn_cast<llvm::StoreInst>(&inst);
							store && llvm::getUnderlyingObject(store->getPointerOperand()) == function.getArg(1))
						{
							continue;
						}
						last_waddr = nullptr;
						last_wval = nullptr;
						last_wbits = 0;
					}
				}
			}
		}
		return forwarded;
	}

	inline void restore_vm_helper_memory_effects(llvm::Module& module)
	{
		for (auto& fn : module)
		{
			if (!fn.isDeclaration()) continue;
			const auto name = fn.getName();
			if (name == "rpcs3_web_vm_read8_raw" || name == "rpcs3_web_vm_read16_raw"
				|| name == "rpcs3_web_vm_read32_raw" || name == "rpcs3_web_vm_read64_raw"
				|| name == "rpcs3_web_vm_write8_raw" || name == "rpcs3_web_vm_write16_raw"
				|| name == "rpcs3_web_vm_write32_raw" || name == "rpcs3_web_vm_write64_raw")
			{
				fn.setMemoryEffects(llvm::MemoryEffects::unknown());
			}
		}
	}

	inline llvm::BitCastInst* match_lvx_vec_cast(llvm::CallInst* call_lo, llvm::CallInst* call_hi)
	{
		if (!call_lo->hasOneUse() || !call_hi->hasOneUse()) return nullptr;
		auto* zext_lo = llvm::dyn_cast<llvm::ZExtInst>(*call_lo->user_begin());
		auto* zext_hi = llvm::dyn_cast<llvm::ZExtInst>(*call_hi->user_begin());
		if (!zext_lo || !zext_hi || !zext_lo->hasOneUse() || !zext_hi->hasOneUse()) return nullptr;
		if (!zext_lo->getType()->isIntegerTy(128) || !zext_hi->getType()->isIntegerTy(128)) return nullptr;
		auto* shl_hi = llvm::dyn_cast<llvm::BinaryOperator>(*zext_hi->user_begin());
		if (!shl_hi || shl_hi->getOpcode() != llvm::Instruction::Shl || !shl_hi->hasOneUse()) return nullptr;
		const auto* c64 = llvm::dyn_cast<llvm::ConstantInt>(shl_hi->getOperand(1));
		if (!c64 || c64->getZExtValue() != 64) return nullptr;
		auto* or_inst = llvm::dyn_cast<llvm::BinaryOperator>(*zext_lo->user_begin());
		if (!or_inst || or_inst->getOpcode() != llvm::Instruction::Or || !or_inst->hasOneUse()) return nullptr;
		if ((or_inst->getOperand(0) != zext_lo || or_inst->getOperand(1) != shl_hi)
			&& (or_inst->getOperand(0) != shl_hi || or_inst->getOperand(1) != zext_lo))
		{
			return nullptr;
		}
		auto* bc = llvm::dyn_cast<llvm::BitCastInst>(*or_inst->user_begin());
		if (!bc || !bc->getType()->isVectorTy()) return nullptr;
		return bc;
	}

	inline void erase_lvx_vec_cast_chain(llvm::BitCastInst* vec_cast, llvm::CallInst* call_lo, llvm::CallInst* call_hi)
	{
		auto* or_inst = llvm::cast<llvm::Instruction>(vec_cast->getOperand(0));
		auto* zext_lo = llvm::cast<llvm::Instruction>(*call_lo->user_begin());
		auto* zext_hi = llvm::cast<llvm::Instruction>(*call_hi->user_begin());
		auto* shl_hi = llvm::cast<llvm::Instruction>(*zext_hi->user_begin());
		vec_cast->eraseFromParent();
		or_inst->eraseFromParent();
		shl_hi->eraseFromParent();
		zext_lo->eraseFromParent();
		zext_hi->eraseFromParent();
		call_hi->eraseFromParent();
		call_lo->eraseFromParent();
	}

	// Expand rpcs3_web_vm_read{8,16,32,64}_raw calls into inline guest-page table lookups
	// over @__rpcs3_guest_pages with fallback to the helper for unmapped or page-straddling reads.
	inline unsigned inline_vm_reads(llvm::Module& module)
	{
		std::vector<llvm::CallInst*> calls;
		for (auto& function : module)
			for (auto& block : function)
				for (auto& inst : block)
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
						if (const auto* callee = call->getCalledFunction(); callee && callee->isDeclaration())
						{
							const auto name = callee->getName();
							if ((name == "rpcs3_web_vm_read8_raw" || name == "rpcs3_web_vm_read16_raw"
								|| name == "rpcs3_web_vm_read32_raw" || name == "rpcs3_web_vm_read64_raw")
								&& call->arg_size() == 1 && call->getType()->isIntegerTy())
							{
								calls.push_back(call);
							}
						}
		if (calls.empty()) return 0;

		auto& ctx = module.getContext();
		auto* i32_ty = llvm::Type::getInt32Ty(ctx);
		auto* pages_ty = llvm::ArrayType::get(i32_ty, 0x100000);
		auto* pages = module.getOrInsertGlobal("__rpcs3_guest_pages", pages_ty);
		stack_quad_cache_t quad_cache;

		for (std::size_t idx = 0; idx < calls.size(); ++idx)
		{
			auto* call = calls[idx];
			auto* guest_addr = call->getArgOperand(0);
			auto* val_ty = call->getType();
			const unsigned byte_width = val_ty->getPrimitiveSizeInBits() / 8;
			auto* orig_bb = call->getParent();
			auto* func = orig_bb->getParent();

			const int mod16 = get_known_align16_mod(guest_addr, func);

			// Fuse paired 64-bit reads from lvx (rpcs3_web_vm_read64_raw(addr) + rpcs3_web_vm_read64_raw(addr + 8))
			if (byte_width == 8 && idx + 1 < calls.size())
			{
				auto* next_call = calls[idx + 1];
				if (next_call->getParent() == orig_bb && next_call->getType() == val_ty)
				{
					auto* addr_hi = llvm::dyn_cast<llvm::BinaryOperator>(next_call->getArgOperand(0));
					const auto* c8 = addr_hi ? llvm::dyn_cast<llvm::ConstantInt>(addr_hi->getOperand(1)) : nullptr;
					if (addr_hi && addr_hi->getOpcode() == llvm::Instruction::Add
						&& addr_hi->getOperand(0) == guest_addr && c8 && c8->getZExtValue() == 8
						&& (call->getNextNode() == next_call
							|| (call->getNextNode() == addr_hi && addr_hi->getNextNode() == next_call)))
					{
						if (call->getNextNode() == addr_hi)
						{
							addr_hi->moveBefore(call->getIterator());
						}
						auto* vec_cast = match_lvx_vec_cast(call, next_call);
						if (mod16 == 0 && is_ppu_stack_const_offset(guest_addr, func) && vec_cast)
						{
							auto* host_ptr = emit_branchless_stack_host_ptr(call, guest_addr, 0, pages_ty, pages, quad_cache);
							llvm::IRBuilder<> ir(call);
							auto* loaded_vec = ir.CreateAlignedLoad(vec_cast->getType(), host_ptr, llvm::Align(1), true, "vmsrv");
							vec_cast->replaceAllUsesWith(loaded_vec);
							erase_lvx_vec_cast_chain(vec_cast, call, next_call);
							++idx;
							continue;
						}

						auto* merge_bb = orig_bb->splitBasicBlock(call, "vmr_m");
						orig_bb->getTerminator()->eraseFromParent();

						auto* direct_bb = llvm::BasicBlock::Create(ctx, "vmr_d", func, merge_bb);
						auto* fallback_bb = llvm::BasicBlock::Create(ctx, "vmr_f", func, merge_bb);

						llvm::IRBuilder<> ir(orig_bb);
						auto* page_idx = ir.CreateLShr(guest_addr, 12, "vmrpi");
						auto* page_ptr = ir.CreateInBoundsGEP(pages_ty, pages, {ir.getInt32(0), page_idx}, "vmrp");
						auto* page_val = ir.CreateAlignedLoad(i32_ty, page_ptr, llvm::Align(4), true, "vmrpv");
						auto* offset = ir.CreateAnd(guest_addr, 0xfff, "vmro");
						auto* mapped = ir.CreateICmpNE(page_val, ir.getInt32(0), "vmrm");
						if (mod16 == 0)
						{
							ir.CreateCondBr(mapped, direct_bb, fallback_bb);
						}
						else
						{
							auto* in_page = ir.CreateICmpULE(offset, ir.getInt32(0x1000 - 16), "vmrin");
							ir.CreateCondBr(ir.CreateAnd(in_page, mapped, "vmrgo"), direct_bb, fallback_bb);
						}

						llvm::IRBuilder<> ir_d(direct_bb);
						auto* host_addr = ir_d.CreateAdd(page_val, offset, "vmra");
						auto* host_ptr_lo = ir_d.CreateIntToPtr(host_addr, llvm::PointerType::getUnqual(ctx), "vmrpt0");

						if (vec_cast)
						{
							auto* loaded_vec = ir_d.CreateAlignedLoad(vec_cast->getType(), host_ptr_lo, llvm::Align(1), true, "vmrv128");
							ir_d.CreateBr(merge_bb);

							llvm::IRBuilder<> ir_f(fallback_bb);
							auto* slow_lo = ir_f.CreateCall(call->getFunctionType(), call->getCalledOperand(), {guest_addr}, "vmrs0");
							auto* slow_hi = ir_f.CreateCall(next_call->getFunctionType(), next_call->getCalledOperand(), {addr_hi}, "vmrs1");
							auto* v2i64_ty = llvm::FixedVectorType::get(val_ty, 2);
							auto* v0 = ir_f.CreateInsertElement(llvm::PoisonValue::get(v2i64_ty), slow_lo, ir_f.getInt64(0));
							auto* v1 = ir_f.CreateInsertElement(v0, slow_hi, ir_f.getInt64(1));
							auto* slow_vec = ir_f.CreateBitCast(v1, vec_cast->getType(), "vmrs128");
							ir_f.CreateBr(merge_bb);

							llvm::IRBuilder<> ir_m(call);
							auto* phi_vec = ir_m.CreatePHI(vec_cast->getType(), 2);
							phi_vec->addIncoming(loaded_vec, direct_bb);
							phi_vec->addIncoming(slow_vec, fallback_bb);
							vec_cast->replaceAllUsesWith(phi_vec);
							erase_lvx_vec_cast_chain(vec_cast, call, next_call);
						}
						else
						{
							auto* loaded_lo = ir_d.CreateAlignedLoad(val_ty, host_ptr_lo, llvm::Align(1), true, "vmrv0");
							auto* host_addr_hi = ir_d.CreateAdd(host_addr, ir_d.getInt32(8), "vmra1");
							auto* host_ptr_hi = ir_d.CreateIntToPtr(host_addr_hi, llvm::PointerType::getUnqual(ctx), "vmrpt1");
							auto* loaded_hi = ir_d.CreateAlignedLoad(val_ty, host_ptr_hi, llvm::Align(1), true, "vmrv1");
							ir_d.CreateBr(merge_bb);

							llvm::IRBuilder<> ir_f(fallback_bb);
							auto* slow_lo = ir_f.CreateCall(call->getFunctionType(), call->getCalledOperand(), {guest_addr}, "vmrs0");
							auto* slow_hi = ir_f.CreateCall(next_call->getFunctionType(), next_call->getCalledOperand(), {addr_hi}, "vmrs1");
							ir_f.CreateBr(merge_bb);

							llvm::IRBuilder<> ir_m(call);
							auto* phi_lo = ir_m.CreatePHI(val_ty, 2);
							phi_lo->addIncoming(loaded_lo, direct_bb);
							phi_lo->addIncoming(slow_lo, fallback_bb);
							auto* phi_hi = ir_m.CreatePHI(val_ty, 2);
							phi_hi->addIncoming(loaded_hi, direct_bb);
							phi_hi->addIncoming(slow_hi, fallback_bb);
							call->replaceAllUsesWith(phi_lo);
							next_call->replaceAllUsesWith(phi_hi);
							call->eraseFromParent();
							next_call->eraseFromParent();
						}
						++idx;
						continue;
					}
				}
			}

			if (mod16 >= 0 && mod16 + static_cast<int>(byte_width) <= 16
				&& is_ppu_stack_const_offset(guest_addr, func))
			{
				auto* host_ptr = emit_branchless_stack_host_ptr(call, guest_addr, mod16, pages_ty, pages, quad_cache);
				llvm::IRBuilder<> ir(call);
				auto* loaded = ir.CreateAlignedLoad(val_ty, host_ptr, llvm::Align(1), true, "vmsr");
				call->replaceAllUsesWith(loaded);
				call->eraseFromParent();
				continue;
			}

			auto* merge_bb = orig_bb->splitBasicBlock(call, "vmr_m");
			orig_bb->getTerminator()->eraseFromParent();

			auto* direct_bb = llvm::BasicBlock::Create(ctx, "vmr_d", func, merge_bb);
			auto* fallback_bb = llvm::BasicBlock::Create(ctx, "vmr_f", func, merge_bb);

			llvm::IRBuilder<> ir(orig_bb);
			auto* page_idx = ir.CreateLShr(guest_addr, 12, "vmrpi");
			auto* page_ptr = ir.CreateInBoundsGEP(pages_ty, pages, {ir.getInt32(0), page_idx}, "vmrp");
			auto* page_val = ir.CreateAlignedLoad(i32_ty, page_ptr, llvm::Align(4), true, "vmrpv");
			auto* offset = ir.CreateAnd(guest_addr, 0xfff, "vmro");
			auto* mapped = ir.CreateICmpNE(page_val, ir.getInt32(0), "vmrm");
			if (mod16 >= 0 && mod16 + static_cast<int>(byte_width) <= 16)
			{
				ir.CreateCondBr(mapped, direct_bb, fallback_bb);
			}
			else
			{
				auto* in_page = ir.CreateICmpULE(offset, ir.getInt32(0x1000 - byte_width), "vmrin");
				ir.CreateCondBr(ir.CreateAnd(in_page, mapped, "vmrgo"), direct_bb, fallback_bb);
			}

			llvm::IRBuilder<> ir_d(direct_bb);
			auto* host_addr = ir_d.CreateAdd(page_val, offset, "vmra");
			auto* host_ptr = ir_d.CreateIntToPtr(host_addr, llvm::PointerType::getUnqual(ctx), "vmrpt");
			auto* loaded = ir_d.CreateAlignedLoad(val_ty, host_ptr, llvm::Align(1), true, "vmrv");
			ir_d.CreateBr(merge_bb);

			llvm::IRBuilder<> ir_f(fallback_bb);
			auto* slow = ir_f.CreateCall(call->getFunctionType(), call->getCalledOperand(), {guest_addr}, "vmrs");
			ir_f.CreateBr(merge_bb);

			llvm::IRBuilder<> ir_m(call);
			auto* phi = ir_m.CreatePHI(val_ty, 2);
			phi->addIncoming(loaded, direct_bb);
			phi->addIncoming(slow, fallback_bb);
			call->replaceAllUsesWith(phi);
			call->eraseFromParent();
		}
		return static_cast<unsigned>(calls.size());
	}

	inline bool is_ppu_stack_derived(const llvm::Value* v, const llvm::Function* func, unsigned depth = 0)
	{
		if (!func || func->arg_size() < 6 || !v || depth >= 10) return false;
		const llvm::Value* r1 = func->getArg(5);
		for (; depth < 10 && v; ++depth)
		{
			if (v == r1) return true;
			if (const auto* phi = llvm::dyn_cast<llvm::PHINode>(v))
			{
				if (phi->getNumIncomingValues() == 0) return false;
				bool saw_non_self = false;
				for (unsigned i = 0; i < phi->getNumIncomingValues(); ++i)
				{
					const auto* inc = phi->getIncomingValue(i);
					if (inc == phi) continue;
					if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(inc);
						bin && bin->getOpcode() == llvm::Instruction::Add && bin->getOperand(0) == phi
						&& llvm::isa<llvm::ConstantInt>(bin->getOperand(1)))
					{
						continue;
					}
					saw_non_self = true;
					if (!is_ppu_stack_const_offset(inc, func, depth + 1)) return false;
				}
				return saw_non_self;
			}
			if (const auto* trunc = llvm::dyn_cast<llvm::TruncInst>(v))
			{
				v = trunc->getOperand(0);
				continue;
			}
			if (const auto* load = llvm::dyn_cast<llvm::LoadInst>(v))
			{
				if (const auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(load->getPointerOperand()))
				{
					if (gep->getPointerOperand() == func->getArg(1) && gep->getNumIndices() == 2)
					{
						const auto* i0 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(1));
						const auto* i1 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(2));
						if (i0 && i1 && i0->isZero() && i1->getZExtValue() == 4)
						{
							return true;
						}
					}
				}
				return false;
			}
			if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(v))
			{
				const auto op = bin->getOpcode();
				if (op == llvm::Instruction::Add || op == llvm::Instruction::Or)
				{
					if (llvm::isa<llvm::ConstantInt>(bin->getOperand(1)))
					{
						v = bin->getOperand(0);
						continue;
					}
					if (llvm::isa<llvm::ConstantInt>(bin->getOperand(0)))
					{
						v = bin->getOperand(1);
						continue;
					}
					return is_ppu_stack_derived(bin->getOperand(0), func, depth + 1)
						|| is_ppu_stack_derived(bin->getOperand(1), func, depth + 1);
				}
				if (op == llvm::Instruction::And)
				{
					if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1));
						c && (c->getZExtValue() & 0xfffffff0ULL) == 0xfffffff0ULL)
					{
						v = bin->getOperand(0);
						continue;
					}
				}
			}
			break;
		}
		return false;
	}

	inline llvm::Value* match_stvx_vec_val(llvm::Value* val_lo, llvm::Value* val_hi)
	{
		const auto* tr_lo = llvm::dyn_cast<llvm::TruncInst>(val_lo);
		const auto* tr_hi = llvm::dyn_cast<llvm::TruncInst>(val_hi);
		if (!tr_lo || !tr_hi) return nullptr;
		const auto* lshr_hi = llvm::dyn_cast<llvm::BinaryOperator>(tr_hi->getOperand(0));
		if (!lshr_hi || lshr_hi->getOpcode() != llvm::Instruction::LShr) return nullptr;
		const auto* c64 = llvm::dyn_cast<llvm::ConstantInt>(lshr_hi->getOperand(1));
		if (!c64 || c64->getZExtValue() != 64) return nullptr;
		if (tr_lo->getOperand(0) != lshr_hi->getOperand(0)) return nullptr;
		if (auto* bc = llvm::dyn_cast<llvm::BitCastInst>(tr_lo->getOperand(0));
			bc && bc->getSrcTy()->isVectorTy())
		{
			return bc->getOperand(0);
		}
		return nullptr;
	}

	inline bool is_float_or_vec_store_val(const llvm::Value* val)
	{
		if (!val) return false;
		if (const auto* call = llvm::dyn_cast<llvm::CallInst>(val))
		{
			if (const auto* callee = call->getCalledFunction();
				callee && callee->getIntrinsicID() == llvm::Intrinsic::bswap && call->arg_size() == 1)
			{
				val = call->getArgOperand(0);
			}
		}
		if (const auto* bc = llvm::dyn_cast<llvm::BitCastInst>(val))
		{
			const auto* src_ty = bc->getSrcTy();
			if (src_ty->isFloatingPointTy() || src_ty->isVectorTy()) return true;
		}
		if (llvm::isa<llvm::ExtractElementInst>(val)) return true;
		if (const auto* tr = llvm::dyn_cast<llvm::TruncInst>(val))
		{
			if (tr->getSrcTy()->isIntegerTy(128)) return true;
		}
		return false;
	}

	inline void extract_addr_base_and_offset(const llvm::Value* addr, const llvm::Value*& base_out, int64_t& offset_out)
	{
		offset_out = 0;
		const llvm::Value* v = addr;
		if (const auto* tr = llvm::dyn_cast<llvm::TruncInst>(v))
		{
			v = tr->getOperand(0);
		}
		if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(v);
			bin && bin->getOpcode() == llvm::Instruction::And)
		{
			if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1));
				c && c->getZExtValue() == 0xffffffffULL)
			{
				v = bin->getOperand(0);
			}
		}
		if (const auto* bin = llvm::dyn_cast<llvm::BinaryOperator>(v);
			bin && bin->getOpcode() == llvm::Instruction::Add)
		{
			if (const auto* c = llvm::dyn_cast<llvm::ConstantInt>(bin->getOperand(1)))
			{
				base_out = bin->getOperand(0);
				offset_out = c->getSExtValue();
				return;
			}
		}
		base_out = v;
	}

	inline bool pure_between(llvm::Instruction* first, llvm::Instruction* second)
	{
		if (first->getParent() != second->getParent()) return false;
		unsigned steps = 0;
		for (auto* cur = first->getNextNode(); cur && cur != second; cur = cur->getNextNode())
		{
			if (++steps > 8 || cur->mayReadOrWriteMemory() || llvm::isa<llvm::CallBase>(cur) || cur->isTerminator())
			{
				return false;
			}
		}
		return true;
	}

	inline void move_between_before(llvm::Instruction* first, llvm::Instruction* second)
	{
		for (auto* cur = first->getNextNode(); cur && cur != second;)
		{
			auto* next = cur->getNextNode();
			cur->moveBefore(first->getIterator());
			cur = next;
		}
	}

	inline unsigned inline_vm_writes(llvm::Module& module)
	{
		std::vector<llvm::CallInst*> calls;
		for (auto& function : module)
			for (auto& block : function)
				for (auto& inst : block)
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
						if (const auto* callee = call->getCalledFunction(); callee && callee->isDeclaration())
						{
							const auto name = callee->getName();
							if ((name == "rpcs3_web_vm_write8_raw" || name == "rpcs3_web_vm_write16_raw"
								|| name == "rpcs3_web_vm_write32_raw" || name == "rpcs3_web_vm_write64_raw")
								&& call->arg_size() == 2 && call->getType()->isVoidTy())
							{
								calls.push_back(call);
							}
						}
		if (calls.empty()) return 0;

		auto& ctx = module.getContext();
		auto* i32_ty = llvm::Type::getInt32Ty(ctx);
		auto* i64_ty = llvm::Type::getInt64Ty(ctx);
		auto* v2i64_ty = llvm::FixedVectorType::get(i64_ty, 2);
		auto* pages_ty = llvm::ArrayType::get(i32_ty, 0x100000);
		auto* pages = module.getOrInsertGlobal("__rpcs3_guest_pages", pages_ty);
		stack_quad_cache_t quad_cache;
		unsigned inlined_count = 0;

		for (std::size_t idx = 0; idx < calls.size(); ++idx)
		{
			auto* call = calls[idx];
			auto* guest_addr = call->getArgOperand(0);
			auto* val = call->getArgOperand(1);
			const unsigned byte_width = val->getType()->getPrimitiveSizeInBits() / 8;

			auto* orig_bb = call->getParent();
			auto* func = orig_bb->getParent();
			const bool is_stack = is_ppu_stack_derived(guest_addr, func);
			if (!is_stack) continue;
			const int mod16 = get_known_align16_mod(guest_addr, func);

			// 1. Fuse 16-call dcbz cache-line zeroing burst (write64(base + 8*k, 0) for k = 0..15)
			if (byte_width == 8 && idx + 15 < calls.size())
			{
				const auto* c0 = llvm::dyn_cast<llvm::ConstantInt>(val);
				if (c0 && c0->isZero())
				{
					bool is_dcbz = true;
					for (unsigned k = 1; k < 16; ++k)
					{
						auto* ck = calls[idx + k];
						if (ck->getParent() != orig_bb || ck->getArgOperand(1) != val)
						{
							is_dcbz = false;
							break;
						}
						const auto* add_k = llvm::dyn_cast<llvm::BinaryOperator>(ck->getArgOperand(0));
						const auto* off_k = add_k ? llvm::dyn_cast<llvm::ConstantInt>(add_k->getOperand(1)) : nullptr;
						if (!add_k || add_k->getOpcode() != llvm::Instruction::Add
							|| add_k->getOperand(0) != guest_addr || !off_k || off_k->getZExtValue() != 8ULL * k
							|| !pure_between(calls[idx + k - 1], ck))
						{
							is_dcbz = false;
							break;
						}
					}
					if (is_dcbz)
					{
						for (unsigned k = 1; k < 16; ++k)
						{
							move_between_before(call, calls[idx + k]);
						}
						auto* merge_bb = orig_bb->splitBasicBlock(call, "vmw_m");
						orig_bb->getTerminator()->eraseFromParent();

						auto* direct_bb = llvm::BasicBlock::Create(ctx, "vmw_d", func, merge_bb);
						auto* fallback_bb = llvm::BasicBlock::Create(ctx, "vmw_f", func, merge_bb);

						llvm::IRBuilder<> ir(orig_bb);
						auto* page_idx = ir.CreateLShr(guest_addr, 12, "vmwpi");
						auto* page_ptr = ir.CreateInBoundsGEP(pages_ty, pages, {ir.getInt32(0), page_idx}, "vmwp");
						auto* page_val = ir.CreateAlignedLoad(i32_ty, page_ptr, llvm::Align(4), true, "vmwpv");
						auto* offset = ir.CreateAnd(guest_addr, 0xfff, "vmwo");
						auto* mapped = ir.CreateICmpNE(page_val, ir.getInt32(0), "vmwm");
						if (mod16 == 0)
						{
							ir.CreateCondBr(mapped, direct_bb, fallback_bb);
						}
						else
						{
							auto* in_page = ir.CreateICmpULE(offset, ir.getInt32(0x1000 - 128), "vmwin");
							ir.CreateCondBr(ir.CreateAnd(in_page, mapped, "vmwgo"), direct_bb, fallback_bb);
						}

						llvm::IRBuilder<> ir_d(direct_bb);
						auto* host_addr = ir_d.CreateAdd(page_val, offset, "vmwa");
						auto* zero_v = llvm::Constant::getNullValue(v2i64_ty);
						for (unsigned j = 0; j < 8; ++j)
						{
							auto* ha_j = j == 0 ? host_addr : ir_d.CreateAdd(host_addr, ir_d.getInt32(16 * j));
							auto* hp_j = ir_d.CreateIntToPtr(ha_j, llvm::PointerType::getUnqual(ctx));
							ir_d.CreateAlignedStore(zero_v, hp_j, llvm::Align(1), true);
						}
						ir_d.CreateBr(merge_bb);

						llvm::IRBuilder<> ir_f(fallback_bb);
						for (unsigned k = 0; k < 16; ++k)
						{
							auto* ck = calls[idx + k];
							ir_f.CreateCall(ck->getFunctionType(), ck->getCalledOperand(), {ck->getArgOperand(0), val});
						}
						ir_f.CreateBr(merge_bb);

						for (unsigned k = 0; k < 16; ++k)
						{
							calls[idx + k]->eraseFromParent();
						}
						idx += 15;
						inlined_count += 16;
						continue;
					}
				}
			}

			// 2. Fuse paired 64-bit stvx vector stores (write64(addr, lo) + write64(addr + 8, hi))
			if (byte_width == 8 && idx + 1 < calls.size())
			{
				auto* next_call = calls[idx + 1];
				if (next_call->getParent() == orig_bb && next_call->getArgOperand(1)->getType() == val->getType())
				{
					auto* addr_hi = llvm::dyn_cast<llvm::BinaryOperator>(next_call->getArgOperand(0));
					const auto* c8 = addr_hi ? llvm::dyn_cast<llvm::ConstantInt>(addr_hi->getOperand(1)) : nullptr;
					if (addr_hi && addr_hi->getOpcode() == llvm::Instruction::Add
						&& addr_hi->getOperand(0) == guest_addr && c8 && c8->getZExtValue() == 8
						&& pure_between(call, next_call))
					{
						move_between_before(call, next_call);
						auto* val_hi = next_call->getArgOperand(1);
						auto* vec_val = match_stvx_vec_val(val, val_hi);

						if (mod16 == 0 && is_ppu_stack_const_offset(guest_addr, func))
						{
							auto* host_ptr = emit_branchless_stack_host_ptr(call, guest_addr, 0, pages_ty, pages, quad_cache);
							llvm::IRBuilder<> ir(call);
							if (vec_val)
							{
								ir.CreateAlignedStore(vec_val, host_ptr, llvm::Align(1), true);
							}
							else
							{
								ir.CreateAlignedStore(val, host_ptr, llvm::Align(1), true);
								auto* host_ptr_hi = ir.CreateGEP( ir.getInt8Ty(), host_ptr, ir.getInt32(8));
								ir.CreateAlignedStore(val_hi, host_ptr_hi, llvm::Align(1), true);
							}
							next_call->eraseFromParent();
							call->eraseFromParent();
							++idx;
							inlined_count += 2;
							continue;
						}

						auto* merge_bb = orig_bb->splitBasicBlock(call, "vmw_m");
						orig_bb->getTerminator()->eraseFromParent();

						auto* direct_bb = llvm::BasicBlock::Create(ctx, "vmw_d", func, merge_bb);
						auto* fallback_bb = llvm::BasicBlock::Create(ctx, "vmw_f", func, merge_bb);

						llvm::IRBuilder<> ir(orig_bb);
						auto* page_idx = ir.CreateLShr(guest_addr, 12, "vmwpi");
						auto* page_ptr = ir.CreateInBoundsGEP(pages_ty, pages, {ir.getInt32(0), page_idx}, "vmwp");
						auto* page_val = ir.CreateAlignedLoad(i32_ty, page_ptr, llvm::Align(4), true, "vmwpv");
						auto* offset = ir.CreateAnd(guest_addr, 0xfff, "vmwo");
						auto* mapped = ir.CreateICmpNE(page_val, ir.getInt32(0), "vmwm");
						if (mod16 == 0)
						{
							ir.CreateCondBr(mapped, direct_bb, fallback_bb);
						}
						else
						{
							auto* in_page = ir.CreateICmpULE(offset, ir.getInt32(0x1000 - 16), "vmwin");
							ir.CreateCondBr(ir.CreateAnd(in_page, mapped, "vmwgo"), direct_bb, fallback_bb);
						}

						llvm::IRBuilder<> ir_d(direct_bb);
						auto* host_addr = ir_d.CreateAdd(page_val, offset, "vmwa");
						auto* host_ptr = ir_d.CreateIntToPtr(host_addr, llvm::PointerType::getUnqual(ctx), "vmwpt");
						if (vec_val)
						{
							ir_d.CreateAlignedStore(vec_val, host_ptr, llvm::Align(1), true);
						}
						else
						{
							ir_d.CreateAlignedStore(val, host_ptr, llvm::Align(1), true);
							auto* host_addr_hi = ir_d.CreateAdd(host_addr, ir_d.getInt32(8), "vmwa1");
							auto* host_ptr_hi = ir_d.CreateIntToPtr(host_addr_hi, llvm::PointerType::getUnqual(ctx), "vmwpt1");
							ir_d.CreateAlignedStore(val_hi, host_ptr_hi, llvm::Align(1), true);
						}
						ir_d.CreateBr(merge_bb);

						llvm::IRBuilder<> ir_f(fallback_bb);
						ir_f.CreateCall(call->getFunctionType(), call->getCalledOperand(), {guest_addr, val});
						ir_f.CreateCall(next_call->getFunctionType(), next_call->getCalledOperand(), {addr_hi, val_hi});
						ir_f.CreateBr(merge_bb);

						next_call->eraseFromParent();
						call->eraseFromParent();
						++idx;
						inlined_count += 2;
						continue;
					}
				}
			}

			if (mod16 >= 0 && mod16 + static_cast<int>(byte_width) <= 16
				&& is_ppu_stack_const_offset(guest_addr, func))
			{
				auto* host_ptr = emit_branchless_stack_host_ptr(call, guest_addr, mod16, pages_ty, pages, quad_cache);
				llvm::IRBuilder<> ir(call);
				ir.CreateAlignedStore(val, host_ptr, llvm::Align(1), true);
				call->eraseFromParent();
				++inlined_count;
				continue;
			}

			auto* merge_bb = orig_bb->splitBasicBlock(call, "vmw_m");
			orig_bb->getTerminator()->eraseFromParent();

			auto* direct_bb = llvm::BasicBlock::Create(ctx, "vmw_d", func, merge_bb);
			auto* fallback_bb = llvm::BasicBlock::Create(ctx, "vmw_f", func, merge_bb);

			llvm::IRBuilder<> ir(orig_bb);
			auto* page_idx = ir.CreateLShr(guest_addr, 12, "vmwpi");
			auto* page_ptr = ir.CreateInBoundsGEP(pages_ty, pages, {ir.getInt32(0), page_idx}, "vmwp");
			auto* page_val = ir.CreateAlignedLoad(i32_ty, page_ptr, llvm::Align(4), true, "vmwpv");
			auto* offset = ir.CreateAnd(guest_addr, 0xfff, "vmwo");
			auto* mapped = ir.CreateICmpNE(page_val, ir.getInt32(0), "vmwm");
			if (mod16 >= 0 && mod16 + static_cast<int>(byte_width) <= 16)
			{
				ir.CreateCondBr(mapped, direct_bb, fallback_bb);
			}
			else
			{
				auto* in_page = ir.CreateICmpULE(offset, ir.getInt32(0x1000 - byte_width), "vmwin");
				ir.CreateCondBr(ir.CreateAnd(in_page, mapped, "vmwgo"), direct_bb, fallback_bb);
			}

			llvm::IRBuilder<> ir_d(direct_bb);
			auto* host_addr = ir_d.CreateAdd(page_val, offset, "vmwa");
			auto* host_ptr = ir_d.CreateIntToPtr(host_addr, llvm::PointerType::getUnqual(ctx), "vmwpt");
			ir_d.CreateAlignedStore(val, host_ptr, llvm::Align(1), true);
			ir_d.CreateBr(merge_bb);

			llvm::IRBuilder<> ir_f(fallback_bb);
			ir_f.CreateCall(call->getFunctionType(), call->getCalledOperand(), {guest_addr, val});
			ir_f.CreateBr(merge_bb);

			call->eraseFromParent();
			++inlined_count;
		}
		return inlined_count;
	}
	// Dispatch-marker ABI 1: these browser bindings only return (dispatcher
	// returns a null address). PC and verification failure are already committed
	// by the guest program. Escape, channel, syscall and scheduling helpers are
	// real effects and must remain calls.
	inline unsigned lower_spu_dispatch_returns(llvm::Module& module)
	{
		unsigned count = 0;
		for (auto& function : module)
			for (auto& block : function)
				for (auto it = block.begin(); it != block.end();)
				{
					auto* call = llvm::dyn_cast<llvm::CallInst>(&*it++);
					const auto* callee = call ? call->getCalledFunction() : nullptr;
					if (!callee || !callee->isDeclaration()) continue;
					const auto name = callee->getName();
					const bool patchpoint = name.starts_with("__spu-0x") && (name.contains("-pp-") || name.contains("-chunkpp-"));
					if (name != "spu_dispatch" && name != "spu_dispatcher" && !patchpoint) continue;
					if (!call->getType()->isVoidTy())
					{
						if (name != "spu_dispatcher" || (!call->getType()->isPointerTy() && !call->getType()->isIntegerTy())) continue;
						call->replaceAllUsesWith(llvm::Constant::getNullValue(call->getType()));
					}
					call->eraseFromParent();
					++count;
				}
		return count;
	}

	// Lower recovered bctr jump tables (from libghidra JumpTable recovery) into direct LLVM switch
	// instructions targeting same-shard @__0x<case_pc> blocks, keeping WasmCallThroughTable as default.
	inline unsigned lower_jump_table_switches(llvm::Module& module, std::span<const jump_table_entry> jump_tables = active_jump_tables())
	{
		if (jump_tables.empty()) return 0;
		auto& ctx = module.getContext();
		const auto nocap = llvm::Attribute::getWithCaptureInfo(ctx, llvm::CaptureInfo::none());

		std::vector<std::pair<uint32_t, llvm::Function*>> sorted_funcs;
		sorted_funcs.reserve(module.size());
		for (auto& fn : module)
		{
			if (fn.isDeclaration() || !fn.getName().starts_with("__0x") || fn.arg_size() != 7) continue;
			uint32_t pc = 0;
			if (parse_guest_fn_pc(fn.getName(), pc))
			{
				sorted_funcs.emplace_back(pc, &fn);
			}
		}
		if (sorted_funcs.empty()) return 0;
		std::sort(sorted_funcs.begin(), sorted_funcs.end(),
			[](const auto& a, const auto& b) { return a.first < b.first; });

		unsigned lowered = 0;
		for (const auto& jt : jump_tables)
		{
			if (jt.targets.empty() || !jt.branch_pc) continue;
			const auto it = std::upper_bound(sorted_funcs.begin(), sorted_funcs.end(), jt.branch_pc,
				[](uint32_t pc, const auto& item) { return pc < item.first; });
			if (it == sorted_funcs.begin()) continue;
			const auto& [block_pc, fn] = *std::prev(it);
			if (jt.branch_pc - block_pc > 0x4000u) continue;
			if (std::next(std::prev(it)) != sorted_funcs.end() && jt.branch_pc >= std::next(std::prev(it))->first) continue;

			llvm::CallInst* indirect_call = nullptr;
			llvm::BasicBlock* bailout_bb = nullptr;
			llvm::Value* target_pc_val = nullptr;
			llvm::Type* context_ty = nullptr;

			for (auto& bb : *fn)
			{
				for (auto& inst : bb)
				{
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&inst);
						call && call->isMustTailCall() && call->arg_size() == 7 && !call->getCalledFunction())
					{
						indirect_call = call;
					}
					auto* store = llvm::dyn_cast<llvm::StoreInst>(&inst);
					if (!store) continue;
					auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(store->getPointerOperand());
					if (!gep || gep->getPointerOperand() != fn->getArg(1) || gep->getNumIndices() != 2) continue;
					auto* idx0 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(1));
					auto* idx1 = llvm::dyn_cast<llvm::ConstantInt>(gep->getOperand(2));
					if (idx0 && idx1 && idx0->isZero() && idx1->getZExtValue() == 166
						&& store->getValueOperand()->getType()->isIntegerTy(32)
						&& llvm::isa<llvm::ReturnInst>(bb.getTerminator()) && bb.size() <= 4)
					{
						bailout_bb = &bb;
						target_pc_val = store->getValueOperand();
						context_ty = gep->getSourceElementType();
					}
				}
			}
			if (!indirect_call || !bailout_bb || !target_pc_val || !context_ty) continue;

			auto* call_bb = indirect_call->getParent();
			auto* slot_bb = call_bb->getSinglePredecessor();
			auto* pred_bb = slot_bb ? slot_bb->getSinglePredecessor() : nullptr;
			if (!pred_bb) continue;

			std::vector<std::pair<uint32_t, llvm::Function*>> local_cases;
			std::vector<uint32_t> unique_targets = jt.targets;
			std::sort(unique_targets.begin(), unique_targets.end());
			unique_targets.erase(std::unique(unique_targets.begin(), unique_targets.end()), unique_targets.end());
			for (uint32_t case_pc : unique_targets)
			{
				auto* case_fn = module.getFunction(llvm::formatv("__0x{0:x}", case_pc).str());
				if (case_fn && !case_fn->isDeclaration() && case_fn->arg_size() == 7)
				{
					local_cases.emplace_back(case_pc, case_fn);
				}
			}
			if (local_cases.empty()) continue;

			auto* fallback_dispatch_bb = pred_bb->splitBasicBlock(pred_bb->getFirstInsertionPt(), "jt_fallback");
			pred_bb->getTerminator()->eraseFromParent();
			llvm::IRBuilder<> ir_sw(pred_bb);
			auto* sw = ir_sw.CreateSwitch(target_pc_val, fallback_dispatch_bb, static_cast<unsigned>(local_cases.size()));
			for (const auto& [case_pc, case_fn] : local_cases)
			{
				auto* case_bb = llvm::BasicBlock::Create(ctx, llvm::formatv("jt_0x{0:x}", case_pc).str(), fn);
				sw->addCase(ir_sw.getInt32(case_pc), case_bb);
				llvm::IRBuilder<> irc(case_bb);
				auto* gep_cia = irc.CreateInBoundsGEP(context_ty, fn->getArg(1), {irc.getInt32(0), irc.getInt32(166)});
				irc.CreateAlignedStore(irc.getInt32(case_pc), gep_cia, llvm::Align(4));
				// The indirect call's operands live in a later block than the switch. Load the
				// flushed guest registers in each case block so every musttail argument dominates
				// its call after the CFG is rewritten.
				auto* gep_r0 = irc.CreateInBoundsGEP(context_ty, fn->getArg(1), {irc.getInt32(0), irc.getInt32(3)});
				auto* r0_val = irc.CreateAlignedLoad(irc.getInt64Ty(), gep_r0, llvm::Align(8), "jt_r0");
				auto* gep_r1 = irc.CreateInBoundsGEP(context_ty, fn->getArg(1), {irc.getInt32(0), irc.getInt32(4)});
				auto* r1_val = irc.CreateAlignedLoad(irc.getInt64Ty(), gep_r1, llvm::Align(8), "jt_r1");
				auto* gep_r2 = irc.CreateInBoundsGEP(context_ty, fn->getArg(1), {irc.getInt32(0), irc.getInt32(5)});
				auto* r2_val = irc.CreateAlignedLoad(irc.getInt64Ty(), gep_r2, llvm::Align(8), "jt_r2");
				auto* c = irc.CreateCall(case_fn, {
					fn->getArg(0), fn->getArg(1), fn->getArg(2), fn->getArg(3),
					r0_val, r1_val, r2_val
				});
				c->setTailCallKind(llvm::CallInst::TCK_MustTail);
				c->addParamAttr(0, nocap);
				c->addParamAttr(1, nocap);
				irc.CreateRetVoid();
			}
			++lowered;
		}
		return lowered;
	}

	// Imported helpers cross Wasm instances. Some engines support local tail calls
	// but fail on that transition. Apply after IR optimization so code emission
	// cannot turn an imported call back into a tail call. Local recursion is intact.
	inline void preserve_import_call_frames(llvm::Module& module)
	{
		for (auto& function : module)
			for (auto& block : function)
				for (auto& instruction : block)
					if (auto* call = llvm::dyn_cast<llvm::CallInst>(&instruction))
						if (const auto* callee = call->getCalledFunction(); callee && callee->isDeclaration() && !callee->isIntrinsic())
							call->setTailCallKind(llvm::CallInst::TCK_NoTail);
	}
}
