#include "WebGPUHost.h"

#include "WebGPUCommand.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <limits>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define RPCS3_WEB_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define RPCS3_WEB_EXPORT
#endif

namespace rsx::webgpu
{
	static std::atomic<std::uint32_t> s_packet_capture_level{4};

	std::uint32_t packet_capture_level()
	{
		return s_packet_capture_level.load(std::memory_order_relaxed);
	}

	void set_packet_capture_level(std::uint32_t level)
	{
		s_packet_capture_level.store(std::min(level, 5u), std::memory_order_relaxed);
	}

	command_queue::command_queue(std::size_t byte_limit)
		: m_byte_limit(std::max<std::size_t>(byte_limit, 1))
	{}

	bool command_queue::push(std::vector<std::byte> packet)
	{
		if (!draw_packet_view(packet).valid())
		{
			return false;
		}

		std::lock_guard lock(m_mutex);
		if (packet.size() > m_byte_limit || packet.size() > m_byte_limit - m_queued_bytes)
		{
			++m_dropped_packets;
			return false;
		}

		const bool is_flip = draw_packet_view(packet).header()->kind == packet_kind::flip;
		m_queued_bytes += packet.size();
		m_peak_queued_bytes = std::max(m_peak_queued_bytes, m_queued_bytes);
		m_packets.emplace_back(std::move(packet));

		if (is_flip)
		{
			m_frame_counter.fetch_add(1, std::memory_order_acq_rel);
#ifdef __EMSCRIPTEN__
			__builtin_wasm_memory_atomic_notify(reinterpret_cast<int*>(&m_frame_counter), 0x7fffffff);
#else
			m_frame_counter.notify_all();
#endif
		}
		return true;
	}

	std::uint32_t command_queue::front_size() const
	{
		std::lock_guard lock(m_mutex);
		if (m_packets.empty())
		{
			return 0;
		}
		return static_cast<std::uint32_t>(m_packets.front().size());
	}

	std::uint32_t command_queue::front_kind() const
	{
		std::lock_guard lock(m_mutex);
		if (m_packets.empty())
		{
			return 0;
		}

		const draw_packet_view packet(m_packets.front());
		return packet.valid() ? static_cast<std::uint32_t>(packet.header()->kind) : 0;
	}

	std::uint32_t command_queue::copy_front(std::span<std::byte> destination) const
	{
		std::lock_guard lock(m_mutex);
		if (m_packets.empty())
		{
			return 0;
		}

		const auto& packet = m_packets.front();
		const auto required = static_cast<std::uint32_t>(packet.size());
		if (destination.size() < packet.size())
		{
			return required;
		}

		std::memcpy(destination.data(), packet.data(), packet.size());
		return required;
	}

	const std::byte* command_queue::front_data() const
	{
		std::lock_guard lock(m_mutex);
		return m_packets.empty() ? nullptr : m_packets.front().data();
	}

	bool command_queue::pop_front()
	{
		std::lock_guard lock(m_mutex);
		if (m_packets.empty())
		{
			return false;
		}

		m_queued_bytes -= m_packets.front().size();
		m_packets.pop_front();
		return true;
	}

	std::uint32_t command_queue::packet_count() const
	{
		std::lock_guard lock(m_mutex);
		return static_cast<std::uint32_t>(m_packets.size());
	}

	std::uint64_t command_queue::queued_bytes() const
	{
		std::lock_guard lock(m_mutex);
		return m_queued_bytes;
	}

	std::uint64_t command_queue::peak_queued_bytes() const
	{
		std::lock_guard lock(m_mutex);
		return m_peak_queued_bytes;
	}

	std::uint64_t command_queue::dropped_packets() const
	{
		std::lock_guard lock(m_mutex);
		return m_dropped_packets;
	}

	void command_queue::clear()
	{
		std::lock_guard lock(m_mutex);
		m_packets.clear();
		m_queued_bytes = 0;
	}

	command_queue& host_command_queue()
	{
		static command_queue queue;
		return queue;
	}
}

extern "C"
{
	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_packet_abi()
	{
		return rsx::webgpu::draw_packet_abi;
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_packet_count()
	{
		return rsx::webgpu::host_command_queue().packet_count();
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_front_size()
	{
		return rsx::webgpu::host_command_queue().front_size();
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_front_kind()
	{
		return rsx::webgpu::host_command_queue().front_kind();
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_copy_front(void* destination, std::uint32_t capacity)
	{
		if (!destination && capacity)
		{
			return 0;
		}
		return rsx::webgpu::host_command_queue().copy_front(
			{static_cast<std::byte*>(destination), capacity});
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_front_data()
	{
		return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(
			rsx::webgpu::host_command_queue().front_data()));
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_pop_front()
	{
		return rsx::webgpu::host_command_queue().pop_front() ? 1u : 0u;
	}

	RPCS3_WEB_EXPORT std::uint64_t rpcs3_webgpu_queued_bytes()
	{
		return rsx::webgpu::host_command_queue().queued_bytes();
	}

	RPCS3_WEB_EXPORT std::uint64_t rpcs3_webgpu_peak_queued_bytes()
	{
		return rsx::webgpu::host_command_queue().peak_queued_bytes();
	}

	RPCS3_WEB_EXPORT std::uint64_t rpcs3_webgpu_dropped_packets()
	{
		return rsx::webgpu::host_command_queue().dropped_packets();
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_frame_counter()
	{
		return rsx::webgpu::host_command_queue().frame_counter();
	}

	RPCS3_WEB_EXPORT std::uint32_t rpcs3_webgpu_frame_counter_address()
	{
		return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(
			rsx::webgpu::host_command_queue().frame_counter_address()));
	}

	RPCS3_WEB_EXPORT void rpcs3_webgpu_set_capture_level(std::uint32_t level)
	{
		rsx::webgpu::set_packet_capture_level(level);
	}

	RPCS3_WEB_EXPORT void rpcs3_webgpu_clear()
	{
		rsx::webgpu::host_command_queue().clear();
	}
}
