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
#include "Emu/system_config.h"

#include <array>
#include <list>
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
			(static_cast<u32>(texture.wrap_r()) << 16) |
			(static_cast<u32>(texture.border_type()) << 24); // CELL_GCM_TEXTURE_BORDER_TEXTURE (0) carries border texels in the data
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

	// Guest textures are hashed once per frame by default: RPCS3's native texture cache
	// invalidates on guest writes through page protection, which Wasm32 cannot provide, and
	// re-hashing every referenced texture for every draw (thousands per frame in
	// LittleBigPlanet 2's pod) costs more than the draws themselves. Conformance lanes can
	// request per-draw hashing to observe mid-frame CPU writes.
	std::atomic<bool> g_texture_hash_per_draw{false};

	// Residency key: every field the renderer keys its texture cache on (rpcs3-webgpu-renderer.mjs
	// textureCacheKey), i.e. the descriptor without stage, slot and payload placement.
	u64 texture_residency_key(const rsx::webgpu::texture_packet_record& record)
	{
		const u32 fields[] = { record.address, record.format, record.width, record.height, record.depth, record.pitch,
			record.mip_count, record.dimension, record.content_hash, record.remap, record.address_modes, record.filter_modes };
		return XXH64(fields, sizeof(fields), 0);
	}

	texture_capture capture_textures(u32 fragment_mask, u32 vertex_mask,
		WebGPUGSRender::texture_residency& residency, shared_mutex& residency_mutex,
		std::unordered_map<u64, u32>& frame_hashes)
	{
		std::lock_guard residency_lock(residency_mutex);
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
		std::vector<rsx::webgpu::texture_packet_record> evictions;
		std::vector<u64> referenced;
		usz payload_total = 0;
		for (auto& source : sources)
		{
			if (!source.record.data_size)
			{
				return {{}, {}, false};
			}
			const u64 hash_key = (static_cast<u64>(source.address) << 32) | source.record.data_size;
			if (const auto found = g_texture_hash_per_draw ? frame_hashes.end() : frame_hashes.find(hash_key); found != frame_hashes.end())
			{
				source.record.content_hash = found->second;
			}
			else if (!hash_guest_bytes(source.address, source.record.data_size, source.record.content_hash))
			{
				return {{}, {}, false};
			}
			else
			{
				frame_hashes[hash_key] = source.record.content_hash;
			}
			const u64 key = texture_residency_key(source.record);
			referenced.push_back(key);
			if (const auto found = residency.entries.find(key); found != residency.entries.end())
			{
				// Resident: reference only, refresh recency
				residency.lru.splice(residency.lru.begin(), residency.lru, found->second.lru);
				source.payload_size = 0;
				continue;
			}
			source.payload_size = source.record.data_size;
			if (payload_total > std::numeric_limits<u32>::max() - source.payload_size - 16)
			{
				return {{}, {}, false};
			}
			payload_total = align_up(payload_total, 16) + source.payload_size;
			residency.lru.push_front(key);
			residency.entries.emplace(key, WebGPUGSRender::texture_residency::entry{ source.record, source.record.data_size, residency.lru.begin() });
			residency.bytes += source.record.data_size;
			result.additions.push_back(source.record);
		}
		// Evict least recently used textures (never one this draw references) until under budget
		for (auto it = residency.lru.rbegin(); residency.bytes > residency.budget && it != residency.lru.rend();)
		{
			const u64 key = *it;
			if (std::find(referenced.begin(), referenced.end(), key) != referenced.end())
			{
				++it;
				continue;
			}
			auto& entry = residency.entries.at(key);
			rsx::webgpu::texture_packet_record record = entry.record;
			record.stage = 2; // evict
			record.slot = 0;
			record.data_offset = 0;
			record.data_size = 0;
			evictions.push_back(record);
			residency.bytes -= entry.bytes;
			it = std::list<u64>::reverse_iterator(residency.lru.erase(std::next(it).base()));
			residency.entries.erase(key);
		}
		result.complete = complete;
		const usz record_count = evictions.size() + sources.size();
		usz data_offset = record_count * sizeof(rsx::webgpu::texture_packet_record);
		result.bytes.resize(align_up(data_offset, 16) + payload_total);
		for (usz index = 0; index < evictions.size(); ++index)
		{
			// The host sizes the record table from the first record's data offset
			evictions[index].data_offset = static_cast<u32>(record_count * sizeof(rsx::webgpu::texture_packet_record));
			std::memcpy(result.bytes.data() + index * sizeof(rsx::webgpu::texture_packet_record), &evictions[index], sizeof(rsx::webgpu::texture_packet_record));
		}
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
			std::memcpy(result.bytes.data() + (evictions.size() + index) * sizeof(source.record), &source.record, sizeof(source.record));
			data_offset += source.payload_size;
		}
		result.bytes.resize(data_offset);
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

