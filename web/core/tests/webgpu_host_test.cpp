#include "rpcs3/Emu/RSX/WG/WebGPUCommand.h"
#include "rpcs3/Emu/RSX/WG/WebGPUHost.h"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <thread>
#include <vector>

namespace
{
	std::vector<std::byte> make_packet(std::uint64_t sequence, std::size_t payload_size = 16,
		rsx::webgpu::packet_kind kind = rsx::webgpu::packet_kind::draw)
	{
		rsx::webgpu::draw_packet_header header{};
		header.sequence = sequence;
		header.kind = kind;
		std::vector<std::byte> payload(payload_size, std::byte{0x5a});
		rsx::webgpu::draw_packet_builder builder(header);
		assert(builder.append(rsx::webgpu::section_kind::resolved_state, payload));
		return builder.finish();
	}
}

int main()
{
	using namespace rsx::webgpu;
	assert(packet_capture_level() == 4);
	set_packet_capture_level(2);
	assert(packet_capture_level() == 2);
	set_packet_capture_level(9);
	assert(packet_capture_level() == 5);

	command_queue queue(1024);
	assert(queue.push(make_packet(7)));
	assert(queue.packet_count() == 1);
	assert(queue.front_size() > sizeof(draw_packet_header));
	assert(queue.front_kind() == static_cast<std::uint32_t>(packet_kind::draw));

	std::array<std::byte, 8> too_small{};
	assert(queue.copy_front(too_small) == queue.front_size());
	assert(queue.packet_count() == 1);

	std::vector<std::byte> copy(queue.front_size());
	assert(queue.copy_front(copy) == copy.size());
	assert(queue.front_data() != nullptr);
	assert(std::memcmp(queue.front_data(), copy.data(), copy.size()) == 0);
	// A concurrent push must not move the front packet's storage.
	const std::byte* front_before = queue.front_data();
	assert(queue.push(make_packet(8)));
	assert(queue.front_data() == front_before);
	assert(queue.pop_front());
	assert(queue.pop_front());
	assert(queue.front_data() == nullptr);
	assert(queue.push(make_packet(7)));
	draw_packet_view view(copy);
	assert(view.valid());
	assert(view.header()->sequence == 7);
	assert(queue.pop_front());
	assert(queue.front_kind() == 0);
	assert(!queue.pop_front());

	command_queue bounded(256);
	assert(!bounded.push(make_packet(8, 256)));
	assert(bounded.dropped_packets() == 1);

	// Flip packets advance the frame counter the browser waits on; draws do not.
	command_queue frames(1024 * 1024);
	assert(frames.frame_counter() == 0);
	assert(frames.push(make_packet(1)));
	assert(frames.frame_counter() == 0);
	assert(frames.push(make_packet(2, 16, packet_kind::flip)));
	assert(frames.frame_counter() == 1);
	assert(frames.push(make_packet(3, 16, packet_kind::clear)));
	assert(frames.push(make_packet(4, 16, packet_kind::flip)));
	assert(frames.frame_counter() == 2);
	assert(frames.frame_counter_address() != nullptr);
	assert(frames.peak_queued_bytes() == frames.queued_bytes());
	assert(frames.pop_front());
	assert(frames.peak_queued_bytes() > frames.queued_bytes());

	command_queue concurrent(1024 * 1024);
	std::thread producer_a([&]
	{
		for (std::uint64_t i = 0; i < 100; ++i) assert(concurrent.push(make_packet(i)));
	});
	std::thread producer_b([&]
	{
		for (std::uint64_t i = 100; i < 200; ++i) assert(concurrent.push(make_packet(i)));
	});
	producer_a.join();
	producer_b.join();
	assert(concurrent.packet_count() == 200);
	assert(concurrent.queued_bytes() > 0);
	concurrent.clear();
	assert(concurrent.packet_count() == 0);
	assert(concurrent.queued_bytes() == 0);

	return 0;
}
