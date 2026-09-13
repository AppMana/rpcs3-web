#pragma once

#include <llvm/IR/Instructions.h>
#include <llvm/IR/Module.h>

namespace wasm_codegen
{
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
