#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace rsx::webgpu
{
	constexpr std::uint32_t draw_packet_magic = 0x52444757; // "WGDR" in little endian memory.
	constexpr std::uint32_t draw_packet_abi = 5;

	enum class packet_kind : std::uint32_t
	{
		draw = 1,
		clear = 2,
		flip = 3,
	};

	enum draw_packet_flag : std::uint32_t
	{
		packet_indexed = 1u << 0,
		packet_primitive_expanded = 1u << 1,
		packet_uses_fragment_textures = 1u << 2,
		packet_uses_vertex_textures = 1u << 3,
		packet_texture_payload_pending = 1u << 4,
		packet_skipped = 1u << 5,
		packet_primitive_restart = 1u << 6, // hardware restart applies (VKGSRender::decode_vertex_input_assembly_state rule)
		packet_index_restart_sentinel = 1u << 7, // the index stream's maximum equals the type's restart sentinel
	};

	// Backend-neutral texture identity. Texture bytes are appended after the
	// records in the textures section; data_offset is relative to that section.
	struct texture_packet_record
	{
		std::uint32_t stage = 0; // 0 = fragment, 1 = vertex
		std::uint32_t slot = 0;
		std::uint32_t address = 0;
		std::uint32_t format = 0;
		std::uint32_t width = 0;
		std::uint32_t height = 0;
		std::uint32_t depth = 0;
		std::uint32_t pitch = 0;
		std::uint32_t mip_count = 0;
		std::uint32_t dimension = 0;
		std::uint32_t data_offset = 0;
		std::uint32_t data_size = 0;
		std::uint32_t content_hash = 0;
		std::uint32_t remap = 0;
		std::uint32_t address_modes = 0; // wrap_s | wrap_t << 8 | wrap_r << 16 | border_type << 24
		std::uint32_t filter_modes = 0;
	};

	static_assert(sizeof(texture_packet_record) == 64);

	struct raster_environment_packet
	{
		std::uint32_t scissor_x = 0;
		std::uint32_t scissor_y = 0;
		std::uint32_t scissor_width = 0;
		std::uint32_t scissor_height = 0;
	};

	static_assert(sizeof(raster_environment_packet) == 16);

	// Render state resolved by RPCS3's common RSX code (rsx::method_registers
	// accessors and the same surface-format helpers the Vulkan backend uses).
	// Enum-valued fields carry the CELL_GCM values RPCS3's enums are defined
	// with; the browser translates them to WebGPU enums without re-deriving
	// guest semantics. Clear fields are meaningful on clear packets only.
	struct resolved_state_packet
	{
		std::uint32_t clear_mask = 0;          // RSX_GCM_CLEAR_* bits after RPCS3's format/stencil adjustments
		float clear_color[4] = {};             // normalized, after surface-format clear-color helpers
		float clear_depth = 0.f;               // z_clear_value / max depth value of the surface format
		std::uint32_t clear_stencil = 0;
		std::uint32_t surface_color_format = 0;
		std::uint32_t surface_depth_format = 0;
		std::uint32_t draw_buffer_count = 0;

		std::uint32_t depth_test_enabled = 0;
		std::uint32_t depth_write_enabled = 0;
		std::uint32_t depth_func = 0;
		std::uint32_t depth_clamp_enabled = 0;
		std::uint32_t depth_clip_enabled = 0;
		std::uint32_t depth_bounds_test_enabled = 0;
		float depth_bounds_min = 0.f;
		float depth_bounds_max = 0.f;

		std::uint32_t stencil_test_enabled = 0;
		std::uint32_t two_sided_stencil_test_enabled = 0;
		std::uint32_t stencil_func = 0;
		std::uint32_t stencil_op_fail = 0;
		std::uint32_t stencil_op_zfail = 0;
		std::uint32_t stencil_op_zpass = 0;
		std::uint32_t stencil_func_ref = 0;
		std::uint32_t stencil_func_mask = 0;
		std::uint32_t stencil_mask = 0;
		std::uint32_t back_stencil_func = 0;
		std::uint32_t back_stencil_op_fail = 0;
		std::uint32_t back_stencil_op_zfail = 0;
		std::uint32_t back_stencil_op_zpass = 0;
		std::uint32_t back_stencil_func_ref = 0;
		std::uint32_t back_stencil_func_mask = 0;
		std::uint32_t back_stencil_mask = 0;

		std::uint32_t logic_op_enabled = 0;
		std::uint32_t logic_operation = 0;
		std::uint32_t blend_enabled_mask = 0;  // bit n = draw buffer n
		std::uint32_t blend_sfactor_rgb = 0;
		std::uint32_t blend_sfactor_a = 0;
		std::uint32_t blend_dfactor_rgb = 0;
		std::uint32_t blend_dfactor_a = 0;
		std::uint32_t blend_equation_rgb = 0;
		std::uint32_t blend_equation_a = 0;
		float blend_color[4] = {};             // rsx::get_constant_blend_colors()
		std::uint32_t color_write_mask[4] = {}; // bit0 R, bit1 G, bit2 B, bit3 A, host-resolved per draw buffer
		std::uint32_t alpha_test_enabled = 0;
		std::uint32_t alpha_func = 0;
		float alpha_ref = 0.f;

		std::uint32_t cull_face_enabled = 0;
		std::uint32_t cull_face_mode = 0;
		std::uint32_t front_face_mode = 0;
		float line_width = 0.f;
		std::uint32_t poly_offset_fill_enabled = 0;
		float poly_offset_scale = 0.f;
		float poly_offset_bias = 0.f;
		std::uint32_t shader_control = 0;
		std::uint32_t reserved[2] = {};
	};

	static_assert(sizeof(resolved_state_packet) == 256);

	enum class section_kind : std::uint32_t
	{
		resolved_state,
		vertex_program,
		fragment_program,
		vertex_constants,
		vertex_layout,
		vertex_environment,
		fragment_environment,
		persistent_vertices,
		volatile_vertices,
		indices,
		textures,
		raster_environment,
		fragment_constants,
		raw_registers, // full rsx::method_registers snapshot, capture level 5 only
		count,
	};

	struct packet_section
	{
		std::uint32_t offset = 0;
		std::uint32_t size = 0;
	};

	struct draw_packet_header
	{
		std::uint32_t magic = draw_packet_magic;
		std::uint32_t abi = draw_packet_abi;
		std::uint32_t byte_size = 0;
		packet_kind kind = packet_kind::draw;

		std::uint64_t sequence = 0;

		std::uint32_t primitive = 0;
		std::uint32_t draw_command = 0;
		std::uint32_t index_type = 0;
		std::uint32_t flags = 0;

		std::uint32_t first_vertex = 0;
		std::uint32_t vertex_count = 0;
		std::uint32_t index_count = 0;
		std::uint32_t instance_count = 1;

		std::uint32_t width = 0;
		std::uint32_t height = 0;
		std::uint32_t color_format = 0;
		std::uint32_t depth_format = 0;

		std::uint32_t color_target = 0;
		std::uint32_t antialias_mode = 0;
		std::uint32_t vertex_program_control = 0;
		std::uint32_t vertex_program_output_mask = 0;

		std::uint32_t vertex_program_entry = 0;
		std::uint32_t fragment_program_control = 0;
		std::uint32_t reserved0 = 0;
		std::uint32_t reserved1 = 0;

		std::array<packet_section, static_cast<std::size_t>(section_kind::count)> sections{};
	};

	static_assert(sizeof(packet_section) == 8);
	static_assert(sizeof(draw_packet_header) == 216);

	class draw_packet_builder
	{
	public:
		explicit draw_packet_builder(draw_packet_header header = {});

		[[nodiscard]] bool append(section_kind kind, std::span<const std::byte> data, std::uint32_t alignment = 16);
		[[nodiscard]] std::vector<std::byte> finish();
		[[nodiscard]] bool valid() const { return !m_failed; }

	private:
		draw_packet_header m_header;
		std::vector<std::byte> m_bytes;
		bool m_finished = false;
		bool m_failed = false;
	};

	class draw_packet_view
	{
	public:
		explicit draw_packet_view(std::span<const std::byte> bytes);

		[[nodiscard]] bool valid() const;
		[[nodiscard]] const draw_packet_header* header() const;
		[[nodiscard]] std::span<const std::byte> section(section_kind kind) const;

	private:
		std::span<const std::byte> m_bytes;
		const draw_packet_header* m_header = nullptr;
	};
}
