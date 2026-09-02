#include "stdafx.h"
#include "WebGPURenderTargets.h"
#include "Emu/RSX/rsx_utils.h"
#include "Emu/system_config.h"

namespace rsx::webgpu
{
	namespace
	{
		u64 g_frame_id = 1;

		surface_op make_op(surface_op_kind kind, u32 id)
		{
			surface_op op{};
			op.kind = static_cast<u32>(kind);
			op.id = id;
			return op;
		}
	}

	u64 current_frame_id()
	{
		return g_frame_id;
	}

	void set_current_frame_id(u64 id)
	{
		g_frame_id = id;
	}

	// VKGSRender::get_compatible_surface_format groups guest formats by host image format
	u32 host_surface_format_of(rsx::surface_color_format format)
	{
		switch (format)
		{
		case rsx::surface_color_format::r5g6b5: return host_format_b5g6r5;
		case rsx::surface_color_format::x1r5g5b5_o1r5g5b5:
		case rsx::surface_color_format::x1r5g5b5_z1r5g5b5: return host_format_a1r5g5b5;
		case rsx::surface_color_format::a8r8g8b8:
		case rsx::surface_color_format::x8r8g8b8_o8r8g8b8:
		case rsx::surface_color_format::x8r8g8b8_z8r8g8b8: return host_format_bgra8;
		case rsx::surface_color_format::a8b8g8r8:
		case rsx::surface_color_format::x8b8g8r8_o8b8g8r8:
		case rsx::surface_color_format::x8b8g8r8_z8b8g8r8: return host_format_rgba8;
		case rsx::surface_color_format::b8: return host_format_r8;
		case rsx::surface_color_format::g8b8: return host_format_rg8;
		case rsx::surface_color_format::w16z16y16x16: return host_format_rgba16f;
		case rsx::surface_color_format::w32z32y32x32: return host_format_rgba32f;
		case rsx::surface_color_format::x32: return host_format_r32f;
		default:
			fmt::throw_exception("Unsupported RSX surface color format 0x%x", static_cast<u32>(format));
		}
	}

	u32 host_surface_format_of(rsx::surface_depth_format2 format)
	{
		switch (format)
		{
		case rsx::surface_depth_format2::z16_uint:
		case rsx::surface_depth_format2::z16_float: return host_format_d16;
		case rsx::surface_depth_format2::z24s8_uint:
		case rsx::surface_depth_format2::z24s8_float: return host_format_d24s8;
		default:
			fmt::throw_exception("Unsupported RSX surface depth format 0x%x", static_cast<u32>(format));
		}
	}

	render_target::render_target(surface_command_list& cmd, bool is_depth, u32 host_fmt, u32 w, u32 h)
		: m_ops(&cmd)
	{
		id = cmd.next_id++;
		image_width = w;
		image_height = h;
		depth = is_depth;
		host_format = host_fmt;

		auto op = make_op(surface_op_kind::create, id);
		op.is_depth = is_depth ? 1u : 0u;
		op.host_format = host_fmt;
		op.image_width = w;
		op.image_height = h;
		cmd.ops.push_back(op);
	}

	render_target::~render_target()
	{
		if (!old_contents.empty())
		{
			// The descriptor's destructor logs this too; release the references it holds
			clear_rw_barrier();
		}

		m_ops->ops.push_back(make_op(surface_op_kind::destroy, id));
	}

	bool render_target::matches_dimensions(u16 w, u16 h) const
	{
		// Use forward scaling to account for rounding and clamping errors
		const auto [scaled_w, scaled_h] = rsx::apply_resolution_scale<true>(resolution_scaling_config, w, h);
		return (scaled_w == width()) && (scaled_h == height());
	}

	void render_target::emit_describe(surface_command_list& cmd) const
	{
		auto op = make_op(surface_op_kind::describe, id);
		op.is_depth = depth ? 1u : 0u;
		op.host_format = host_format;
		op.image_width = image_width;
		op.image_height = image_height;
		op.surface_width = surface_width;
		op.surface_height = surface_height;
		op.samples_x = samples_x;
		op.samples_y = samples_y;
		op.address = base_addr;
		op.pitch = rsx_pitch;
		op.rsx_format = depth ? static_cast<u32>(format_info.gcm_depth_format) : static_cast<u32>(format_info.gcm_color_format);
		cmd.ops.push_back(op);
	}

