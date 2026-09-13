#pragma once

#include <llvm/ADT/SmallPtrSet.h>
#include <llvm/Analysis/CGSCCPassManager.h>
#include <llvm/Analysis/LoopAnalysisManager.h>
#include <llvm/Analysis/ValueTracking.h>
#include <llvm/IR/Module.h>
#include <llvm/Passes/PassBuilder.h>
#include <llvm/Transforms/Scalar/ADCE.h>
#include <llvm/Transforms/Scalar/DeadStoreElimination.h>
#include <llvm/Transforms/Scalar/EarlyCSE.h>
#include <llvm/Transforms/Scalar/SimplifyCFG.h>
#include <llvm/Transforms/Utils/Cloning.h>

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
		unsigned functions = 0, linked_calls = 0, budget_exits = 0;
	};

	inline bool guest_function(const llvm::Function& f)
	{
		const auto name = f.getName();
		return name.starts_with("__spu-0x") || name.starts_with("__spu-cx")
			|| name.starts_with("__spu-fx") || name.starts_with("__spu-rx") || name.starts_with("__0x");
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
						if (function.size() + callee->size() > budget.blocks
							|| function.getInstructionCount() + callee->getInstructionCount() > budget.instructions)
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
				llvm::InlineFunctionInfo info;
				if (!llvm::InlineFunction(*edge, info).isSuccess()) break;
				++stats.linked_calls;
				changed = true;
			}
			if (changed)
			{
				cleanup.run(function, fam);
				function.addFnAttr("rpcs3.wasm.region", "1");
				++stats.functions;
			}
		}
		return stats;
	}
}
