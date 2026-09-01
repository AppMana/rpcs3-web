#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
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
		[[nodiscard]] bool pop_front();

		[[nodiscard]] std::uint32_t packet_count() const;
		[[nodiscard]] std::uint64_t queued_bytes() const;
		[[nodiscard]] std::uint64_t dropped_packets() const;
		void clear();

	private:
		mutable std::mutex m_mutex;
		std::deque<std::vector<std::byte>> m_packets;
		std::size_t m_byte_limit;
		std::size_t m_queued_bytes = 0;
		std::uint64_t m_dropped_packets = 0;
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
	std::uint32_t rpcs3_webgpu_pop_front();
	std::uint64_t rpcs3_webgpu_queued_bytes();
	std::uint64_t rpcs3_webgpu_dropped_packets();
	void rpcs3_webgpu_set_capture_level(std::uint32_t level);
	void rpcs3_webgpu_clear();
}