	void render_target::clear_memory(surface_command_list& cmd)
	{
		// vk::render_target::clear_memory: color (0, 0, 0, 1), depth 1.0, stencil 255
		cmd.ops.push_back(make_op(surface_op_kind::erase, id));
		state_flags &= ~rsx::surface_state_flags::erase_bkgnd;
	}

	void render_target::load_memory(surface_command_list& cmd)
	{
		// Guest memory is loaded into the image by the browser (rsx::subresource_layout of the
		// whole surface, as vk::render_target::load_memory uploads it).
		cmd.ops.push_back(make_op(surface_op_kind::load_memory, id));
		state_flags &= ~(rsx::surface_state_flags::erase_bkgnd | rsx::surface_state_flags::force_data_load);
	}

	void render_target::initialize_memory(surface_command_list& cmd)
	{
		const bool read_buffers_config = is_depth_surface() ?
			!!g_cfg.video.read_depth_buffer :
			!!g_cfg.video.read_color_buffers;

		const bool should_read_buffers = (state_flags & rsx::surface_state_flags::force_data_load) || read_buffers_config;

		if (!should_read_buffers)
		{
			clear_memory(cmd);
			msaa_flags = rsx::surface_state_flags::ready;
		}
		else
		{
			load_memory(cmd);
		}
	}

	void render_target::memory_barrier(surface_command_list& cmd, rsx::surface_access access)
	{
		if (access == rsx::surface_access::gpu_reference)
		{
			// This barrier only requires that an object is made available for GPU usage.
			return;
		}

		const bool is_depth = is_depth_surface();
		const bool read_buffers_config = is_depth ? !!g_cfg.video.read_depth_buffer : !!g_cfg.video.read_color_buffers;
		const bool should_read_buffers = (state_flags & rsx::surface_state_flags::force_data_load) || read_buffers_config;

		if (should_read_buffers)
		{
			if (last_use_tag && state_flags == rsx::surface_state_flags::ready && !test())
			{
				state_flags |= rsx::surface_state_flags::erase_bkgnd;
			}
		}

		if (old_contents.empty()) [[likely]]
		{
			if (state_flags & rsx::surface_state_flags::erase_bkgnd)
			{
				initialize_memory(cmd);
				ensure(state_flags == rsx::surface_state_flags::ready);
				on_write(rsx::get_shared_tag(), static_cast<rsx::surface_state_flags>(msaa_flags));
			}

			return;
		}

		// Memory transfers
		const unsigned first = prepare_rw_barrier_for_transfer(this);
		const bool accept_all = (last_use_tag && test());

		bool optimize_copy = true;
		u64 newest_tag = 0;

		for (auto i = first; i < old_contents.size(); ++i)
		{
			auto& section = old_contents[i];
			auto src_texture = static_cast<render_target*>(section.source);
			src_texture->memory_barrier(cmd, rsx::surface_access::transfer_read);

			if (!accept_all && !src_texture->test()) [[likely]]
			{
				// If this surface is intact, accept all incoming data as it is guaranteed to be safe
				// If this surface has not been initialized or is dirty, do not add more dirty data to it
				continue;
			}

			section.init_transfer(this);
			const auto src_area = section.src_rect();
			const auto dst_area = section.dst_rect();

			bool memory_load = true;
			if (dst_area.x1 == 0 && dst_area.y1 == 0 &&
				unsigned(dst_area.x2) == width() && unsigned(dst_area.y2) == height())
			{
				// Skip a bunch of useless work
				state_flags &= ~(rsx::surface_state_flags::erase_bkgnd);
				msaa_flags = rsx::surface_state_flags::ready;
				memory_load = false;
				stencil_init_flags = src_texture->stencil_init_flags;
			}
			else if (state_flags & rsx::surface_state_flags::erase_bkgnd)
			{
				initialize_memory(cmd);
				ensure(state_flags == rsx::surface_state_flags::ready);
			}

			// vk::blitter::scale_image with interpolate=false (nearest); a source of another
			// format class is a typeless transfer the browser reinterprets
			auto op = make_op(surface_op_kind::copy_scaled, id);
			op.src_id = src_texture->id;
			op.src_x1 = src_area.x1; op.src_y1 = src_area.y1; op.src_x2 = src_area.x2; op.src_y2 = src_area.y2;
			op.dst_x1 = dst_area.x1; op.dst_y1 = dst_area.y1; op.dst_x2 = dst_area.x2; op.dst_y2 = dst_area.y2;
			op.filter_linear = 0;
			op.is_depth = depth ? 1u : 0u;
			op.host_format = host_format;
			op.rsx_format = (src_texture->depth != depth || src_texture->host_format != host_format) ? 1u : 0u; // typeless
			cmd.ops.push_back(op);

			optimize_copy = optimize_copy && !memory_load;
			newest_tag = src_texture->last_use_tag;
		}

		if (!newest_tag) [[unlikely]]
		{
			// Underlying memory has been modified and we could not find valid data to fill it
			clear_rw_barrier();
			state_flags |= rsx::surface_state_flags::erase_bkgnd;
			initialize_memory(cmd);
			ensure(state_flags == rsx::surface_state_flags::ready);
		}

		on_write_copy(newest_tag, optimize_copy);
	}

