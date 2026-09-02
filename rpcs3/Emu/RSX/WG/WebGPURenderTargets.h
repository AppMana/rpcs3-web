#pragma once

// RPCS3's surface store (rsx::surface_store) driving browser-side WebGPU images.
//
// The store owns every render-target policy decision: reuse, replacement, memory
// inheritance between overlapping surfaces, splitting, antialiasing metrics and
// resolution scaling. This backend follows vk::surface_cache_traits with MSAA
// disabled (msaa_level::none: one sample per image, guest sample factors kept in
// the descriptor metrics). Everything the browser must do to its images is
// emitted as a surface_op in program order; the browser executes them verbatim
// before the packet that carries them.

#include "util/types.hpp"
#include "Emu/RSX/Common/surface_store.h"
#include "Emu/RSX/Common/TextureUtils.h"
#include "WebGPUCommand.h"

#include <memory>
#include <vector>

namespace rsx::webgpu
{
	struct surface_command_list
	{
		std::vector<surface_op> ops;
		std::uint32_t next_id = 1;
	};

	// Host image formats. A surface only reuses an image of the same host format, the
	// way vk::surface_cache_traits compares VkFormat.
	enum host_surface_format : u32
	{
		host_format_bgra8 = 1,     // a8r8g8b8, x8r8g8b8_*
		host_format_rgba8 = 2,     // a8b8g8r8, x8b8g8r8_*
		host_format_r8 = 3,        // b8
		host_format_rg8 = 4,       // g8b8
		host_format_rgba16f = 5,   // w16z16y16x16
		host_format_rgba32f = 6,   // w32z32y32x32
		host_format_r32f = 7,      // x32
		host_format_b5g6r5 = 8,    // r5g6b5
		host_format_a1r5g5b5 = 9,  // x1r5g5b5_*
		host_format_d16 = 0x101,   // z16
		host_format_d24s8 = 0x102, // z24s8
	};

	u32 host_surface_format_of(rsx::surface_color_format format);
	u32 host_surface_format_of(rsx::surface_depth_format2 format);

	// The browser-side image of a surface; ops name it by id.
	struct surface_image
	{
		u32 id = 0;
		u32 image_width = 0;
		u32 image_height = 0;

		virtual ~surface_image() = default;
		u32 width() const { return image_width; }
		u32 height() const { return image_height; }
	};

	u64 current_frame_id();
	void set_current_frame_id(u64 id);

	class render_target : public surface_image, public rsx::render_target_descriptor<surface_image*>
	{
	public:
		u64 frame_tag = 0;      // frame id when invalidated, 0 if not invalid
		bool is_bound = false;  // set when the surface is bound for rendering
		bool depth = false;
		u32 host_format = 0;

		render_target(surface_command_list& cmd, bool is_depth, u32 host_fmt, u32 w, u32 h);
		~render_target() override;

		surface_image* get_surface(rsx::surface_access) override { return this; }
		bool is_depth_surface() const override { return depth; }
		bool matches_dimensions(u16 w, u16 h) const;
		void reset_surface_counters() { frame_tag = 0; }

		// Emits the surface's guest placement so the browser can alias textures onto it.
		void emit_describe(surface_command_list& cmd) const;

		// vk::render_target::memory_barrier without MSAA resolve or memory spilling.
		void memory_barrier(surface_command_list& cmd, rsx::surface_access access);
		void read_barrier(surface_command_list& cmd) { memory_barrier(cmd, rsx::surface_access::shader_read); }
		void write_barrier(surface_command_list& cmd) { memory_barrier(cmd, rsx::surface_access::shader_write); }

	private:
		void initialize_memory(surface_command_list& cmd);
		void clear_memory(surface_command_list& cmd);
		void load_memory(surface_command_list& cmd);

		surface_command_list* m_ops;
	};

	// DMA buffers back the store's write_to_dma_buffers path; the browser never
	// reads surfaces back into guest memory, so these only satisfy the template.
	struct dma_buffer
	{
		u32 base_address = 0;
		u32 length = 0;
		u32 size() const { return length; }
	};

	struct surface_cache_traits
	{
		using surface_storage_type = std::unique_ptr<render_target>;
		using surface_type = render_target*;
		using buffer_object_storage_type = std::unique_ptr<dma_buffer>;
		using buffer_object_type = dma_buffer*;
		using command_list_type = surface_command_list&;
		using download_buffer_object = void*;
		using barrier_descriptor_t = rsx::deferred_clipped_region<render_target*>;

		static std::unique_ptr<render_target> create_new_surface(
			surface_command_list& cmd, u32 address, rsx::surface_color_format format,
			usz width, usz height, usz pitch, rsx::surface_antialiasing antialias,
			const rsx::surface_scaling_config_t& resolution_scaling_config);

		static std::unique_ptr<render_target> create_new_surface(
			surface_command_list& cmd, u32 address, rsx::surface_depth_format2 format,
			usz width, usz height, usz pitch, rsx::surface_antialiasing antialias,
			const rsx::surface_scaling_config_t& resolution_scaling_config);

		static void clone_surface(
			surface_command_list& cmd, std::unique_ptr<render_target>& sink, render_target* ref,
			u32 address, barrier_descriptor_t& prev, const rsx::surface_scaling_config_t& scaling_config);

		static std::unique_ptr<render_target> convert_pitch(surface_command_list&, std::unique_ptr<render_target>& src, usz)
		{
			// TODO (as in the Vulkan backend): pitch conversion is unimplemented
			src->state_flags = rsx::surface_state_flags::erase_bkgnd;
			return {};
		}

