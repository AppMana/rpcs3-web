#pragma once

#include <llvm/IR/IRBuilder.h>
#include <llvm/IR/IntrinsicsWebAssembly.h>
#include <llvm/IR/Module.h>

namespace wasm_codegen
{
	// Express unary byte permutations directly. WebKit's ARM64 BBQ shuffle
	// lowering otherwise reserves adjacent registers for a two-input TBL.
	// Keep this opt-in: other engines/tiers can optimize the shuffle themselves.
	inline unsigned lower_unary_byte_shuffles(llvm::Module& module)
	{
		unsigned changed = 0;
		for (auto& function : module)
			for (auto& block : function)
				for (auto it = block.begin(); it != block.end();)
				{
					auto* shuffle = llvm::dyn_cast<llvm::ShuffleVectorInst>(&*it++);
					if (!shuffle || shuffle->getType() != llvm::FixedVectorType::get(llvm::Type::getInt8Ty(module.getContext()), 16)) continue;
					if (shuffle->getOperand(0)->getType() != shuffle->getType()) continue;
					llvm::Value* input = nullptr;
					llvm::SmallVector<llvm::Constant*, 16> indices;
					bool valid = true;
					for (const int index : shuffle->getShuffleMask())
					{
						if (index < 0) { indices.push_back(llvm::ConstantInt::get(llvm::Type::getInt8Ty(module.getContext()), 255)); continue; }
						auto* source = shuffle->getOperand(index / 16);
						if (input && input != source) { valid = false; break; }
						input = source;
						indices.push_back(llvm::ConstantInt::get(llvm::Type::getInt8Ty(module.getContext()), index % 16));
					}
					if (!valid || !input) continue;
					llvm::IRBuilder<> builder(shuffle);
					auto* intrinsic = llvm::Intrinsic::getOrInsertDeclaration(&module, llvm::Intrinsic::wasm_swizzle);
					auto* result = builder.CreateCall(intrinsic, {input, llvm::ConstantVector::get(indices)});
					shuffle->replaceAllUsesWith(result);
					shuffle->eraseFromParent();
					++changed;
				}
		return changed;
	}
}
