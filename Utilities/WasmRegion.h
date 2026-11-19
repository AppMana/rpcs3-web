#pragma once

#include <llvm/ADT/SmallPtrSet.h>
#include <llvm/Analysis/CGSCCPassManager.h>
#include <llvm/Analysis/LoopAnalysisManager.h>
#include <llvm/Analysis/ValueTracking.h>
#include <llvm/IR/IRBuilder.h>
#include <llvm/IR/Module.h>
#include <llvm/Passes/PassBuilder.h>
#include <llvm/Transforms/Scalar/ADCE.h>
#include <llvm/Transforms/Scalar/DeadStoreElimination.h>
#include <llvm/Transforms/Scalar/EarlyCSE.h>
#include <llvm/Transforms/Scalar/GVN.h>
#include <llvm/Transforms/Scalar/LICM.h>
#include <llvm/Transforms/Scalar/LoopRotation.h>
#include <llvm/Transforms/Scalar/SimplifyCFG.h>
#include <llvm/Transforms/Utils/Cloning.h>
#include <llvm/Transforms/Utils/LCSSA.h>
#include <llvm/Transforms/Utils/LoopSimplify.h>
#include <vector>

namespace wasm_codegen
{
	struct region_limits
	{
		unsigned blocks = 32;
		// This first lowering bounds LLVM instructions, conservatively including
		// verification and helpers' call sites, rather than estimating guest cost.
		unsigned instructions = 512;
	};

	struct region_statistics
	{
		unsigned functions = 0, linked_calls = 0, budget_exits = 0, self_loops = 0;
	};

	inline bool guest_function(const llvm::Function& f)
	{
		const auto name = f.getName();
		return name.starts_with("__spu-0x") || name.starts_with("__spu-cx")
			|| name.starts_with("__spu-fx") || name.starts_with("__spu-rx") || name.starts_with("__0x");
	}

	inline bool has_state_modifying_call(const llvm::Function& function)
	{
		for (const auto& bb : function)
		{
			if (bb.getName() == "__test" || bb.getName().ends_with(".exit")) continue;
			for (const auto& inst : bb)
			{
				const auto* call = llvm::dyn_cast<llvm::CallInst>(&inst);
				if (!call) continue;
				const auto* callee = call->getCalledFunction();
				if (!callee) continue;
				if (callee->isIntrinsic()) continue;
				const auto name = callee->getName();
				if (name == "__check" || name.starts_with("rpcs3_web_vm_read") || name.starts_with("rpcs3_web_vm_write")
					|| name == "__lwarx" || name == "__ldarx" || name == "__stwcx" || name == "__stdcx")
				{
					continue;
				}
				return true;
			}
		}
		return false;
	}

	inline void ensure_check_flushes_entry_gprs(llvm::Function& function)
	{
		if (function.isDeclaration() || !function.getName().starts_with("__0x")
			|| function.arg_size() != 7 || function.hasFnAttribute("rpcs3.wasm.check_flushed"))
		{
			return;
		}
		llvm::Type* ctx_ty = llvm::StructType::getTypeByName(function.getContext(), "context_t");
		if (!ctx_ty)
		{
			for (const auto& bb : function)
			{
				for (const auto& inst : bb)
				{
					if (const auto* gep = llvm::dyn_cast<llvm::GetElementPtrInst>(&inst);
						gep && gep->getPointerOperand() == function.getArg(1) && gep->getNumIndices() == 2)
					{
						ctx_ty = gep->getSourceElementType();
						break;
					}
				}
				if (ctx_ty) break;
			}
		}
		if (!ctx_ty) return;
		for (auto& bb : function)
		{
			if (bb.getName() != "__test") continue;
			for (auto& inst : bb)
			{
				auto* call = llvm::dyn_cast<llvm::CallInst>(&inst);
				const auto* callee = call ? call->getCalledFunction() : nullptr;
				if (!callee || callee->getName() != "__check") continue;
				llvm::IRBuilder<> ir(call);
				for (unsigned i = 0; i < 3; ++i)
				{
					auto* gep = ir.CreateInBoundsGEP(ctx_ty, function.getArg(1), {ir.getInt32(0), ir.getInt32(3 + i)});
					ir.CreateAlignedStore(function.getArg(4 + i), gep, llvm::Align(8));
				}
				break;
			}
			break;
		}
		function.addFnAttr("rpcs3.wasm.check_flushed", "1");
	}

