#pragma once

#include "util/types.hpp"

#if defined(ARCH_X64)
#include "emmintrin.h"
#include "immintrin.h"
#endif

#ifdef ARCH_ARM64
#ifndef _MSC_VER
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wstrict-aliasing"
#pragma GCC diagnostic ignored "-Wold-style-cast"
#endif
#include "Emu/CPU/sse2neon.h"
#ifndef _MSC_VER
#pragma GCC diagnostic pop
#endif
#endif

namespace utils
{
	/**
	 * Stream a 128 bits vector to dst.
	 */
	static inline
		void stream_vector(void* dst, u32 x, u32 y, u32 z, u32 w)
	{
#if defined(ARCH_WASM32)
		// WebAssembly has no non-temporal store hint.  A fixed-size copy retains
		// the exact RSX payload layout and Clang lowers it to v128 load/store
		// when SIMD is enabled.
		const std::array<u32, 4> vector{x, y, z, w};
		std::memcpy(dst, vector.data(), sizeof(vector));
#else
		const __m128i vector = _mm_set_epi32(w, z, y, x);
		_mm_stream_si128(reinterpret_cast<__m128i*>(dst), vector);
#endif
	}

	static inline
		void stream_vector(void* dst, f32 x, f32 y, f32 z, f32 w)
	{
		stream_vector(dst, std::bit_cast<u32>(x), std::bit_cast<u32>(y), std::bit_cast<u32>(z), std::bit_cast<u32>(w));
	}

	/**
	 * Stream a 128 bits vector from src to dst.
	 */
	template <int Count = 1>
	void stream_vector_from_memory(void* dst, void* src)
	{
#if defined(ARCH_WASM32)
		std::memcpy(dst, src, Count * 16);
#else
		auto _src = reinterpret_cast<__m128i*>(src);
		auto _dst = reinterpret_cast<__m128i*>(dst);
		for (int i = 0; i < Count; ++i, ++_src, ++_dst)
		{
			const __m128i vector = _mm_loadu_si128(_src);
			_mm_stream_si128(_dst, vector);
		}
#endif
	}
}
