#pragma once

#ifdef LLVM_AVAILABLE

#include "PPUCodegenPolicy.h"

#include <llvm/Analysis/CGSCCPassManager.h>
#include <llvm/Analysis/LoopAnalysisManager.h>
#include <llvm/IR/Module.h>
#include <llvm/Passes/OptimizationLevel.h>
#include <llvm/Passes/PassBuilder.h>
#include <llvm/Target/TargetMachine.h>

namespace llvm_opt
{
	inline llvm::OptimizationLevel to_llvm_level(ppu_llvm_optimization level)
	{
		switch (level)
		{
		case ppu_llvm_optimization::o0: return llvm::OptimizationLevel::O0;
		case ppu_llvm_optimization::o1: return llvm::OptimizationLevel::O1;
		case ppu_llvm_optimization::o2: return llvm::OptimizationLevel::O2;
		case ppu_llvm_optimization::o3: return llvm::OptimizationLevel::O3;
		}

		return llvm::OptimizationLevel::O2;
	}

	// Run the target-independent NewPM pipeline while guest memory helpers are
	// still opaque. AOT lowering inlines those helpers afterwards; optimizing
	// the rewritten aliasing graph a second time can change guest memory
	// semantics.
	inline void optimize_module(
		llvm::Module& module,
		llvm::TargetMachine* target_machine,
		ppu_llvm_optimization level = ppu_llvm_optimization::o3)
	{
		if (level == ppu_llvm_optimization::o0 || module.empty())
		{
			return;
		}

		llvm::LoopAnalysisManager loop_analyses;
		llvm::FunctionAnalysisManager function_analyses;
		llvm::CGSCCAnalysisManager cgscc_analyses;
		llvm::ModuleAnalysisManager module_analyses;

		llvm::PassBuilder pass_builder(target_machine);
		pass_builder.registerModuleAnalyses(module_analyses);
		pass_builder.registerCGSCCAnalyses(cgscc_analyses);
		pass_builder.registerFunctionAnalyses(function_analyses);
		pass_builder.registerLoopAnalyses(loop_analyses);
		pass_builder.crossRegisterProxies(loop_analyses, function_analyses, cgscc_analyses, module_analyses);

		llvm::ModulePassManager passes = pass_builder.buildPerModuleDefaultPipeline(to_llvm_level(level));
		passes.run(module, module_analyses);
	}
}

#endif