	inline void strip_scoped_noalias_metadata(llvm::Function& function)
	{
		for (auto& bb : function)
		{
			for (auto it = bb.begin(); it != bb.end();)
			{
				auto* inst = &*it++;
				if (llvm::isa<llvm::NoAliasScopeDeclInst>(inst))
				{
					inst->eraseFromParent();
					continue;
				}
				inst->setMetadata(llvm::LLVMContext::MD_alias_scope, nullptr);
				inst->setMetadata(llvm::LLVMContext::MD_noalias, nullptr);
			}
		}
	}

	inline bool lower_self_loops(llvm::Function& function)
	{
		if (function.isDeclaration() || !function.getName().starts_with("__0x") || function.arg_size() != 7) return false;
		ensure_check_flushes_entry_gprs(function);
		std::vector<llvm::CallInst*> self_calls;
		for (auto& bb : function)
		{
			for (auto& inst : bb)
			{
				auto* call = llvm::dyn_cast<llvm::CallInst>(&inst);
				if (!call || !(call->isMustTailCall() || call->isTailCall())
					|| call->getCalledFunction() != &function || call->arg_size() != 7
					|| !llvm::isa_and_nonnull<llvm::ReturnInst>(call->getNextNode())) continue;
				if (call->getArgOperand(0) != function.getArg(0)
					|| call->getArgOperand(1) != function.getArg(1)
					|| call->getArgOperand(2) != function.getArg(2)
					|| call->getArgOperand(3) != function.getArg(3))
				{
					continue;
				}
				self_calls.push_back(call);
			}
		}
		if (self_calls.empty()) return false;

		auto* entry_bb = &function.getEntryBlock();
		llvm::BasicBlock* target_bb = entry_bb;
		bool entry_has_state_check = false;
		if (auto* br = llvm::dyn_cast<llvm::BranchInst>(entry_bb->getTerminator());
			br && br->isConditional() && br->getSuccessor(0)->getName() == "__body")
		{
			entry_has_state_check = true;
		}
		const bool can_strip_inner_checks = entry_has_state_check && !has_state_modifying_call(function);

		strip_scoped_noalias_metadata(function);
		for (auto& bb : function)
		{
			if (!can_strip_inner_checks || &bb == entry_bb) continue;
			auto* br = llvm::dyn_cast<llvm::BranchInst>(bb.getTerminator());
			if (!br || !br->isConditional()) continue;
			auto* succ0 = br->getSuccessor(0);
			auto* succ1 = br->getSuccessor(1);
			if (!succ0->getName().starts_with("__body")) continue;
			bool calls_check = false;
			for (const auto& inst : *succ1)
			{
				if (const auto* call = llvm::dyn_cast<llvm::CallInst>(&inst))
				{
					if (const auto* callee = call->getCalledFunction();
						callee && callee->getName() == "__check")
					{
						calls_check = true;
						break;
					}
				}
			}
			if (calls_check)
			{
				auto* cond_val = br->getCondition();
				succ1->removePredecessor(&bb);
				llvm::BranchInst::Create(succ0, br->getIterator());
				br->eraseFromParent();
				if (auto* cmp = llvm::dyn_cast<llvm::ICmpInst>(cond_val); cmp && cmp->use_empty())
				{
					auto* op0 = cmp->getOperand(0);
					cmp->eraseFromParent();
					if (auto* ld = llvm::dyn_cast<llvm::LoadInst>(op0); ld && ld->use_empty())
					{
						ld->eraseFromParent();
					}
				}
			}
		}
		auto* loop_bb = target_bb->splitBasicBlock(target_bb->getFirstNonPHIIt(), "__loop");
		llvm::IRBuilder<> phi_ir(&loop_bb->front());
		llvm::PHINode* phi_r[3]{};
		for (unsigned i = 0; i < 3; ++i)
		{
			auto* arg = function.getArg(4 + i);
			phi_r[i] = phi_ir.CreatePHI(arg->getType(), 1 + static_cast<unsigned>(self_calls.size()));
			arg->replaceUsesWithIf(phi_r[i], [&](llvm::Use& u)
			{
				const auto* inst = llvm::dyn_cast<llvm::Instruction>(u.getUser());
				if (!inst || inst == phi_r[i]) return false;
				const auto* bb = inst->getParent();
				return bb != entry_bb && bb != target_bb;
			});
			phi_r[i]->addIncoming(arg, target_bb);
		}
		for (auto* call : self_calls)
		{
			auto* call_bb = call->getParent();
			for (unsigned i = 0; i < 3; ++i)
			{
				phi_r[i]->addIncoming(call->getArgOperand(4 + i), call_bb);
			}
			auto* term = call_bb->getTerminator();
			llvm::IRBuilder<> br_ir(call);
			br_ir.CreateBr(loop_bb);
			call->eraseFromParent();
			if (term) term->eraseFromParent();
		}
		return true;
	}