void rsx_webgpu_set_texture_hash_per_draw(bool enabled)
{
	g_texture_hash_per_draw = enabled;
}

void WebGPUGSRender::forget_texture_keys(const std::vector<u64>& keys)
{
	std::lock_guard lock(m_texture_residency_mutex);
	for (const u64 key : keys)
	{
		const auto found = m_texture_residency.entries.find(key);
		if (found == m_texture_residency.entries.end())
		{
			continue;
		}
		m_texture_residency.bytes -= found->second.bytes;
		m_texture_residency.lru.erase(found->second.lru);
		m_texture_residency.entries.erase(found);
	}
}

void WebGPUGSRender::forget_texture(const rsx::webgpu::texture_packet_record& key)
{
	forget_texture_keys({texture_residency_key(key)});
}

void WebGPUGSRender::on_packet_popped(bool delivered)
{
	std::vector<u64> keys;
	{
		std::lock_guard lock(m_texture_residency_mutex);
		if (m_queued_packet_textures.empty())
		{
			return;
		}
		keys = std::move(m_queued_packet_textures.front());
		m_queued_packet_textures.pop_front();
	}
	if (!delivered && !keys.empty())
	{
		forget_texture_keys(keys);
	}
}

static void rsx_webgpu_packet_pop_hook(bool delivered)
{
	if (auto* render = dynamic_cast<WebGPUGSRender*>(g_fxo->try_get<rsx::thread>()))
	{
		render->on_packet_popped(delivered);
	}
}

u64 WebGPUGSRender::get_cycles()
{
	return thread_ctrl::get_cycles(static_cast<named_thread<WebGPUGSRender>&>(*this));
}

static void rsx_webgpu_packet_pop_hook(bool delivered);

WebGPUGSRender::WebGPUGSRender(utils::serial* ar) noexcept
	: GSRender(ar)
{
	rsx::webgpu::host_command_queue().set_pop_hook(&rsx_webgpu_packet_pop_hook);
	backend_config.supports_normalized_barycentrics = true;
	backend_config.supports_hw_instanced_rendering = false;
	backend_config.supports_multidraw = false;
	backend_config.supports_hw_conditional_render = false;
	backend_config.supports_last_provoking_vertex = false;
}

static rsx::webgpu::framebuffer_packet framebuffer_from_layout(const rsx::framebuffer_layout& layout,
	const rsx::webgpu::surface_cache& rtts, u32 scale_percent)
{
	rsx::webgpu::framebuffer_packet fb{};
	for (u32 i = 0; i < 4; i++)
	{
		fb.color_addresses[i] = layout.color_addresses[i];
		fb.color_pitches[i] = layout.color_pitch[i];
		fb.color_write_mask |= layout.color_write_enabled[i] ? (1u << i) : 0u;
		if (const auto& bound = rtts.m_bound_render_targets[i]; bound.second && bound.first == layout.color_addresses[i])
		{
			fb.color_surface_ids[i] = bound.second->id;
		}
	}
	if (const auto& bound = rtts.m_bound_depth_stencil; bound.second && bound.first == layout.zeta_address)
	{
		fb.zeta_surface_id = bound.second->id;
	}
	fb.scale_percent = scale_percent;
	fb.zeta_address = layout.zeta_address;
	fb.zeta_pitch = layout.zeta_pitch;
	fb.zeta_write_enabled = layout.zeta_write_enabled ? 1u : 0u;
	fb.aa_factor_x = layout.aa_factors[0];
	fb.aa_factor_y = layout.aa_factors[1];
	fb.raster_type = static_cast<u32>(layout.raster_type);
	return fb;
}