		static bool is_compatible_surface(const render_target* surface, const render_target* ref, u16 width, u16 height, u8 sample_count)
		{
			return (surface->host_format == ref->host_format &&
				surface->get_spp() == sample_count &&
				surface->get_surface_width() == width &&
				surface->get_surface_height() == height);
		}

		static void prepare_surface_for_drawing(surface_command_list& cmd, render_target* surface)
		{
			surface->memory_barrier(cmd, rsx::surface_access::gpu_reference);
			surface->reset_surface_counters();
			surface->memory_usage_flags |= rsx::surface_usage_flags::attachment;
			surface->is_bound = true;
		}

		static void prepare_surface_for_sampling(surface_command_list&, render_target* surface)
		{
			surface->is_bound = false;
		}

		static bool surface_is_pitch_compatible(const std::unique_ptr<render_target>& surface, usz pitch)
		{
			return surface->rsx_pitch == pitch;
		}

		static void invalidate_surface_contents(surface_command_list& cmd, render_target* surface, rsx::surface_color_format format, u32 address, usz pitch);
		static void invalidate_surface_contents(surface_command_list& cmd, render_target* surface, rsx::surface_depth_format2 format, u32 address, usz pitch);

		static void notify_surface_invalidated(const std::unique_ptr<render_target>& surface)
		{
			surface->frame_tag = current_frame_id();
			if (!surface->frame_tag) surface->frame_tag = 1;

			if (!surface->old_contents.empty())
			{
				// TODO: Retire the deferred writes
				surface->clear_rw_barrier();
			}

			surface->release();
		}

		static void notify_surface_persist(const std::unique_ptr<render_target>&) {}

		static void notify_surface_reused(const std::unique_ptr<render_target>& surface)
		{
			surface->state_flags |= rsx::surface_state_flags::erase_bkgnd;
			surface->add_ref();
		}

		static bool int_surface_matches_properties(
			const std::unique_ptr<render_target>& surface, u32 host_format, usz width, usz height,
			rsx::surface_antialiasing antialias, const rsx::surface_scaling_config_t& scaling_config, bool check_refs)
		{
			if (check_refs && surface->has_refs())
			{
				// Surface may still have read refs from data 'copy'
				return false;
			}

			return (surface->host_format == host_format &&
				surface->get_spp() == get_format_sample_count(antialias) &&
				surface->matches_dimensions(static_cast<u16>(width), static_cast<u16>(height))) &&
				surface->resolution_scaling_config == scaling_config;
		}

		static bool surface_matches_properties(
			const std::unique_ptr<render_target>& surface, rsx::surface_color_format format, usz width, usz height,
			rsx::surface_antialiasing antialias, const rsx::surface_scaling_config_t& scaling_config, bool check_refs = false)
		{
			return int_surface_matches_properties(surface, host_surface_format_of(format), width, height, antialias, scaling_config, check_refs);
		}

		static bool surface_matches_properties(
			const std::unique_ptr<render_target>& surface, rsx::surface_depth_format2 format, usz width, usz height,
			rsx::surface_antialiasing antialias, const rsx::surface_scaling_config_t& scaling_config, bool check_refs = false)
		{
			return int_surface_matches_properties(surface, host_surface_format_of(format), width, height, antialias, scaling_config, check_refs);
		}

		static void spill_buffer(std::unique_ptr<dma_buffer>&) {}
		static void unspill_buffer(std::unique_ptr<dma_buffer>&) {}

		static void write_render_target_to_memory(surface_command_list&, dma_buffer*, render_target*, u64, u64, u64);

		template <int BlockSize>
		static dma_buffer* merge_bo_list(surface_command_list&, std::vector<dma_buffer*>& list)
		{
			u32 required_bo_size = 0;
			for (auto& bo : list)
			{
				required_bo_size += (bo ? bo->size() : BlockSize);
			}
			auto dst = new dma_buffer();
			dst->length = required_bo_size;
			for (auto& bo : list)
			{
				delete bo;
			}
			return dst;
		}

		template <typename T>
		static T* get(const std::unique_ptr<T>& obj)
		{
			return obj.get();
		}
	};

	class surface_cache : public rsx::surface_store<surface_cache_traits>
	{
	public:
		void destroy();
		// vk::surface_cache::trim: retire invalidated surfaces nobody references anymore
		void trim(surface_command_list& cmd, rsx::problem_severity memory_pressure);

		// Surfaces whose guest memory overlaps the range (both storages)
		template <typename F>
		void for_each_overlapping(const rsx::address_range32& range, F&& callback)
		{
			if (m_render_targets_memory_range.valid() && range.overlaps(m_render_targets_memory_range))
			{
				for (auto it = m_render_targets_storage.begin_range(range); it != m_render_targets_storage.end(); ++it)
				{
					auto surface = surface_cache_traits::get(it->second);
					if (range.overlaps(surface->get_memory_range())) callback(surface);
				}
			}

			if (m_depth_stencil_memory_range.valid() && range.overlaps(m_depth_stencil_memory_range))
			{
				for (auto it = m_depth_stencil_storage.begin_range(range); it != m_depth_stencil_storage.end(); ++it)
				{
					auto surface = surface_cache_traits::get(it->second);
					if (range.overlaps(surface->get_memory_range())) callback(surface);
				}
			}
		}
	};
}