	// Inline only known guest edges. Runtime imports remain observable barriers;
	// LLVM's inliner preserves their memory effects, verification and escape paths.
	// Reject expansion back into the current root; code-growth bounds do not
	// imply a bound on the remaining recursive calls at runtime.
	inline bool reaches(const llvm::Function* from, const llvm::Function* target,
		llvm::SmallPtrSetImpl<const llvm::Function*>& visited)
	{
		if (from == target) return true;
		if (!visited.insert(from).second) return false;
		for (const auto& block : *from)
			for (const auto& instruction : block)
				if (const auto* call = llvm::dyn_cast<llvm::CallBase>(&instruction))
					if (const auto* callee = call->getCalledFunction(); callee && !callee->isDeclaration() && guest_function(*callee))
						if (reaches(callee, target, visited)) return true;
		return false;
	}

	inline region_statistics form_regions(llvm::Module& module, region_limits limits = {})
	{
		region_statistics stats;
		const bool linked_programs = llvm::any_of(module, [](const llvm::Function& f) { return f.getName().starts_with("__spu-rx") && !f.isDeclaration(); });
		if (linked_programs)
		{
			// A region creates new backedges across program verification boundaries.
			// DMA may change LS concurrently: do not let CSE/loop optimization turn
			// these entry reads into one old value for the entire region invocation.
			for (auto& f : module)
				if (f.getName().starts_with("__spu-0x") && f.arg_size() >= 2)
					for (auto& block : f)
						for (auto& instruction : block)
							if (auto* load = llvm::dyn_cast<llvm::LoadInst>(&instruction);
								load && llvm::getUnderlyingObject(load->getPointerOperand()) == f.getArg(1)) load->setVolatile(true);
		}
		llvm::LoopAnalysisManager lam;
		llvm::FunctionAnalysisManager fam;
		llvm::CGSCCAnalysisManager cgam;
		llvm::ModuleAnalysisManager mam;
		llvm::PassBuilder pb;
		pb.registerModuleAnalyses(mam);
		pb.registerCGSCCAnalyses(cgam);
		pb.registerFunctionAnalyses(fam);
		pb.registerLoopAnalyses(lam);
		pb.crossRegisterProxies(lam, fam, cgam, mam);
		llvm::FunctionPassManager cleanup;
		cleanup.addPass(llvm::EarlyCSEPass(true));
		cleanup.addPass(llvm::SimplifyCFGPass());
		cleanup.addPass(llvm::DSEPass());
		cleanup.addPass(llvm::ADCEPass());

		llvm::FunctionPassManager loop_cleanup;
		loop_cleanup.addPass(llvm::EarlyCSEPass(true));
		loop_cleanup.addPass(llvm::SimplifyCFGPass());
		loop_cleanup.addPass(llvm::LoopSimplifyPass());
		loop_cleanup.addPass(llvm::LCSSAPass());
		loop_cleanup.addPass(llvm::createFunctionToLoopPassAdaptor(llvm::LoopRotatePass(), true));
		loop_cleanup.addPass(llvm::createFunctionToLoopPassAdaptor(llvm::LICMPass(llvm::LICMOptions(1000, 1000, true)), true));
		loop_cleanup.addPass(llvm::GVNPass());
		loop_cleanup.addPass(llvm::createFunctionToLoopPassAdaptor(llvm::LICMPass(llvm::LICMOptions(1000, 1000, true)), true));
		loop_cleanup.addPass(llvm::SimplifyCFGPass());
		loop_cleanup.addPass(llvm::DSEPass());
		loop_cleanup.addPass(llvm::ADCEPass());

		for (auto& function : module)
		{
			if (!function.isDeclaration() && guest_function(function))
			{
				ensure_check_flushes_entry_gprs(function);
			}
		}

		for (auto& function : module)
		{
			if (function.isDeclaration() || !guest_function(function)
				|| function.hasFnAttribute("rpcs3.wasm.region")) continue;
			bool changed = false;
			// Generated cross-program entries have a separate bounded wrapper CFG.
			// Their planner caps guest code at 32 blocks / 512 words; this lowering
			// also caps the resulting IR including checks and side exits.
			const auto budget = function.getName().starts_with("__spu-rx") ? region_limits{128, 4096} : limits;
			for (;;)
			{
				llvm::CallBase* edge = nullptr;
				for (auto& block : function)
				{
					for (auto& instruction : block)
					{
						auto* call = llvm::dyn_cast<llvm::CallInst>(&instruction);
						auto* callee = call ? call->getCalledFunction() : nullptr;
						if (!callee || callee->isDeclaration() || !guest_function(*callee)
							|| callee->hasFnAttribute(llvm::Attribute::NoInline)) continue;
						// Must-tail guest edges are continuation calls. Inlining one while the
						// callee can eventually return to this function creates an unrepresentable
						// recursive region (and LLVM aborts in the Wasm compiler). Keep the edge
						// intact here; optimize_ppu_loops() handles eligible cycles by rewriting
						// them into self-loops after the acyclic region pass.
						if (call->isMustTailCall()) continue;
						const bool single_use_spu_chunk = function.getName().starts_with("__spu-0x")
							&& callee->getName().starts_with("__spu-cx")
							&& callee->hasLocalLinkage() && callee->hasOneUse();
						const auto edge_budget = single_use_spu_chunk ? region_limits{256, 8192} : budget;
						if (function.size() + callee->size() > edge_budget.blocks
							|| function.getInstructionCount() + callee->getInstructionCount() > edge_budget.instructions)
						{
							++stats.budget_exits;
							continue;
						}
						llvm::SmallPtrSet<const llvm::Function*, 32> visited;
						if (reaches(callee, &function, visited)) continue;
						edge = call;
						break;
					}
					if (edge) break;
				}
				if (!edge) break;
				auto* inlined_callee = edge->getCalledFunction();
				if (inlined_callee) ensure_check_flushes_entry_gprs(*inlined_callee);
				const bool had_na0 = inlined_callee && inlined_callee->arg_size() >= 1 && inlined_callee->getArg(0)->hasAttribute(llvm::Attribute::NoAlias);
				const bool had_na1 = inlined_callee && inlined_callee->arg_size() >= 2 && inlined_callee->getArg(1)->hasAttribute(llvm::Attribute::NoAlias);
				if (had_na0) inlined_callee->removeParamAttr(0, llvm::Attribute::NoAlias);
				if (had_na1) inlined_callee->removeParamAttr(1, llvm::Attribute::NoAlias);
				llvm::InlineFunctionInfo info;
				const bool inlined_ok = llvm::InlineFunction(*edge, info).isSuccess();
				if (had_na0) inlined_callee->addParamAttr(0, llvm::Attribute::NoAlias);
				if (had_na1) inlined_callee->addParamAttr(1, llvm::Attribute::NoAlias);
				if (!inlined_ok) break;
				if (inlined_callee && inlined_callee->hasLocalLinkage() && inlined_callee->use_empty())
					inlined_callee->eraseFromParent();
				++stats.linked_calls;
				changed = true;
			}
			const bool self_looped = lower_self_loops(function);
			if (self_looped)
			{
				++stats.self_loops;
				loop_cleanup.run(function, fam);
				function.addFnAttr("rpcs3.wasm.region", "1");
				++stats.functions;
			}
			else if (changed)
			{
				strip_scoped_noalias_metadata(function);
				cleanup.run(function, fam);
				function.addFnAttr("rpcs3.wasm.region", "1");
				++stats.functions;
			}
		}
		return stats;
	}

