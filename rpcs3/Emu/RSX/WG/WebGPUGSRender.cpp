#include "stdafx.h"

#include "WebGPUGSRender.h"

#include "WebGPUHost.h"
#include "Emu/RSX/Common/BufferUtils.h"
#include "Emu/RSX/Common/TextureUtils.h"
#include "Emu/RSX/Common/surface_store.h"
#include "Emu/RSX/Program/ProgramStateCache.h"
#include "Emu/RSX/color_utils.h"
#include "Emu/RSX/rsx_methods.h"
#include "Emu/RSX/rsx_utils.h"
#include "Emu/Memory/vm.h"

#include <array>
#include <cstring>
#include <limits>
#include <span>
#include <variant>
#include <vector>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wold-style-cast"
#define XXH_INLINE_ALL
#include <common/xxhash.h>
#pragma clang diagnostic pop

namespace
{
	using byte_vector = std::vector<std::byte>;

	bool webgpu_native_primitive(rsx::primitive_type primitive)
	{
		switch (primitive)
		{
		case rsx::primitive_type::points:
		case rsx::primitive_type::lines:
		case rsx::primitive_type::line_strip:
		case rsx::primitive_type::triangles:
		case rsx::primitive_type::triangle_strip:
		case rsx::primitive_type::quad_strip:
			return true;
		default:
			return false;
		}
	}

	// Byte offsets of the inline-constant slots of a fragment program relative
	// to its first instruction, in instruction order. This is the walk
	// fragment_program_utils::analyse_fragment_program performs, using its
	// is_any_src_constant rule, and matches the order the browser translator
	// assigns constant indices in.
	std::vector<u32> fragment_constant_offsets(const void* ucode, u32 ucode_length)
	{
		std::vector<u32> offsets;
		const auto* bytes = static_cast<const u8*>(ucode);
		for (u32 offset = 0; offset + 16 <= ucode_length;)
		{
			const v128 inst = v128::loadu(bytes + offset);
			const bool end = (inst._u32[0] >> 8) & 0x1;
			if (program_hash_util::fragment_program_utils::is_any_src_constant(inst))
			{
				offsets.push_back(offset + 16);
				offset += 32;
			}
			else
			{
				offset += 16;
			}
			if (end) break;
		}
		return offsets;
	}

