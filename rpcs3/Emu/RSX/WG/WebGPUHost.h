#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <span>
#include <vector>

namespace rsx::webgpu
{
	// Thread-safe handoff between RPCS3's RSX thread and the browser host.  The
	// producer never exposes a pointer into the queue because Wasm memory growth
	// and cross-thread access would make such a pointer unsafe for JavaScript.
	class command_queue
	{
	public:
		explicit command_queue(std::size_t byte_limit = 64 * 1024 * 1024);

		[[nodiscard]] bool push(std::vector<std::byte> packet);
		[[nodiscard]] std::uint32_t front_size() const;
		[[nodiscard]] std::uint32_t front_kind() const;
		[[nodiscard]] std::uint32_t copy_front(std::span<std::byte> destination) const;
		// Address of the front packet's bytes. std::deque keeps element storage
		// stable across push_back, and only the consumer pops or clears, so the
		// consumer may copy from this address until it calls pop_front.
		[[nodiscard]] const std::byte* front_data() const;
		[[nodiscard]] bool pop_front();
		// Called by the host exports before a packet leaves the queue: delivered is false when the
		// host discards it unrendered (or the queue is cleared), so the producer can retract
		// per-packet state such as texture residency.
		using pop_hook = void (*)(bool delivered);
		void set_pop_hook(pop_hook hook) noexcept { m_pop_hook.store(hook); }
		[[nodiscard]] pop_hook get_pop_hook() const noexcept { return m_pop_hook.load(); }

		[[nodiscard]] std::uint32_t packet_count() const;
		[[nodiscard]] std::uint64_t queued_bytes() const;
		[[nodiscard]] std::uint64_t peak_queued_bytes() const;
		[[nodiscard]] std::uint64_t dropped_packets() const;
		void clear();

		// Number of flip packets accepted so far.  The browser worker waits on
		// this word (Atomics.waitAsync) instead of polling; push() notifies it
		// after every accepted flip.
		[[nodiscard]] std::uint32_t frame_counter() const noexcept { return m_frame_counter.load(std::memory_order_acquire); }
		// Invoked on the producer (RSX) thread with the new flip count after
		// every accepted flip, outside the queue lock. Used to apply
		// frame-indexed input schedules exactly at guest frame boundaries.
		void set_flip_callback(std::function<void(std::uint32_t)> callback);
		[[nodiscard]] const std::atomic<std::uint32_t>* frame_counter_address() const noexcept { return &m_frame_counter; }

	private:
		mutable std::mutex m_mutex;
		std::deque<std::vector<std::byte>> m_packets;
		std::size_t m_byte_limit;
		std::size_t m_queued_bytes = 0;
		std::size_t m_peak_queued_bytes = 0;
		std::uint64_t m_dropped_packets = 0;
		std::atomic<pop_hook> m_pop_hook{nullptr};
		alignas(4) std::atomic<std::uint32_t> m_frame_counter{0};
		std::mutex m_callback_mutex;
		std::function<void(std::uint32_t)> m_flip_callback;
	};

	command_queue& host_command_queue();
	std::uint32_t packet_capture_level();
	void set_packet_capture_level(std::uint32_t level);
}

// Copy-based C ABI consumed from a browser worker.  copy_front returns the
// required packet size without modifying the queue when capacity is too small.
extern "C"
{
	std::uint32_t rpcs3_webgpu_packet_abi();
	std::uint32_t rpcs3_webgpu_packet_count();
	std::uint32_t rpcs3_webgpu_front_size();
	std::uint32_t rpcs3_webgpu_front_kind();
	std::uint32_t rpcs3_webgpu_copy_front(void* destination, std::uint32_t capacity);
	std::uint32_t rpcs3_webgpu_front_data();
	std::uint32_t rpcs3_webgpu_pop_front();
	std::uint64_t rpcs3_webgpu_queued_bytes();
	std::uint64_t rpcs3_webgpu_peak_queued_bytes();
	std::uint64_t rpcs3_webgpu_dropped_packets();
	std::uint32_t rpcs3_webgpu_frame_counter();
	std::uint32_t rpcs3_webgpu_frame_counter_address();
	void rpcs3_webgpu_set_capture_level(std::uint32_t level);
	void rpcs3_webgpu_clear();
}