	std::unique_ptr<render_target> surface_cache_traits::create_new_surface(
		surface_command_list& cmd, u32 address, rsx::surface_color_format format,
		usz width, usz height, usz pitch, rsx::surface_antialiasing antialias,
		const rsx::surface_scaling_config_t& resolution_scaling_config)
	{
		// msaa_level::none: one sample per image, guest sample factors only in the metrics
		const auto [width_, height_] = rsx::apply_resolution_scale<true>(resolution_scaling_config, static_cast<u16>(width), static_cast<u16>(height));
		auto rtt = std::make_unique<render_target>(cmd, false, host_surface_format_of(format), width_, height_);
		rtt->set_format(format);
		rtt->set_aa_mode(antialias);
		rtt->set_resolution_scaling_config(resolution_scaling_config);
		rtt->sample_layout = rsx::surface_sample_layout::null;
		rtt->memory_usage_flags = rsx::surface_usage_flags::attachment;
		rtt->state_flags = rsx::surface_state_flags::erase_bkgnd;
		rtt->rsx_pitch = static_cast<u32>(pitch);
		rtt->native_pitch = static_cast<u32>(width) * get_format_block_size_in_bytes(format) * rtt->samples_x;
		rtt->surface_width = static_cast<u16>(width);
		rtt->surface_height = static_cast<u16>(height);
		rtt->queue_tag(address);
		rtt->add_ref();
		rtt->emit_describe(cmd);
		return rtt;
	}

	std::unique_ptr<render_target> surface_cache_traits::create_new_surface(
		surface_command_list& cmd, u32 address, rsx::surface_depth_format2 format,
		usz width, usz height, usz pitch, rsx::surface_antialiasing antialias,
		const rsx::surface_scaling_config_t& resolution_scaling_config)
	{
		const auto [width_, height_] = rsx::apply_resolution_scale<true>(resolution_scaling_config, static_cast<u16>(width), static_cast<u16>(height));
		auto ds = std::make_unique<render_target>(cmd, true, host_surface_format_of(format), width_, height_);
		ds->set_format(format);
		ds->set_aa_mode(antialias);
		ds->set_resolution_scaling_config(resolution_scaling_config);
		ds->sample_layout = rsx::surface_sample_layout::null;
		ds->memory_usage_flags = rsx::surface_usage_flags::attachment;
		ds->state_flags = rsx::surface_state_flags::erase_bkgnd;
		ds->native_pitch = static_cast<u32>(width) * get_format_block_size_in_bytes(format) * ds->samples_x;
		ds->rsx_pitch = static_cast<u32>(pitch);
		ds->surface_width = static_cast<u16>(width);
		ds->surface_height = static_cast<u16>(height);
		ds->queue_tag(address);
		ds->add_ref();
		ds->emit_describe(cmd);
		return ds;
	}