	struct vertex_upload
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
		byte_vector indices;
	};

	struct texture_source
	{
		rsx::webgpu::texture_packet_record record;
		u32 address = 0;
		u32 payload_size = 0;
	};

	struct texture_capture
	{
		byte_vector bytes;
		std::vector<rsx::webgpu::texture_packet_record> additions;
		bool complete = true;
	};

	constexpr usz align_up(usz value, usz alignment)
	{
		return (value + alignment - 1) & ~(alignment - 1);
	}

	template <rsx::Texture Texture>
	void collect_texture(std::vector<texture_source>& sources, bool& complete,
		const Texture& texture, u32 stage, u32 slot)
	{
		// A referenced but disabled sampler deliberately reads the backend's null
		// texture and therefore has no guest-memory payload to transfer.
		if (!texture.enabled())
		{
			return;
		}

		rsx::webgpu::texture_packet_record record{};
		record.stage = stage;
		record.slot = slot;
		record.format = texture.format();
		record.width = texture.width();
		record.height = texture.height();
		record.depth = texture.depth();
		record.pitch = texture.pitch();
		record.mip_count = texture.get_exact_mipmap_count();
		record.dimension = static_cast<u32>(texture.get_extended_texture_dimension());
		record.remap = texture.decoded_remap().encoded;
		record.address_modes = static_cast<u32>(texture.wrap_s()) |
			(static_cast<u32>(texture.wrap_t()) << 8) |
			(static_cast<u32>(texture.wrap_r()) << 16);
		u32 texel_controls = 0;
		if constexpr (requires { texture.format_ex(); })
		{
			texel_controls = texture.format_ex().texel_remap_control;
		}
		record.filter_modes = static_cast<u32>(texture.min_filter()) |
			(static_cast<u32>(texture.mag_filter()) << 8) |
			((texel_controls & 0xffff) << 16);

		const usz size = rsx::get_texture_size(texture);
		const u32 address = rsx::get_address(texture.offset(), texture.location());
		record.address = address;
		if (!size || size > std::numeric_limits<u32>::max() ||
			static_cast<u64>(address) + size > 0x1'0000'0000ull ||
			!vm::check_addr(address, vm::page_readable, static_cast<u32>(size)))
		{
			// Keep the descriptor in the packet even when its bytes cannot be
			// captured. This makes the pending flag diagnosable by the host.
			complete = false;
			sources.push_back({record, address});
			return;
		}

		record.data_size = static_cast<u32>(size);
		sources.push_back({record, address});
	}

	bool copy_guest_bytes(std::span<std::byte> destination, u32 address)
	{
		usz copied = 0;
		while (copied < destination.size())
		{
			const u32 current = address + static_cast<u32>(copied);
			const usz chunk = std::min<usz>(destination.size() - copied, 0x1000 - (current & 0xfff));
			const void* source = vm::base(current);
			if (!source)
			{
				return false;
			}
			std::memcpy(destination.data() + copied, source, chunk);
			copied += chunk;
		}
		return true;
	}

	bool hash_guest_bytes(u32 address, u32 size, u32& result)
	{
		XXH32_state_t hash{};
		XXH32_reset(&hash, 0);
		usz hashed = 0;
		while (hashed < size)
		{
			const u32 current = address + static_cast<u32>(hashed);
			const usz chunk = std::min<usz>(size - hashed, 0x1000 - (current & 0xfff));
			const auto* source = static_cast<const std::byte*>(vm::base(current));
			if (!source)
			{
				return false;
			}
			XXH32_update(&hash, source, chunk);
			hashed += chunk;
		}
		result = XXH32_digest(&hash);
		return true;
	}

	bool same_texture(const rsx::webgpu::texture_packet_record& lhs,
		const rsx::webgpu::texture_packet_record& rhs)
	{
		return lhs.stage == rhs.stage && lhs.slot == rhs.slot && lhs.address == rhs.address &&
			lhs.format == rhs.format && lhs.width == rhs.width && lhs.height == rhs.height &&
			lhs.depth == rhs.depth && lhs.pitch == rhs.pitch && lhs.mip_count == rhs.mip_count &&
			lhs.dimension == rhs.dimension && lhs.data_size == rhs.data_size &&
			lhs.content_hash == rhs.content_hash && lhs.remap == rhs.remap &&
			lhs.address_modes == rhs.address_modes && lhs.filter_modes == rhs.filter_modes;
	}

	texture_capture capture_textures(u32 fragment_mask, u32 vertex_mask,
		const std::vector<rsx::webgpu::texture_packet_record>& frame_cache)
	{
		std::vector<texture_source> sources;
		bool complete = true;

		for (u32 refs = fragment_mask, slot = 0; refs; refs >>= 1, ++slot)
		{
			if (refs & 1)
			{
				collect_texture(sources, complete, rsx::method_registers.fragment_textures[slot], 0, slot);
			}
		}
		for (u32 refs = vertex_mask, slot = 0; refs; refs >>= 1, ++slot)
		{
			if (refs & 1)
			{
				collect_texture(sources, complete, rsx::method_registers.vertex_textures[slot], 1, slot);
			}
		}

		texture_capture result;
		usz total_size = sources.size() * sizeof(rsx::webgpu::texture_packet_record);
		for (auto& source : sources)
		{
			if (!source.record.data_size ||
				!hash_guest_bytes(source.address, source.record.data_size, source.record.content_hash))
			{
				return {{}, {}, false};
			}

			const auto is_match = [&](const auto& entry)
			{
				return same_texture(entry, source.record);
			};
			const bool cached = std::any_of(frame_cache.begin(), frame_cache.end(), is_match) ||
				std::any_of(result.additions.begin(), result.additions.end(), is_match);
			source.payload_size = cached ? 0 : source.record.data_size;
			if (!cached)
			{
				result.additions.push_back(source.record);
			}

			total_size = align_up(total_size, 16);
			if (total_size > std::numeric_limits<u32>::max() - source.payload_size)
			{
				return {{}, {}, false};
			}
			total_size += source.payload_size;
		}

		result.complete = complete;
		result.bytes.resize(total_size);
		usz data_offset = sources.size() * sizeof(rsx::webgpu::texture_packet_record);
		for (usz index = 0; index < sources.size(); ++index)
		{
			auto& source = sources[index];
			data_offset = align_up(data_offset, 16);
			source.record.data_offset = static_cast<u32>(data_offset);
			source.record.data_size = source.payload_size;
			const std::span texture_bytes{result.bytes.data() + data_offset, source.payload_size};
			if (source.payload_size && !copy_guest_bytes(texture_bytes, source.address))
			{
				result.complete = false;
				result.bytes.clear();
				return result;
			}
			std::memcpy(result.bytes.data() + index * sizeof(source.record), &source.record, sizeof(source.record));
			data_offset += source.payload_size;
		}

		return result;
	}

	vertex_upload prepare_vertex_upload(const rsx::vertex_input_layout& layout,
		const std::variant<rsx::draw_array_command, rsx::draw_indexed_array_command, rsx::draw_inlined_array>& command)
	{
		vertex_upload result{};
		auto& clause = rsx::method_registers.current_draw_clause;
		const bool expand = !webgpu_native_primitive(clause.primitive);
		result.primitive_expanded = expand;

		std::visit([&](const auto& draw)
		{
			using type = std::decay_t<decltype(draw)>;
			if constexpr (std::is_same_v<type, rsx::draw_array_command>)
			{
				result.first_vertex = clause.min_index();
				result.allocated_vertex_count = clause.get_elements_count();
				result.draw_count = result.allocated_vertex_count;
				if (expand)
				{
					result.indexed = true;
					result.index_type = rsx::index_array_type::u16;
					result.draw_count = get_index_count(clause.primitive, result.draw_count);
					result.indices.resize(result.draw_count * sizeof(u16));
					write_index_array_for_non_indexed_non_native_primitive_to_buffer(
						reinterpret_cast<char*>(result.indices.data()), clause.primitive,
						result.allocated_vertex_count);
				}
			}
			else if constexpr (std::is_same_v<type, rsx::draw_indexed_array_command>)
			{
				result.indexed = true;
				result.index_type = clause.is_immediate_draw
					? rsx::index_array_type::u32
					: rsx::method_registers.index_type();
				const u32 index_size = get_index_type_size(result.index_type);
				const u32 capacity = get_index_count(clause.primitive, clause.get_elements_count());
				result.indices.resize(capacity * index_size);

				auto [minimum, maximum, written] = write_index_array_data_to_buffer(
					result.indices, draw.raw_index_buffer, result.index_type, clause.primitive,
					rsx::method_registers.restart_index_enabled(), rsx::method_registers.restart_index(),
					[](rsx::primitive_type primitive) { return !webgpu_native_primitive(primitive); });

				if (written == 0 || minimum > maximum)
				{
					result.indices.clear();
					return;
				}

				result.indices.resize(written * index_size);
				// WebGPU applies restart semantics to every indexed strip draw;
				// report when the stream actually contains the sentinel so the
				// browser can refuse a draw where the guest did not enable restart.
				result.index_restart_sentinel = maximum == (index_size == 2 ? 0xffffu : 0xffffffffu);
				result.first_vertex = rsx::get_index_from_base(minimum, rsx::method_registers.vertex_data_base_index());
				result.allocated_vertex_count = maximum - minimum + 1;
				result.draw_count = written;
				result.vertex_index_base = minimum;
				result.vertex_index_offset = rsx::method_registers.vertex_data_base_index();
			}
			else
			{
				if (layout.interleaved_blocks.empty() || layout.interleaved_blocks[0]->attribute_stride == 0)
				{
					return;
				}
				result.allocated_vertex_count = static_cast<u32>(
					clause.inline_vertex_array.size() * sizeof(u32) /
					layout.interleaved_blocks[0]->attribute_stride);
				result.draw_count = result.allocated_vertex_count;
				if (expand)
				{
					result.indexed = true;
					result.index_type = rsx::index_array_type::u16;
					result.draw_count = get_index_count(clause.primitive, result.draw_count);
					result.indices.resize(result.draw_count * sizeof(u16));
					write_index_array_for_non_indexed_non_native_primitive_to_buffer(
						reinterpret_cast<char*>(result.indices.data()), clause.primitive,
						result.allocated_vertex_count);
				}
			}
		}, command);

		return result;
	}
}

