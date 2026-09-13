#pragma once
#include <array>
#include <cstddef>
#include <cstdint>

namespace rsx::webgpu
{
	// Layout identity separates the two key kinds. Buffer keys retain exact
	// shader-visible storage sizes; texture keys have no buffer dependencies.
	using draw_binding_key = std::array<std::uint64_t, 37>;
	inline draw_binding_key buffer_binding_key(std::uint64_t layout, std::uint64_t uniform,
		std::uint64_t stream, std::uint64_t persistent_size, std::uint64_t transient_size)
	{
		return {layout, uniform, stream, persistent_size, transient_size};
	}
	struct draw_binding_hash
	{
		std::size_t operator()(const draw_binding_key& key) const noexcept
		{
			std::uint64_t hash = 0xcbf29ce484222325ull;
			for (auto word : key) hash = (hash ^ word) * 0x100000001b3ull;
			return static_cast<std::size_t>(hash);
		}
	};
}