	void surface_cache_traits::clone_surface(
		surface_command_list& cmd, std::unique_ptr<render_target>& sink, render_target* ref,
		u32 address, barrier_descriptor_t& prev, const rsx::surface_scaling_config_t& scaling_config)
	{
		if (!sink)
		{
			const auto [new_w, new_h] = rsx::apply_resolution_scale<true>(
				scaling_config,
				prev.width, prev.height,
				ref->get_surface_width<rsx::surface_metrics::pixels>(), ref->get_surface_height<rsx::surface_metrics::pixels>());

			sink = std::make_unique<render_target>(cmd, ref->depth, ref->host_format, new_w, new_h);
			sink->add_ref();
			sink->sample_layout = ref->sample_layout;
			sink->resolution_scaling_config = scaling_config;
			sink->set_aa_mode(ref->get_aa_mode());
			sink->format_info = ref->format_info;
			sink->memory_usage_flags = rsx::surface_usage_flags::storage;
			sink->state_flags = rsx::surface_state_flags::erase_bkgnd;
			sink->stencil_init_flags = ref->stencil_init_flags;
			sink->native_pitch = static_cast<u32>(prev.width) * ref->get_bpp() * ref->samples_x;
			sink->rsx_pitch = ref->get_rsx_pitch();
			sink->surface_width = prev.width;
			sink->surface_height = prev.height;
			sink->queue_tag(address);
			sink->emit_describe(cmd);
		}

		sink->on_clone_from(ref);

		if (!sink->old_contents.empty())
		{
			// Deal with this, likely only needs to clear
			if (sink->surface_width > prev.width || sink->surface_height > prev.height)
			{
				sink->write_barrier(cmd);
			}
			else
			{
				sink->clear_rw_barrier();
			}
		}

		prev.target = sink.get();
		sink->set_old_contents_region(prev, false);
	}

	static void int_invalidate_surface_contents(surface_command_list& cmd, render_target* surface, u32 address, usz pitch)
	{
		surface->rsx_pitch = static_cast<u32>(pitch);
		surface->queue_tag(address);
		surface->last_use_tag = 0;
		surface->stencil_init_flags = 0;
		surface->memory_usage_flags = rsx::surface_usage_flags::unknown;
		surface->raster_type = rsx::surface_raster_type::linear;
		surface->emit_describe(cmd);
	}

	void surface_cache_traits::invalidate_surface_contents(surface_command_list& cmd, render_target* surface, rsx::surface_color_format format, u32 address, usz pitch)
	{
		surface->set_format(format);
		surface->host_format = host_surface_format_of(format);
		int_invalidate_surface_contents(cmd, surface, address, pitch);
	}

	void surface_cache_traits::invalidate_surface_contents(surface_command_list& cmd, render_target* surface, rsx::surface_depth_format2 format, u32 address, usz pitch)
	{
		surface->set_format(format);
		surface->host_format = host_surface_format_of(format);
		int_invalidate_surface_contents(cmd, surface, address, pitch);
	}

	void surface_cache_traits::write_render_target_to_memory(surface_command_list&, dma_buffer*, render_target* surface, u64, u64, u64)
	{
		rsx_log.error("WebGPU surface cache: render target 0x%x readback into guest memory is not implemented", surface->base_addr);
	}

	void surface_cache::destroy()
	{
		invalidate_all();
		invalidated_resources.clear();
	}

	void surface_cache::trim(surface_command_list& cmd, rsx::problem_severity memory_pressure)
	{
		run_cleanup_internal(cmd, rsx::problem_severity::moderate, 256, [](surface_command_list&) {});

		const u64 current_frame = current_frame_id();
		for (auto& rtt : invalidated_resources)
		{
			ensure(rtt->frame_tag != 0);

			if (rtt->has_refs())
			{
				// Actively in use, likely for a reading pass.
				continue;
			}

			if (rtt->frame_tag >= current_frame)
			{
				// RTT itself still in use by the frame.
				continue;
			}

			if (!rtt->old_contents.empty())
			{
				rtt->clear_rw_barrier();
			}

			int threshold = 8;
			switch (memory_pressure)
			{
			case rsx::problem_severity::low:
				threshold = 2;
				break;
			case rsx::problem_severity::moderate:
				threshold = 1;
				break;
			case rsx::problem_severity::severe:
			case rsx::problem_severity::fatal:
				// We're almost dead anyway. Remove forcefully.
				threshold = -1;
				break;
			default:
				fmt::throw_exception("Unreachable");
			}

			if (threshold < 0 || (rtt->unused_check_count() >= threshold))
			{
				rtt.reset();
			}
		}

		invalidated_resources.remove_if([](auto& rtt) { return !rtt; });
	}
}