	inline bool reaches_in_2_musttail_hops(const llvm::Function* from, const llvm::Function* target, bool& has_self_call)
	{
		has_self_call = false;
		bool reaches = false;
		llvm::SmallPtrSet<const llvm::Function*, 8> hop1;
		for (const auto& cb : *from)
		{
			for (const auto& ci : cb)
			{
				const auto* cc = llvm::dyn_cast<llvm::CallInst>(&ci);
				const auto* next = cc && cc->isMustTailCall() ? cc->getCalledFunction() : nullptr;
				if (!next || next->isDeclaration() || !next->getName().starts_with("__0x")) continue;
				if (next == from)
				{
					has_self_call = true;
					return false;
				}
				if (next == target)
				{
					reaches = true;
				}
				else
				{
					hop1.insert(next);
				}
			}
		}
		if (reaches) return true;
		for (const auto* mid : hop1)
		{
			bool mid_self = false;
			bool mid_reaches = false;
			for (const auto& cb : *mid)
			{
				for (const auto& ci : cb)
				{
					const auto* cc = llvm::dyn_cast<llvm::CallInst>(&ci);
					const auto* next = cc && cc->isMustTailCall() ? cc->getCalledFunction() : nullptr;
					if (!next) continue;
					if (next == mid) mid_self = true;
					if (next == target) mid_reaches = true;
				}
			}
			if (!mid_self && mid_reaches) return true;
		}
		return false;
	}