void WebGPUGSRender::begin()
{
	rsx::thread::begin();
	if (skip_current_frame || cond_render_ctrl.disable_rendering())
	{
		return;
	}

	// Common RPCS3 framebuffer validation supplies the true dimensions,
	// attachment formats and guest addresses; the surface store binds them.
	prepare_rtts(rsx::framebuffer_creation_context::context_draw);
}

void WebGPUGSRender::prepare_rtts(rsx::framebuffer_creation_context context)
{
	if (m_current_framebuffer_context == context && !m_graphics_state.test(rsx::rtt_config_dirty) && m_rtts_bound)
	{
		return;
	}

	m_graphics_state.clear(
		rsx::rtt_config_dirty |
		rsx::rtt_config_contested |
		rsx::rtt_config_valid |
		rsx::rtt_cache_state_dirty);

	get_framebuffer_layout(context, m_framebuffer_layout);
	if (!m_graphics_state.test(rsx::rtt_config_valid))
	{
		return;
	}

	if (m_rtts_bound && m_framebuffer_layout.ignore_change)
	{
		return;
	}

	m_rtts.prepare_render_target(m_surface_ops,
		m_framebuffer_layout.color_format, m_framebuffer_layout.depth_format,
		m_framebuffer_layout.width, m_framebuffer_layout.height,
		m_framebuffer_layout.target, m_framebuffer_layout.aa_mode, m_framebuffer_layout.raster_type,
		m_framebuffer_layout.color_addresses, m_framebuffer_layout.zeta_address,
		m_framebuffer_layout.actual_color_pitch, m_framebuffer_layout.actual_zeta_pitch,
		resolution_scaling_config);

	// No texture cache yet: nothing to discard or lock for superseded/orphaned surfaces
	m_rtts.superseded_surfaces.clear();
	m_rtts.orphaned_surfaces.clear();

	m_current_framebuffer_context = context;
	m_rtts_bound = true;
}

void WebGPUGSRender::read_barrier_sampled_surfaces()
{
	for (u32 i = 0; i < rsx::limits::fragment_textures_count; ++i)
	{
		if (!(current_fp_metadata.referenced_textures_mask & (1u << i)))
		{
			continue;
		}

		const auto& tex = rsx::method_registers.fragment_textures[i];
		if (!tex.enabled())
		{
			continue;
		}

		const u32 address = rsx::get_address(tex.offset(), tex.location());
		const u32 length = std::max<u32>(get_texture_size(tex), 1);
		m_rtts.for_each_overlapping(rsx::address_range32::start_length(address, length), [&](rsx::webgpu::render_target* surface)
		{
			surface->read_barrier(m_surface_ops);
		});
	}
}

void WebGPUGSRender::on_init_thread()
{
	GSRender::on_init_thread();
	// The Vulkan backend's texture cache and surface accessors consume rsx::get_shared_tag()
	// values during initialization, so the surface store's first bind (cache_tag) is newer than
	// its initial write_tag and the first clear's on_write is recorded. Consume the same way.
	(void)rsx::get_shared_tag();
	(void)rsx::get_shared_tag();
}