u64 WebGPUGSRender::get_cycles()
{
	return thread_ctrl::get_cycles(static_cast<named_thread<WebGPUGSRender>&>(*this));
}

WebGPUGSRender::WebGPUGSRender(utils::serial* ar) noexcept
	: GSRender(ar)
{
	backend_config.supports_normalized_barycentrics = true;
	backend_config.supports_hw_instanced_rendering = false;
	backend_config.supports_multidraw = false;
	backend_config.supports_hw_conditional_render = false;
	backend_config.supports_last_provoking_vertex = false;
}

void WebGPUGSRender::begin()
{
	rsx::thread::begin();
	if (skip_current_frame || cond_render_ctrl.disable_rendering())
	{
		return;
	}

	// Common RPCS3 framebuffer validation supplies the true dimensions,
	// attachment formats and guest addresses.
	get_framebuffer_layout(rsx::framebuffer_creation_context::context_draw, m_framebuffer_layout);
}

void WebGPUGSRender::end()
{
	if (skip_current_frame || !m_graphics_state.test(rsx::rtt_config_valid) || cond_render_ctrl.disable_rendering())
	{
		execute_nop_draw();
		rsx::thread::end();
		return;
	}

	analyse_current_rsx_pipeline();

	// Texture cache population is the next backend layer. Program state for an
	// untextured draw is complete here; textured packets explicitly say pending.
	if (!current_fp_metadata.referenced_textures_mask)
	{
		get_current_fragment_program(fs_sampler_state);
	}
	if (!current_vp_metadata.referenced_textures_mask)
	{
		get_current_vertex_program(vs_sampler_state);
	}

	auto& clause = rsx::method_registers.current_draw_clause;
	clause.begin();
	u32 subdraw = 0;
	do
	{
		(void)emit_draw_packet(subdraw++);
	}
	while (clause.next());

	rsx::thread::end();
}