	inline region_statistics optimize_ppu_loops(llvm::Module& module)
	{
		region_statistics stats;
		llvm::LoopAnalysisManager lam;
		llvm::FunctionAnalysisManager fam;
		llvm::CGSCCAnalysisManager cgam;
		llvm::ModuleAnalysisManager mam;
		llvm::PassBuilder pb;
		pb.registerModuleAnalyses(mam);
		pb.registerCGSCCAnalyses(cgam);
		pb.registerFunctionAnalyses(fam);
		pb.registerLoopAnalyses(lam);
		pb.crossRegisterProxies(lam, fam, cgam, mam);

		llvm::FunctionPassManager cleanup;
		cleanup.addPass(llvm::EarlyCSEPass(true));
		cleanup.addPass(llvm::SimplifyCFGPass());
		cleanup.addPass(llvm::DSEPass());
		cleanup.addPass(llvm::ADCEPass());

		llvm::FunctionPassManager loop_cleanup;
		loop_cleanup.addPass(llvm::EarlyCSEPass(true));
		loop_cleanup.addPass(llvm::SimplifyCFGPass());
		loop_cleanup.addPass(llvm::LoopSimplifyPass());
		loop_cleanup.addPass(llvm::LCSSAPass());
		loop_cleanup.addPass(llvm::createFunctionToLoopPassAdaptor(llvm::LoopRotatePass(), true));
		loop_cleanup.addPass(llvm::createFunctionToLoopPassAdaptor(llvm::LICMPass(llvm::LICMOptions(1000, 1000, true)), true));
		loop_cleanup.addPass(llvm::GVNPass());
		loop_cleanup.addPass(llvm::createFunctionToLoopPassAdaptor(llvm::LICMPass(llvm::LICMOptions(1000, 1000, true)), true));
		loop_cleanup.addPass(llvm::SimplifyCFGPass());
		loop_cleanup.addPass(llvm::DSEPass());
		loop_cleanup.addPass(llvm::ADCEPass());

		llvm::DenseMap<const llvm::Function*, unsigned> cycle_in_degree;
		for (const auto& f : module)
		{
			if (f.isDeclaration() || !f.getName().starts_with("__0x")) continue;
			for (const auto& block : f)
			{
				for (const auto& inst : block)
				{
					const auto* call = llvm::dyn_cast<llvm::CallInst>(&inst);
					const auto* callee = call && call->isMustTailCall() ? call->getCalledFunction() : nullptr;
					if (!callee || callee == &f || callee->isDeclaration() || !callee->getName().starts_with("__0x")) continue;
					bool self_call = false;
					if (reaches_in_2_musttail_hops(callee, &f, self_call) && !self_call)
					{
						cycle_in_degree[callee] += 1;
					}
				}
			}
		}

		for (auto& function : module)
		{
			if (!function.isDeclaration() && function.getName().starts_with("__0x"))
			{
				ensure_check_flushes_entry_gprs(function);
			}
		}

		for (auto& function : module)
		{
			if (function.isDeclaration() || !function.getName().starts_with("__0x")) continue;
			const unsigned my_deg = cycle_in_degree.lookup(&function);

			// Collapse 2-block and 3-block mutual loops into 1-block self-loops.
			for (int step = 0; step < 3; ++step)
			{
				llvm::CallInst* mutual_edge = nullptr;
				for (auto& block : function)
				{
					for (auto& inst : block)
					{
						auto* call = llvm::dyn_cast<llvm::CallInst>(&inst);
						auto* callee = call ? call->getCalledFunction() : nullptr;
						if (!call || !call->isMustTailCall() || !callee || callee == &function
							|| callee->isDeclaration() || !callee->getName().starts_with("__0x")
							|| callee->hasFnAttribute("rpcs3.wasm.region")
							|| my_deg < cycle_in_degree.lookup(callee)
							|| function.getInstructionCount() + callee->getInstructionCount() > 650)
						{
							continue;
						}
						bool calls_self = false;
						const bool calls_back = reaches_in_2_musttail_hops(callee, &function, calls_self);
						if (calls_back && !calls_self)
						{
							mutual_edge = call;
							break;
						}
					}
					if (mutual_edge) break;
				}
				if (!mutual_edge) break;
				auto* m_callee = mutual_edge->getCalledFunction();
				if (m_callee) ensure_check_flushes_entry_gprs(*m_callee);
				const bool had_na0 = m_callee && m_callee->arg_size() >= 1 && m_callee->getArg(0)->hasAttribute(llvm::Attribute::NoAlias);
				const bool had_na1 = m_callee && m_callee->arg_size() >= 2 && m_callee->getArg(1)->hasAttribute(llvm::Attribute::NoAlias);
				if (had_na0) m_callee->removeParamAttr(0, llvm::Attribute::NoAlias);
				if (had_na1) m_callee->removeParamAttr(1, llvm::Attribute::NoAlias);
				llvm::InlineFunctionInfo info;
				const bool inlined_ok = llvm::InlineFunction(*mutual_edge, info).isSuccess();
				if (had_na0) m_callee->addParamAttr(0, llvm::Attribute::NoAlias);
				if (had_na1) m_callee->addParamAttr(1, llvm::Attribute::NoAlias);
				if (!inlined_ok) break;
				++stats.linked_calls;
			}

			if (lower_self_loops(function))
			{
				++stats.self_loops;
				loop_cleanup.run(function, fam);
				function.addFnAttr("rpcs3.wasm.region", "1");
				++stats.functions;
			}
			else
			{
				strip_scoped_noalias_metadata(function);
				cleanup.run(function, fam);
			}
		}
		return stats;
	}
}