void WebGPUGSRender::on_exit()
{
	m_rtts.destroy();
	m_surface_ops.ops.clear();
	GSRender::on_exit();
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

	// Apply write memory barriers (VKGSRender::end), then the read barriers of sampled surfaces
	if (auto ds = std::get<1>(m_rtts.m_bound_depth_stencil))
	{
		ds->write_barrier(m_surface_ops);
	}
	for (auto& rtt : m_rtts.m_bound_render_targets)
	{
		if (auto surface = std::get<1>(rtt))
		{
			surface->write_barrier(m_surface_ops);
		}
	}
	read_barrier_sampled_surfaces();

	auto& clause = rsx::method_registers.current_draw_clause;
	clause.begin();
	u32 subdraw = 0;
	do
	{
		(void)emit_draw_packet(subdraw++);
	}
	while (clause.next());

	m_rtts.on_write(m_framebuffer_layout.color_write_enabled, m_framebuffer_layout.zeta_write_enabled);
	rsx::thread::end();
}

bool WebGPUGSRender::emit_draw_packet(u32 subdraw)
{
	if (rsx::webgpu::packet_capture_level() < 2)
	{
		m_surface_ops.ops.clear();
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
		? capture_textures(current_fp_metadata.referenced_textures_mask, current_vp_metadata.referenced_textures_mask, m_texture_residency, m_texture_residency_mutex, m_frame_texture_hashes)
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
	const rsx::webgpu::framebuffer_packet framebuffer = framebuffer_from_layout(m_framebuffer_layout, m_rtts, resolution_scaling_config.scale_percent);
	packet_ok = packet.append(rsx::webgpu::section_kind::framebuffer, std::as_bytes(std::span{&framebuffer, 1})) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::surface_ops, std::as_bytes(std::span(m_surface_ops.ops))) && packet_ok;

	std::vector<u64> payload_keys;
	payload_keys.reserve(textures.additions.size());
	for (const auto& record : textures.additions)
	{
		payload_keys.push_back(texture_residency_key(record));
	}

	if (!packet_ok || !rsx::webgpu::host_command_queue().push(packet.finish()))
	{
		// The renderer never sees this packet's payloads
		forget_texture_keys(payload_keys);
		return false;
	}

	{
		std::lock_guard lock(m_texture_residency_mutex);
		m_queued_packet_textures.push_back(std::move(payload_keys));
	}

	m_surface_ops.ops.clear();
	return true;
}