bool WebGPUGSRender::emit_draw_packet(u32 subdraw)
{
	if (rsx::webgpu::packet_capture_level() < 2)
	{
		return true;
	}

	auto& clause = rsx::method_registers.current_draw_clause;
	const auto state = subdraw == 0
		? rsx::flags32_t{rsx::vertex_arrays_changed}
		: rsx::flags32_t{clause.execute_pipeline_dependencies(m_ctx)};

	if (state & rsx::vertex_arrays_changed)
	{
		m_draw_processor.analyse_inputs_interleaved(m_vertex_layout, current_vp_metadata);
	}
	else if (state & rsx::vertex_base_changed)
	{
		for (auto* block : m_vertex_layout.interleaved_blocks)
		{
			block->vertex_range.second = 0;
			block->real_offset_address = rsx::get_address(
				rsx::get_vertex_offset_from_base(rsx::method_registers.vertex_data_base_offset(), block->base_offset),
				block->memory_location);
		}
	}

	if (!m_vertex_layout.validate())
	{
		return false;
	}

	const auto command = m_draw_processor.get_draw_command(rsx::method_registers);
	const auto upload = prepare_vertex_upload(m_vertex_layout, command);
	if (!upload.draw_count || !upload.allocated_vertex_count)
	{
		return false;
	}

	const auto requirements = calculate_memory_requirements(
		m_vertex_layout, upload.first_vertex, upload.allocated_vertex_count);
	byte_vector persistent(requirements.first);
	byte_vector transient(requirements.second);
	m_draw_processor.write_vertex_data_to_memory(
		m_vertex_layout, upload.first_vertex, upload.allocated_vertex_count,
		persistent.empty() ? nullptr : persistent.data(),
		transient.empty() ? nullptr : transient.data());

	std::array<std::byte, 144> layout{};
	auto* layout_words = reinterpret_cast<u32*>(layout.data());
	layout_words[0] = upload.vertex_index_base;
	layout_words[1] = upload.vertex_index_offset;
	m_draw_processor.fill_vertex_layout_state(
		m_vertex_layout, current_vp_metadata, upload.first_vertex,
		upload.allocated_vertex_count, reinterpret_cast<s32*>(layout_words + 4), 0, 0);

	std::array<std::byte, 96> vertex_environment{};
	m_draw_processor.fill_scale_offset_data(vertex_environment.data(), false);
	m_draw_processor.fill_user_clip_data(vertex_environment.data() + 64);
	*reinterpret_cast<u32*>(vertex_environment.data() + 68) = rsx::method_registers.transform_branch_bits();
	*reinterpret_cast<f32*>(vertex_environment.data() + 72) =
		rsx::method_registers.point_size() * resolution_scaling_config.scale_factor();
	*reinterpret_cast<f32*>(vertex_environment.data() + 76) = rsx::method_registers.clip_min();
	*reinterpret_cast<f32*>(vertex_environment.data() + 80) = rsx::method_registers.clip_max();

	std::array<std::byte, 32> fragment_environment{};
	m_draw_processor.fill_fragment_state_buffer(fragment_environment.data(), current_fragment_program);

	(void)get_scissor(m_scissor, true);
	const rsx::webgpu::raster_environment_packet raster_environment{
		.scissor_x = m_scissor.x1,
		.scissor_y = m_scissor.y1,
		.scissor_width = m_scissor.width(),
		.scissor_height = m_scissor.height(),
	};

	std::array<std::byte, 468 * 16> vertex_constants{};
	m_draw_processor.fill_vertex_program_constants_data(vertex_constants.data(), {});
	const u32 capture_level = rsx::webgpu::packet_capture_level();
	auto textures = capture_level >= 4
		? capture_textures(current_fp_metadata.referenced_textures_mask, current_vp_metadata.referenced_textures_mask, m_frame_textures)
		: texture_capture{};

	rsx::webgpu::draw_packet_header header{};
	header.sequence = ++m_sequence;
	header.primitive = static_cast<u32>(clause.primitive);
	header.draw_command = static_cast<u32>(clause.command);
	header.index_type = static_cast<u32>(upload.index_type);
	header.flags = (upload.indexed ? rsx::webgpu::packet_indexed : 0u) |
		(upload.primitive_expanded ? rsx::webgpu::packet_primitive_expanded : 0u) |
		(current_fp_metadata.referenced_textures_mask ? rsx::webgpu::packet_uses_fragment_textures : 0u) |
		(current_vp_metadata.referenced_textures_mask ? rsx::webgpu::packet_uses_vertex_textures : 0u) |
		((capture_level < 4 && (current_fp_metadata.referenced_textures_mask || current_vp_metadata.referenced_textures_mask)) || !textures.complete
			? rsx::webgpu::packet_texture_payload_pending : 0u);
	// Primitive restart under the same conditions VKGSRender's
	// decode_vertex_input_assembly_state enables it: indexed, non-disjoint,
	// native primitive (expanded index streams already resolved restart).
	if (rsx::method_registers.restart_index_enabled() && !clause.is_disjoint_primitive &&
		clause.command == rsx::draw_command::indexed && !upload.primitive_expanded)
	{
		header.flags |= rsx::webgpu::packet_primitive_restart;
	}
	if (upload.index_restart_sentinel)
	{
		header.flags |= rsx::webgpu::packet_index_restart_sentinel;
	}
	header.first_vertex = upload.first_vertex;
	header.vertex_count = upload.allocated_vertex_count;
	header.index_count = upload.indexed ? upload.draw_count : 0;
	header.width = m_framebuffer_layout.width;
	header.height = m_framebuffer_layout.height;
	header.color_format = static_cast<u32>(m_framebuffer_layout.color_format);
	header.depth_format = static_cast<u32>(m_framebuffer_layout.depth_format);
	header.color_target = static_cast<u32>(m_framebuffer_layout.target);
	header.antialias_mode = static_cast<u32>(m_framebuffer_layout.aa_mode);
	header.vertex_program_control = current_vertex_program.ctrl;
	header.vertex_program_output_mask = rsx::method_registers.vertex_attrib_output_mask();
	header.vertex_program_entry = current_vertex_program.entry;
	// Texture descriptor materialization normally finalizes these fields in
	// get_current_fragment_program(). The WebGPU transport captures guest
	// textures directly, so preserve the guest's export/depth control even when
	// no native sampled-image descriptor was created.
	header.fragment_program_control = rsx::method_registers.shader_control();
	header.reserved0 = upload.draw_count;
	header.reserved1 = subdraw;

	rsx::webgpu::resolved_state_packet resolved{};
	fill_resolved_state(resolved, 0);

	rsx::webgpu::draw_packet_builder packet(header);
	bool packet_ok = packet.append(rsx::webgpu::section_kind::resolved_state,
		std::as_bytes(std::span{&resolved, 1}));
	if (rsx::webgpu::packet_capture_level() >= 5)
	{
		packet_ok = packet.append(rsx::webgpu::section_kind::raw_registers,
			std::as_bytes(std::span(rsx::method_registers.registers))) && packet_ok;
	}
	packet_ok = packet.append(rsx::webgpu::section_kind::vertex_program,
		std::as_bytes(std::span(current_vertex_program.data))) && packet_ok;
	if (current_fragment_program.get_data() && current_fragment_program.ucode_length)
	{
		packet_ok = packet.append(rsx::webgpu::section_kind::fragment_program,
			{static_cast<const std::byte*>(current_fragment_program.get_data()), current_fragment_program.ucode_length}) && packet_ok;

		// Inline constants as RPCS3 uploads them to its own fragment constant
		// buffers, so the browser binds a uniform instead of baking literals.
		const auto constant_offsets = fragment_constant_offsets(
			current_fragment_program.get_data(), current_fragment_program.ucode_length);
		if (!constant_offsets.empty())
		{
			std::vector<f32> fragment_constants(constant_offsets.size() * 4);
			rsx::write_fragment_constants_to_buffer(fragment_constants, current_fragment_program, constant_offsets, false);
			packet_ok = packet.append(rsx::webgpu::section_kind::fragment_constants,
				std::as_bytes(std::span(fragment_constants))) && packet_ok;
		}
	}
	packet_ok = packet.append(rsx::webgpu::section_kind::vertex_constants, vertex_constants) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::vertex_layout, layout) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::vertex_environment, vertex_environment) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::fragment_environment, fragment_environment) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::persistent_vertices, persistent, 256) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::volatile_vertices, transient, 256) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::indices, upload.indices, 4) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::textures, textures.bytes, 16) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::raster_environment,
		std::as_bytes(std::span{&raster_environment, 1})) && packet_ok;

	if (!packet_ok || !rsx::webgpu::host_command_queue().push(packet.finish()))
	{
		return false;
	}

	m_frame_textures.insert(m_frame_textures.end(), textures.additions.begin(), textures.additions.end());
	return true;
}

