#include "rpcs3/Emu/RSX/WG/WebGPUCommand.h"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

int main()
{
	using namespace rsx::webgpu;

	draw_packet_header header{};
	header.sequence = 42;
	header.primitive = 5;
	header.vertex_count = 3;
	header.width = 1280;
	header.height = 720;

	const std::array<std::uint32_t, 4> program{0x01020304, 0x11223344, 0x55667788, 0x99aabbcc};
	const std::array<std::byte, 7> vertices{
		std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}, std::byte{5}, std::byte{6}, std::byte{7}
	};
	const raster_environment_packet raster{16, 24, 640, 360};

	draw_packet_builder builder(header);
	assert(builder.append(section_kind::vertex_program, std::as_bytes(std::span(program))));
	assert(builder.append(section_kind::persistent_vertices, vertices, 256));
	assert(builder.append(section_kind::raster_environment, std::as_bytes(std::span{&raster, 1})));
	auto bytes = builder.finish();

	draw_packet_view view(bytes);
	assert(view.valid());
	assert(view.header()->sequence == 42);
	assert(view.header()->vertex_count == 3);
	assert(view.header()->byte_size == bytes.size());
	assert(view.header()->sections[static_cast<std::size_t>(section_kind::vertex_program)].offset % 16 == 0);
	assert(view.header()->sections[static_cast<std::size_t>(section_kind::persistent_vertices)].offset % 256 == 0);
	assert(view.section(section_kind::vertex_program).size() == sizeof(program));
	assert(std::memcmp(view.section(section_kind::vertex_program).data(), program.data(), sizeof(program)) == 0);
	assert(view.section(section_kind::raster_environment).size() == sizeof(raster));
	assert(std::memcmp(view.section(section_kind::raster_environment).data(), &raster, sizeof(raster)) == 0);
	assert(view.section(section_kind::persistent_vertices).size() == vertices.size());
	assert(view.section(section_kind::indices).empty());

	auto truncated = bytes;
	truncated.pop_back();
	assert(!draw_packet_view(truncated).valid());

	auto corrupt = bytes;
	auto* corrupt_header = reinterpret_cast<draw_packet_header*>(corrupt.data());
	corrupt_header->sections[static_cast<std::size_t>(section_kind::vertex_program)].offset = corrupt_header->byte_size;
	assert(!draw_packet_view(corrupt).valid());

	draw_packet_builder duplicate;
	assert(duplicate.append(section_kind::indices, vertices));
	assert(!duplicate.append(section_kind::indices, vertices));
	assert(!duplicate.valid());
	assert(duplicate.finish().empty());

	return 0;
}
