#include "rpcs3/Emu/RSX/WG/WebGPUCommand.h"
#include "rpcs3/Emu/RSX/WG/WebGPUHost.h"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <thread>
#include <vector>

namespace
{
	std::vector<std::byte> make_packet(std::uint64_t sequence, std::size_t payload_size = 16)
	{
		rsx::webgpu::draw_packet_header header{};
		header.sequence = sequence;
		std::vector<std::byte> payload(payload_size, std::byte{0x5a});
		rsx::webgpu::draw_packet_builder builder(header);
		assert(builder.append(rsx::webgpu::section_kind::registers, payload));
		return builder.finish();
	}
}

int main()
{
	using namespace rsx::webgpu;

	command_queue queue(1024);
	assert(queue.push(make_packet(7)));
	assert(queue.packet_count() == 1);
	assert(queue.front_size() > sizeof(draw_packet_header));

	std::array<std::byte, 8> too_small{};
	assert(queue.copy_front(too_small) == queue.front_size());
	assert(queue.packet_count() == 1);

	std::vector<std::byte> copy(queue.front_size());
	assert(queue.copy_front(copy) == copy.size());
	draw_packet_view view(copy);
	assert(view.valid());
	assert(view.header()->sequence == 7);
	assert(queue.pop_front());
	assert(!queue.pop_front());

	command_queue bounded(256);
	assert(!bounded.push(make_packet(8, 256)));
	assert(bounded.dropped_packets() == 1);

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