void WebGPUGSRender::emit_control_packet(rsx::webgpu::packet_kind kind, u32 value, u32 flags)
{
	if (rsx::webgpu::packet_capture_level() == 0)
	{
		return;
	}

	rsx::webgpu::draw_packet_header header{};
	header.sequence = ++m_sequence;
	header.kind = kind;
	header.flags = flags;
	header.reserved0 = value;
	header.width = m_framebuffer_layout.width;
	header.height = m_framebuffer_layout.height;
	header.color_format = static_cast<u32>(m_framebuffer_layout.color_format);
	header.depth_format = static_cast<u32>(m_framebuffer_layout.depth_format);

	rsx::webgpu::resolved_state_packet resolved{};
	fill_resolved_state(resolved, kind == rsx::webgpu::packet_kind::clear ? value : 0);

	rsx::webgpu::draw_packet_builder packet(header);
	bool packet_ok = packet.append(rsx::webgpu::section_kind::resolved_state,
		std::as_bytes(std::span{&resolved, 1}));
	if (rsx::webgpu::packet_capture_level() >= 5)
	{
		packet_ok = packet.append(rsx::webgpu::section_kind::raw_registers,
			std::as_bytes(std::span(rsx::method_registers.registers))) && packet_ok;
	}
	if (packet_ok)
	{
		(void)rsx::webgpu::host_command_queue().push(packet.finish());
	}
}