void WebGPUGSRender::emit_control_packet(rsx::webgpu::packet_kind kind, u32 value, u32 flags)
{
	if (rsx::webgpu::packet_capture_level() == 0)
	{
		m_surface_ops.ops.clear();
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
	header.color_target = static_cast<u32>(m_framebuffer_layout.target);
	header.antialias_mode = static_cast<u32>(m_framebuffer_layout.aa_mode);

	rsx::webgpu::resolved_state_packet resolved{};
	fill_resolved_state(resolved, kind == rsx::webgpu::packet_kind::clear ? value : 0);
	if (kind == rsx::webgpu::packet_kind::clear)
	{
		// VKGSRender::clear_surface initializes the aspect a partial depth-stencil clear leaves untouched
		if (m_clear_initialize_depth)
		{
			resolved.clear_mask |= RSX_GCM_CLEAR_DEPTH_BIT;
			resolved.clear_depth = 1.f;
		}
		if (m_clear_initialize_stencil)
		{
			resolved.clear_mask |= RSX_GCM_CLEAR_STENCIL_BIT;
			resolved.clear_stencil = 0xff;
		}
		m_clear_initialize_depth = m_clear_initialize_stencil = false;
	}

	rsx::webgpu::draw_packet_builder packet(header);
	bool packet_ok = packet.append(rsx::webgpu::section_kind::resolved_state,
		std::as_bytes(std::span{&resolved, 1}));
	if (rsx::webgpu::packet_capture_level() >= 5)
	{
		packet_ok = packet.append(rsx::webgpu::section_kind::raw_registers,
			std::as_bytes(std::span(rsx::method_registers.registers))) && packet_ok;
	}
	if (kind == rsx::webgpu::packet_kind::clear)
	{
		// RPCS3 clears within the resolved scissor (VKGSRender::clear_surface
		// clips the clear rectangle to m_scissor); ship it like a draw does.
		(void)get_scissor(m_scissor, true);
		const rsx::webgpu::raster_environment_packet raster_environment{
			.scissor_x = m_scissor.x1,
			.scissor_y = m_scissor.y1,
			.scissor_width = m_scissor.width(),
			.scissor_height = m_scissor.height(),
		};
		packet_ok = packet.append(rsx::webgpu::section_kind::raster_environment,
			std::as_bytes(std::span{&raster_environment, 1})) && packet_ok;
	}
	rsx::webgpu::framebuffer_packet framebuffer = framebuffer_from_layout(m_framebuffer_layout, m_rtts, resolution_scaling_config.scale_percent);
	if (kind == rsx::webgpu::packet_kind::flip && value < display_buffers_count)
	{
		const auto& buffer = display_buffers[value];
		framebuffer.display_buffer = value;
		framebuffer.color_addresses[0] = rsx::get_address(buffer.offset, CELL_GCM_LOCATION_LOCAL);
		framebuffer.color_pitches[0] = buffer.pitch;
		header.width = buffer.width;
		header.height = buffer.height;
		// The display buffer RSX rendered lives in the surface store; make its contents current
		if (auto surface = m_rtts.get_surface_at(framebuffer.color_addresses[0]))
		{
			surface->read_barrier(m_surface_ops);
			framebuffer.display_surface_id = surface->id;
		}
	}
	packet_ok = packet.append(rsx::webgpu::section_kind::framebuffer, std::as_bytes(std::span{&framebuffer, 1})) && packet_ok;
	packet_ok = packet.append(rsx::webgpu::section_kind::surface_ops, std::as_bytes(std::span(m_surface_ops.ops))) && packet_ok;
	if (packet_ok && rsx::webgpu::host_command_queue().push(packet.finish()))
	{
		std::lock_guard lock(m_texture_residency_mutex);
		m_queued_packet_textures.emplace_back();
		m_surface_ops.ops.clear();
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
	prepare_rtts(static_cast<rsx::framebuffer_creation_context>(context));
	if (!m_graphics_state.test(rsx::rtt_config_valid))
	{
		return;
	}

	// VKGSRender::clear_surface: memory barriers and write tags of the surfaces being cleared
	(void)get_scissor(m_scissor, true);
	const auto [fb_width, fb_height] = rsx::apply_resolution_scale<true>(resolution_scaling_config, m_framebuffer_layout.width, m_framebuffer_layout.height);
	u16 scissor_x = static_cast<u16>(m_scissor.x1);
	u16 scissor_w = static_cast<u16>(m_scissor.width());
	u16 scissor_y = static_cast<u16>(m_scissor.y1);
	u16 scissor_h = static_cast<u16>(m_scissor.height());
	std::tie(scissor_x, scissor_y, scissor_w, scissor_h) = rsx::clip_region<u16>(fb_width, fb_height, scissor_x, scissor_y, scissor_w, scissor_h, false);
	const bool full_frame = (scissor_w == fb_width && scissor_h == fb_height);

	bool update_color = false, update_z = false;
	const auto surface_depth_format = rsx::method_registers.surface_depth_fmt();

	if (auto ds = std::get<1>(m_rtts.m_bound_depth_stencil); ds && (mask & RSX_GCM_CLEAR_DEPTH_STENCIL_MASK))
	{
		constexpr u32 depth_aspect = 1, stencil_aspect = 2;
		u32 depth_stencil_mask = 0;
		if (mask & RSX_GCM_CLEAR_DEPTH_BIT) depth_stencil_mask |= depth_aspect;
		const u32 aspect = is_depth_stencil_format(surface_depth_format) ? (depth_aspect | stencil_aspect) : depth_aspect;
		if (is_depth_stencil_format(surface_depth_format) && (mask & RSX_GCM_CLEAR_STENCIL_BIT)) depth_stencil_mask |= stencil_aspect;

		if ((depth_stencil_mask && depth_stencil_mask != aspect) || !full_frame)
		{
			// At least one aspect is not being cleared or the clear does not cover the full frame
			// Steps to initialize memory are required
			if (ds->state_flags & rsx::surface_state_flags::erase_bkgnd &&  // Needs initialization
				ds->old_contents.empty() && !g_cfg.video.read_depth_buffer) // No way to load data from memory, so no initialization given
			{
				// Only one aspect was cleared. Make sure to memory initialize the other before removing dirty flag
				const auto ds_mask = (mask & RSX_GCM_CLEAR_DEPTH_STENCIL_MASK);
				if (ds_mask == RSX_GCM_CLEAR_DEPTH_BIT && (aspect & stencil_aspect))
				{
					m_clear_initialize_stencil = true;
				}
				else if (ds_mask == RSX_GCM_CLEAR_STENCIL_BIT)
				{
					m_clear_initialize_depth = true;
				}
			}
			else
			{
				ds->write_barrier(m_surface_ops);
			}
		}

		update_z = true;
	}

	if (auto colormask = (mask & RSX_GCM_CLEAR_COLOR_RGBA_MASK))
	{
		if (!m_rtts.m_bound_render_target_ids.empty())
		{
			bool use_fast_clear = (colormask == RSX_GCM_CLEAR_COLOR_RGBA_MASK);
			switch (rsx::method_registers.surface_color())
			{
			case rsx::surface_color_format::x32:
			case rsx::surface_color_format::w16z16y16x16:
			case rsx::surface_color_format::w32z32y32x32:
				colormask = 0;
				break;
			case rsx::surface_color_format::b8:
				colormask = rsx::get_b8_clearmask(colormask);
				use_fast_clear = (colormask & RSX_GCM_CLEAR_RED_BIT);
				break;
			case rsx::surface_color_format::g8b8:
				colormask = rsx::get_g8b8_r8g8_clearmask(colormask);
				use_fast_clear = ((colormask & RSX_GCM_CLEAR_COLOR_RG_MASK) == RSX_GCM_CLEAR_COLOR_RG_MASK);
				break;
			case rsx::surface_color_format::r5g6b5:
				use_fast_clear = ((colormask & RSX_GCM_CLEAR_COLOR_RGB_MASK) == RSX_GCM_CLEAR_COLOR_RGB_MASK);
				break;
			case rsx::surface_color_format::a8b8g8r8:
			case rsx::surface_color_format::x8b8g8r8_o8b8g8r8:
			case rsx::surface_color_format::x8b8g8r8_z8b8g8r8:
				colormask = rsx::get_abgr8_clearmask(colormask);
				break;
			default:
				break;
			}

			if (colormask)
			{
				if (!use_fast_clear || !full_frame)
				{
					for (const auto& index : m_rtts.m_bound_render_target_ids)
					{
						m_rtts.m_bound_render_targets[index].second->write_barrier(m_surface_ops);
					}
				}

				update_color = true;
			}
		}
	}

	if (update_color || update_z)
	{
		m_rtts.on_write({ update_color, update_color, update_color, update_color }, update_z);
	}

	emit_control_packet(rsx::webgpu::packet_kind::clear, mask);
}

void WebGPUGSRender::flip(const rsx::display_flip_info_t& info)
{
	const u32 flags = info.skip_frame ? rsx::webgpu::packet_skipped : 0u;
	emit_control_packet(rsx::webgpu::packet_kind::flip, info.buffer, flags);
	m_frame_texture_hashes.clear();
	rsx::webgpu::set_current_frame_id(rsx::webgpu::current_frame_id() + 1);
	m_rtts.trim(m_surface_ops, rsx::problem_severity::low);
	if (m_frame)
	{
		m_frame->flip(m_context, info.skip_frame);
	}
	rsx::thread::flip(info);
}
