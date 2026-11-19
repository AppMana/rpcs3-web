#pragma once

#include "util/types.hpp"
#include "util/logs.hpp"
#include "util/tsc.hpp"
#include "system_config.h"
#include <array>
#include <cmath>

LOG_CHANNEL(perf_log, "PERF");

// TODO: constexpr with the help of bitcast
template <auto Name>
inline const auto perf_name = []
{
	constexpr auto short_name = Name;
	std::array<char, sizeof(Name) + 1> result{};
	std::memcpy(result.data(), &short_name, sizeof(Name));
	return result;
}();

class perf_stat_base
{
	atomic_t<u64> m_log[66]{};

protected:
	// Print accumulated values
	void print(const char* name) const noexcept;

	// Accumulate values from a thread
	void push(u64 ns[66]) noexcept;

	// Get end time; accumulate value to the TLS
	static void push(u64 data[66], u64 start_time, const char* name) noexcept;

	// Register TLS storage for stats
	static void add(u64 ns[66], const char* name) noexcept;

	// Unregister TLS storage and drain its data
	static void remove(u64 ns[66], const char* name) noexcept;

public:
	perf_stat_base() noexcept = default;

	perf_stat_base(const perf_stat_base&) = delete;

	perf_stat_base& operator =(const perf_stat_base&) = delete;

	~perf_stat_base() {}

	// Collect all data, report it, and clean
	static void report() noexcept;
};

// Object that prints event length stats at the end
template <auto ShortName>
class perf_stat final : public perf_stat_base
{
	static inline thread_local struct perf_stat_local
	{
		// Local non-atomic values for increments
		u64 m_log[66]{};

		perf_stat_local() noexcept
		{
			perf_stat_base::add(m_log, perf_name<ShortName>.data());
		}

		~perf_stat_local()
		{
			perf_stat_base::remove(m_log, perf_name<ShortName>.data());
		}

	} g_tls_perf_stat;

public:
	static FORCE_INLINE SAFE_BUFFERS(void) push([[maybe_unused]] u64 start_time) noexcept
	{
#if !defined(_WIN32) || defined(_MSC_VER) // Windows clang LTO doesn't seem to like this template
		perf_stat_base::push(g_tls_perf_stat.m_log, start_time, perf_name<ShortName>.data());
#endif
	}
};

// Object that prints event length at the end
#ifdef RPCS3_WEB
template <auto ShortName, auto... SubEvents>
class perf_meter
{
	u64 m_timestamp = 0;

public:
	constexpr perf_meter() noexcept = default;
	constexpr perf_meter(int) noexcept {}
	constexpr explicit operator bool() const noexcept { return m_timestamp != 0; }

	template <auto SN, auto... S>
	constexpr perf_meter(const perf_meter<SN, S...>& r) noexcept : m_timestamp(r.raw_get()) {}

	template <auto SN, auto... S>
	constexpr perf_meter(perf_meter<SN, S...>&& r) noexcept : m_timestamp(r.raw_get()) { r.reset(); }

	template <auto SN, auto... S>
	constexpr perf_meter& operator =(const perf_meter<SN, S...>& r) noexcept
	{
		m_timestamp = r.raw_get();
		return *this;
	}

	template <auto SN, auto... S>
	constexpr perf_meter& operator =(perf_meter<SN, S...>& r) noexcept
	{
		m_timestamp = r.raw_get();
		r.reset();
		return *this;
	}

	template <auto Event, usz Index = 0>
	constexpr void push() noexcept {}

	constexpr u64 raw_get() const noexcept { return m_timestamp; }

	u64 get() noexcept
	{
		if (!m_timestamp)
		{
			m_timestamp = utils::get_tsc();
		}
		return m_timestamp;
	}

	u64 get() const noexcept
	{
		return m_timestamp ? m_timestamp : utils::get_tsc();
	}