// Resolve the render state the browser consumes through the same
// rsx::method_registers accessors and surface-format helpers that
// VKGSRender::decode_rsx_state and VKGSRender::clear_surface use, so the
// packet never re-derives guest register semantics.
void WebGPUGSRender::fill_resolved_state(rsx::webgpu::resolved_state_packet& state, u32 clear_mask) const
{
	const auto& regs = rsx::method_registers;
	const auto surface_color = regs.surface_color();
	const auto surface_depth = regs.surface_depth_fmt();
	const u32 draw_buffer_count = static_cast<u32>(rsx::utility::get_rtt_indexes(m_framebuffer_layout.target).size());

	state.surface_color_format = static_cast<u32>(surface_color);
	state.surface_depth_format = static_cast<u32>(surface_depth);
	state.draw_buffer_count = draw_buffer_count;

	// Clear values (VKGSRender::clear_surface)
	u32 mask = clear_mask;
	if (!regs.stencil_mask()) mask &= ~RSX_GCM_CLEAR_STENCIL_BIT;

	if (mask & RSX_GCM_CLEAR_DEPTH_STENCIL_MASK)
	{
		if (mask & RSX_GCM_CLEAR_DEPTH_BIT)
		{
			const u32 max_depth_value = get_max_depth_value(surface_depth);
			const u32 clear_depth = regs.z_clear_value(is_depth_stencil_format(surface_depth));
			state.clear_depth = static_cast<f32>(clear_depth) / max_depth_value;
		}

		if (is_depth_stencil_format(surface_depth))
		{
			if (mask & RSX_GCM_CLEAR_STENCIL_BIT)
			{
				state.clear_stencil = regs.stencil_clear_value();
			}
		}
		else
		{
			mask &= ~RSX_GCM_CLEAR_STENCIL_BIT;
		}
	}

	if (u32 colormask = (mask & RSX_GCM_CLEAR_COLOR_RGBA_MASK))
	{
		u8 clear_a = regs.clear_color_a();
		u8 clear_r = regs.clear_color_r();
		u8 clear_g = regs.clear_color_g();
		u8 clear_b = regs.clear_color_b();

		switch (surface_color)
		{
		case rsx::surface_color_format::x32:
		case rsx::surface_color_format::w16z16y16x16:
		case rsx::surface_color_format::w32z32y32x32:
		{
			colormask = 0;
			break;
		}
		case rsx::surface_color_format::b8:
		{
			rsx::get_b8_clear_color(clear_r, clear_g, clear_b, clear_a);
			colormask = rsx::get_b8_clearmask(colormask);
			break;
		}
		case rsx::surface_color_format::g8b8:
		{
			rsx::get_g8b8_clear_color(clear_r, clear_g, clear_b, clear_a);
			colormask = rsx::get_g8b8_r8g8_clearmask(colormask);
			break;
		}
		case rsx::surface_color_format::r5g6b5:
		{
			rsx::get_rgb565_clear_color(clear_r, clear_g, clear_b, clear_a);
			break;
		}
		case rsx::surface_color_format::x1r5g5b5_o1r5g5b5:
		{
			rsx::get_a1rgb555_clear_color(clear_r, clear_g, clear_b, clear_a, 255);
			break;
		}
		case rsx::surface_color_format::x1r5g5b5_z1r5g5b5:
		{
			rsx::get_a1rgb555_clear_color(clear_r, clear_g, clear_b, clear_a, 0);
			break;
		}
		case rsx::surface_color_format::a8b8g8r8:
		case rsx::surface_color_format::x8b8g8r8_o8b8g8r8:
		case rsx::surface_color_format::x8b8g8r8_z8b8g8r8:
		{
			rsx::get_abgr8_clear_color(clear_r, clear_g, clear_b, clear_a);
			colormask = rsx::get_abgr8_clearmask(colormask);
			break;
		}
		default:
		{
			break;
		}
		}

		mask = (mask & ~RSX_GCM_CLEAR_COLOR_RGBA_MASK) | colormask;
		state.clear_color[0] = static_cast<f32>(clear_r) / 255;
		state.clear_color[1] = static_cast<f32>(clear_g) / 255;
		state.clear_color[2] = static_cast<f32>(clear_b) / 255;
		state.clear_color[3] = static_cast<f32>(clear_a) / 255;
	}

	state.clear_mask = mask;

	// Depth (VKGSRender::decode_rsx_state)
	state.depth_test_enabled = regs.depth_test_enabled();
	state.depth_write_enabled = regs.depth_write_enabled();
	state.depth_func = static_cast<u32>(regs.depth_func());
	state.depth_clamp_enabled = regs.depth_clamp_enabled();
	state.depth_clip_enabled = regs.depth_clip_enabled();
	state.depth_bounds_test_enabled = regs.depth_bounds_test_enabled();
	state.depth_bounds_min = regs.depth_bounds_min();
	state.depth_bounds_max = regs.depth_bounds_max();

	// Stencil
	state.stencil_test_enabled = regs.stencil_test_enabled();
	state.two_sided_stencil_test_enabled = regs.two_sided_stencil_test_enabled();
	state.stencil_func = static_cast<u32>(regs.stencil_func());
	state.stencil_op_fail = static_cast<u32>(regs.stencil_op_fail());
	state.stencil_op_zfail = static_cast<u32>(regs.stencil_op_zfail());
	state.stencil_op_zpass = static_cast<u32>(regs.stencil_op_zpass());
	state.stencil_func_ref = regs.stencil_func_ref();
	state.stencil_func_mask = regs.stencil_func_mask();
	state.stencil_mask = regs.stencil_mask();
	state.back_stencil_func = static_cast<u32>(regs.back_stencil_func());
	state.back_stencil_op_fail = static_cast<u32>(regs.back_stencil_op_fail());
	state.back_stencil_op_zfail = static_cast<u32>(regs.back_stencil_op_zfail());
	state.back_stencil_op_zpass = static_cast<u32>(regs.back_stencil_op_zpass());
	state.back_stencil_func_ref = regs.back_stencil_func_ref();
	state.back_stencil_func_mask = regs.back_stencil_func_mask();
	state.back_stencil_mask = regs.back_stencil_mask();

	// Color output. LogicOp and blend are mutually exclusive; logic op wins.
	state.logic_op_enabled = regs.logic_op_enabled();
	state.logic_operation = static_cast<u32>(regs.logic_operation());
	state.blend_enabled_mask =
		(regs.blend_enabled() ? 1u : 0u) |
		(regs.blend_enabled_surface_1() ? 2u : 0u) |
		(regs.blend_enabled_surface_2() ? 4u : 0u) |
		(regs.blend_enabled_surface_3() ? 8u : 0u);
	state.blend_sfactor_rgb = static_cast<u32>(regs.blend_func_sfactor_rgb());
	state.blend_sfactor_a = static_cast<u32>(regs.blend_func_sfactor_a());
	state.blend_dfactor_rgb = static_cast<u32>(regs.blend_func_dfactor_rgb());
	state.blend_dfactor_a = static_cast<u32>(regs.blend_func_dfactor_a());
	state.blend_equation_rgb = static_cast<u32>(regs.blend_equation_rgb());
	state.blend_equation_a = static_cast<u32>(regs.blend_equation_a());
	const auto blend_colors = rsx::get_constant_blend_colors();
	for (u32 i = 0; i < 4; ++i) state.blend_color[i] = blend_colors[i];

	const auto host_write_mask = rsx::get_write_output_mask(surface_color);
	for (u32 index = 0; index < 4; ++index)
	{
		if (index >= draw_buffer_count)
		{
			state.color_write_mask[index] = 0;
			continue;
		}

		bool color_mask_b = regs.color_mask_b(index);
		bool color_mask_g = regs.color_mask_g(index);
		bool color_mask_r = regs.color_mask_r(index);
		bool color_mask_a = regs.color_mask_a(index);

		switch (surface_color)
		{
		case rsx::surface_color_format::b8:
			rsx::get_b8_colormask(color_mask_r, color_mask_g, color_mask_b, color_mask_a);
			break;
		case rsx::surface_color_format::g8b8:
			rsx::get_g8b8_r8g8_colormask(color_mask_r, color_mask_g, color_mask_b, color_mask_a);
			break;
		default:
			break;
		}

		state.color_write_mask[index] =
			((color_mask_r && host_write_mask[0]) ? 1u : 0u) |
			((color_mask_g && host_write_mask[1]) ? 2u : 0u) |
			((color_mask_b && host_write_mask[2]) ? 4u : 0u) |
			((color_mask_a && host_write_mask[3]) ? 8u : 0u);
	}

	state.alpha_test_enabled = regs.alpha_test_enabled();
	state.alpha_func = static_cast<u32>(regs.alpha_func());
	state.alpha_ref = regs.alpha_ref();

	// Raster
	state.cull_face_enabled = regs.cull_face_enabled();
	state.cull_face_mode = static_cast<u32>(regs.cull_face_mode());
	state.front_face_mode = static_cast<u32>(regs.front_face_mode());
	state.line_width = regs.line_width();
	state.poly_offset_fill_enabled = regs.poly_offset_fill_enabled();
	state.poly_offset_scale = regs.poly_offset_scale();
	state.poly_offset_bias = regs.poly_offset_bias();
	state.shader_control = regs.shader_control();
}

