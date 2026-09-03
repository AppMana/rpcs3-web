#pragma once

#include "util/types.hpp"

#ifdef _M_X64
#ifdef _MSC_VER
extern "C" u64 __rdtsc();
#else
#include <immintrin.h>
#endif
#endif

#ifdef ARCH_WASM32
#include <emscripten.h>
#endif

namespace utils
{
	inline u64 get_tsc()
	{
#if defined(ARCH_ARM64)
		u64 r = 0;
		__asm__ volatile("mrs %0, cntvct_el0" : "=r" (r));
		return r;
#elif defined(_M_X64)
		return __rdtsc();
#elif defined(ARCH_X64)
		return __builtin_ia32_rdtsc();
#elif defined(ARCH_WASM32)
		// No cycle counter here: the monotonic clock stands in for one, ticking once per nanosecond
		// (utils::get_tsc_freq()). emscripten_get_now() is performance.now(), the clock
		// std::chrono::steady_clock reads, without the WASI clock_time_get shim in between.
		return static_cast<u64>(emscripten_get_now() * 1'000'000.0);
#else
#error "Missing utils::get_tsc() implementation"
#endif
	}
}