	constexpr void reset() noexcept { m_timestamp = 0; }
	constexpr void restart() noexcept { m_timestamp = 0; }
	~perf_meter() = default;
};
#else
template <auto ShortName, auto... SubEvents>
class perf_meter
{
	// Initialize array (possibly only 1 element) with timestamp
	u64 m_timestamps[1 + sizeof...(SubEvents)];

public:
	FORCE_INLINE SAFE_BUFFERS() perf_meter() noexcept
	{
		restart();
	}

	FORCE_INLINE SAFE_BUFFERS() perf_meter(int) noexcept
	{
		std::fill(std::begin(m_timestamps), std::end(m_timestamps), 0);
	}

	FORCE_INLINE SAFE_BUFFERS(operator bool) () const noexcept
	{
		return m_timestamps[0] != 0;
	}

	// Copy first timestamp
	template <auto SN, auto... S>
	FORCE_INLINE SAFE_BUFFERS() perf_meter(const perf_meter<SN, S...>& r) noexcept
	{
		m_timestamps[0] = r.raw_get();
		std::memset(m_timestamps + 1, 0, sizeof(m_timestamps) - sizeof(u64));
	}

	template <auto SN, auto... S>
	SAFE_BUFFERS() perf_meter(perf_meter<SN, S...>&& r) noexcept
	{
		m_timestamps[0] = r.raw_get();
		r.reset();
	}

	// Copy first timestamp
	template <auto SN, auto... S>
	SAFE_BUFFERS(perf_meter&) operator =(const perf_meter<SN, S...>& r) noexcept
	{
		m_timestamps[0] = r.raw_get();
		return *this;
	}

	template <auto SN, auto... S>
	SAFE_BUFFERS(perf_meter&) operator =(perf_meter<SN, S...>& r) noexcept
	{
		m_timestamps[0] = r.raw_get();
		r.reset();
		return *this;
	}

	// Push subevent data in array
	template <auto Event, usz Index = 0>
	SAFE_BUFFERS(void) push() noexcept
	{
		// TODO: should use more efficient search with type comparison, then value comparison, or pattern matching
		if constexpr (std::array<bool, sizeof...(SubEvents)>{(SubEvents == Event)...}[Index])
		{
			// Push actual timestamp into an array (nothing to push into a disabled counter)
			m_timestamps[Index + 1] = m_timestamps[0] ? utils::get_tsc() : 0;
		}
		else if constexpr (Index < sizeof...(SubEvents))
		{
			// Proceed search recursively
			push<Event, Index + 1>();
		}
	}

	u64 raw_get() const noexcept
	{
		return m_timestamps[0];
	}

	// Obtain initial timestamp (lazily initialized on demand when perf_report is disabled)
	u64 get() noexcept
	{
		if (!m_timestamps[0])
		{
			m_timestamps[0] = utils::get_tsc();
		}
		return m_timestamps[0];
	}

	u64 get() const noexcept
	{
		return m_timestamps[0] ? m_timestamps[0] : utils::get_tsc();
	}

	// Disable this counter
	FORCE_INLINE SAFE_BUFFERS(void) reset() noexcept
	{
		m_timestamps[0] = 0;
	}

	// Re-initialize first timestamp when perf_report is enabled; callers that read get() for spin/wait
	// timeouts (e.g. SPUThread GETLLAR) lazily sample get_tsc() on demand without paying a Wasm->JS call
	// on every LARX/STCX/DMA/PUTLLC when perf_report is off.
	FORCE_INLINE SAFE_BUFFERS(void) restart() noexcept
	{
		m_timestamps[0] = g_cfg.core.perf_report ? utils::get_tsc() : 0;
		std::memset(m_timestamps + 1, 0, sizeof(m_timestamps) - sizeof(u64));
	}

	SAFE_BUFFERS() ~perf_meter()
	{
		// Disabled counter
		if (!m_timestamps[0]) [[unlikely]]
		{
			return;
		}

		if (!g_cfg.core.perf_report) [[likely]]
		{
			return;
		}

		// Register perf stat in nanoseconds
		perf_stat<ShortName>::push(m_timestamps[0]);

		// TODO: handle push(), currently ignored
	}
};
#endif
