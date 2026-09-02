#pragma once

// Draw data both WebGPU backends derive with RPCS3's draw processor: vertex upload ranges and
// index streams (BufferUtils), inline fragment constant offsets and texture descriptors.

#include "util/types.hpp"
#include "Emu/RSX/RSXThread.h"
#include "WebGPUCommand.h"

#include <variant>
#include <vector>

namespace rsx::webgpu
{
	struct draw_vertex_upload
	{
		u32 first_vertex = 0;
		u32 allocated_vertex_count = 0;
		u32 draw_count = 0;
		u32 vertex_index_base = 0;
		u32 vertex_index_offset = 0;
		rsx::index_array_type index_type = rsx::index_array_type::u16;
		bool indexed = false;
		bool primitive_expanded = false;
		bool index_restart_sentinel = false;
		std::vector<std::byte> indices;
	};

	bool native_primitive(rsx::primitive_type primitive);

	draw_vertex_upload prepare_draw_vertex_upload(const rsx::vertex_input_layout& layout,
		const std::variant<rsx::draw_array_command, rsx::draw_indexed_array_command, rsx::draw_inlined_array>& command);

	// Byte offsets of a fragment program's inline constants (fragment_program_utils walk)
	std::vector<u32> fragment_inline_constant_offsets(const void* ucode, u32 ucode_length);

	// Render state resolved through rsx::method_registers and RPCS3's surface-format helpers (VKGSRender::decode_rsx_state / clear_surface)
	void fill_resolved_state(resolved_state_packet& state, u32 clear_mask, const rsx::framebuffer_layout& layout);

	// Descriptor of an enabled fragment texture plus its guest range; false when disabled
	bool describe_fragment_texture(const rsx::fragment_texture& texture, u32 slot, texture_packet_record& record, u32& address, u32& size);
}
