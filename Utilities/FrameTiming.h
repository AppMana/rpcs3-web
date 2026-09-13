#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <vector>

namespace utils::frame_timing
{
	// RSX-thread wall-time scopes, not GPU timestamps or CPU accounting. Each
	// sample owns the phases completed since the preceding guest flip.
	// `draw` is the umbrella over end(); its sub-scopes partition the whole
	// clause-loop body plus the preamble and tail so nothing in end() stays
	// unclassified.
	enum class phase : unsigned { submit, present, limiter, fifo_idle, draw, draw_setup, draw_textures, draw_program, draw_clause, draw_vertex, draw_uniform, draw_bind, draw_encode, draw_end, count };
	inline constexpr std::array<const char*, static_cast<unsigned>(phase::count)> phase_names{
		"submit", "present", "limiter", "fifoIdle", "draw", "drawSetup", "drawTextures", "drawProgram", "drawClause", "drawVertex", "drawUniform", "drawBind", "drawEncode", "drawEnd"};
	using phase_times = std::array<double, static_cast<unsigned>(phase::count)>;
	inline phase_times pending_phases{};
	inline bool fifo_idle = false;
	inline double fifo_since = 0;

	struct sample
	{
		std::uint32_t frame;
		double time_us;
		phase_times phases_us{};
	};

	inline std::atomic<bool> enabled{false};
	inline std::mutex mutex;
	inline std::vector<sample> samples;
	inline std::uint32_t frame = 0;
	inline std::uint32_t dropped = 0;
	inline std::uint32_t capture_frame = 0;

	inline double now_us()
	{
		return std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now().time_since_epoch()).count();
	}

	inline void add_phase_us(phase kind, double elapsed)
	{
		if (enabled.load(std::memory_order_relaxed)) pending_phases[static_cast<unsigned>(kind)] += elapsed;
	}

	inline void account_fifo_idle(double time)
	{
		if (fifo_idle) pending_phases[static_cast<unsigned>(phase::fifo_idle)] += time - fifo_since;
		fifo_since = time;
	}

	inline void set_fifo_idle(bool idle)
	{
		if (!enabled.load(std::memory_order_relaxed) || idle == fifo_idle) return;
		account_fifo_idle(now_us());
		fifo_idle = idle;
	}

	class phase_scope
	{
		phase kind;
		bool active;
		double started;
	public:
		explicit phase_scope(phase value) : kind(value), active(enabled.load(std::memory_order_relaxed)), started(active ? now_us() : 0) {}
		phase_scope(const phase_scope&) = delete;
		phase_scope& operator=(const phase_scope&) = delete;
		// Close one stage and begin the next with a single clock read. Locals may
		// remain alive across stage boundaries (uploads feed subsequent bindings).
		void next(phase value)
		{
			if (active)
			{
				const double time = now_us();
				add_phase_us(kind, time - started);
				started = time;
			}
			kind = value;
		}
		~phase_scope() { if (active) add_phase_us(kind, now_us() - started); }
	};

	// Enable before boot; the RSX thread is the sole producer.
	inline void start(std::uint32_t capture_at = 0)
	{
		std::lock_guard lock(mutex);
		samples.clear();
		samples.reserve(60'000);
		frame = dropped = 0;
		pending_phases = {};
		fifo_idle = false;
		fifo_since = 0;
		capture_frame = capture_at;
		enabled.store(true, std::memory_order_release);
	}

	// Return a one-shot capture request after the configured guest flip.
	inline bool note_flip()
	{
		if (!enabled.load(std::memory_order_acquire)) return false;
		const double time = now_us();
		std::lock_guard lock(mutex);
		account_fifo_idle(time);
		++frame;
		if (samples.size() < 60'000) samples.push_back({frame, time, pending_phases});
		else ++dropped;
		pending_phases = {};
		return capture_frame != 0 && frame == capture_frame;
	}

	inline std::uint32_t position()
	{
		std::lock_guard lock(mutex);
		return frame;
	}

	struct batch
	{
		std::vector<sample> frames;
		std::uint32_t dropped;
	};

	inline batch drain()
	{
		std::lock_guard lock(mutex);
		batch result{samples, dropped};
		samples.clear();
		return result;
	}
}
