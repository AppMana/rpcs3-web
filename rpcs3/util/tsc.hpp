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
		// performance.now() is a wasm->JS import, so tight guest spin/sleep loops that poll the
		// timebase cross the border on EVERY read. Cache it in-wasm and refresh at most once per
		// 1 ms of host time: the guest timebase stays monotonic (the cache only increases) and
		// per-thread skew <= 1 ms (irrelevant to game pacing). This collapses the #1 guest-CPU
		// leaf ("now", ~9.6% of profiled time) to one import every ~1 ms instead of one per read.
		{
			static volatile u64 s_web_tb_cache = 0;
			static volatile double s_web_tb_at = 0.0;
			const double now = emscripten_get_now();
			if (now - s_web_tb_at > 1000.0)
			{
				s_web_tb_at = now;
				s_web_tb_cache = static_cast<u64>(now * 1'000'000.0);
			}
			return s_web_tb_cache;
		}
#else
#error "Missing utils::get_tsc() implementation"
#endif
	}
}