void WebGPUGSRender::clear_surface(u32 mask)
{
	if (skip_current_frame || !(mask & RSX_GCM_CLEAR_ANY_MASK))
	{
		return;
	}

	u8 context = rsx::framebuffer_creation_context::context_draw;
	if (mask & RSX_GCM_CLEAR_COLOR_RGBA_MASK) context |= rsx::framebuffer_creation_context::context_clear_color;
	if (mask & RSX_GCM_CLEAR_DEPTH_STENCIL_MASK) context |= rsx::framebuffer_creation_context::context_clear_depth;
	get_framebuffer_layout(static_cast<rsx::framebuffer_creation_context>(context), m_framebuffer_layout);
	if (m_graphics_state.test(rsx::rtt_config_valid))
	{
		emit_control_packet(rsx::webgpu::packet_kind::clear, mask);
	}
}

void WebGPUGSRender::flip(const rsx::display_flip_info_t& info)
{
	const u32 flags = info.skip_frame ? rsx::webgpu::packet_skipped : 0u;
	emit_control_packet(rsx::webgpu::packet_kind::flip, info.buffer, flags);
	m_frame_textures.clear();
	if (m_frame)
	{
		m_frame->flip(m_context, info.skip_frame);
	}
	rsx::thread::flip(info);
}
