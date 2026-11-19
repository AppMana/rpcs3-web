#include "stdafx.h"
#include "Emu/IdManager.h"
#include "Emu/Cell/PPUModule.h"
#include "Emu/Cell/lv2/sys_rsx.h"
#include "Emu/Host/HostPlatform.h"
#include "Emu/Memory/vm.h"
#include "Emu/RSX/GCM.h"
#include "Emu/RSX/RSXThread.h"
#include "Emu/RSX/gcm_enums.h"

#include "cellGcmSys.h"
#include "cellResc.h"
#include "cellVideoOut.h"

#include <algorithm>
#include <cmath>

LOG_CHANNEL(cellResc);

extern error_code cellGcmSetDisplayBuffer(u8 id, u32 offset, u32 pitch, u32 width, u32 height);
extern error_code cellGcmSetFlip(ppu_thread& ppu, vm::ptr<CellGcmContextData> ctxt, u32 id);
extern void cellGcmSetFlipHandler(vm::ptr<void(u32)> handler);
extern void cellGcmSetFlipMode(u32 mode);
extern void cellGcmResetFlipStatus();
extern u32 cellGcmGetFlipStatus();
extern u64 cellGcmGetLastFlipTime();
extern void cellGcmSetVBlankHandler(vm::ptr<void(u32)> handler);
extern void cellGcmSetWaitFlip(ppu_thread& ppu, vm::ptr<CellGcmContextData> ctxt);
extern error_code cellVideoOutConfigure(u32 videoOut, vm::ptr<CellVideoOutConfiguration> config, vm::ptr<CellVideoOutOption> option, u32 waitForEvent);

namespace rsx
{
	extern u32 make_command(vm::bptr<u32>& dst, u32 start_register, std::initializer_list<any32> values);
}

namespace
{
	int mode_to_slot(u32 buffer_mode) noexcept
	{
		switch (buffer_mode)
		{
		case CELL_RESC_720x480: return 0;
		case CELL_RESC_720x576: return 1;
		case CELL_RESC_1280x720: return 2;
		case CELL_RESC_1920x1080: return 3;
		default: return -1;
		}
	}

	std::pair<u32, u32> mode_dimensions(u32 buffer_mode) noexcept
	{
		switch (buffer_mode)
		{
		case CELL_RESC_720x480: return {720, 480};
		case CELL_RESC_720x576: return {720, 576};
		case CELL_RESC_1280x720: return {1280, 720};
		case CELL_RESC_1920x1080: return {1920, 1080};
		default: return {1280, 720};
		}
	}

	u8 mode_to_video_out_res_id(u32 buffer_mode) noexcept
	{
		switch (buffer_mode)
		{
		case CELL_RESC_720x480: return CELL_VIDEO_OUT_RESOLUTION_480;
		case CELL_RESC_720x576: return CELL_VIDEO_OUT_RESOLUTION_576;
		case CELL_RESC_1280x720: return CELL_VIDEO_OUT_RESOLUTION_720;
		case CELL_RESC_1920x1080: return CELL_VIDEO_OUT_RESOLUTION_1080;
		default: return CELL_VIDEO_OUT_RESOLUTION_720;
		}
	}

	u32 align_up_u32(u32 value, u32 align) noexcept
	{
		if (align <= 1) return value;
		return ((value + align - 1) / align) * align;
	}

	u32 compute_mode_color_bytes(const cell_resc_manager& mgr, u32 mode) noexcept
	{
		const int slot = mode_to_slot(mode);
		if (slot < 0) return 0;
		const auto [w, h] = mode_dimensions(mode);
		const auto& dst = mgr.dsts[slot];
		const u32 bpp = (dst.format == CELL_RESC_SURFACE_F_W16Z16Y16X16) ? 8u : 4u;
		const u32 pitch = dst.pitch ? dst.pitch : align_up_u32(w * bpp, 64u);
		const u32 h_align = std::max<u32>(1u, dst.height_align ? dst.height_align : 8u);
		const u32 aligned_h = align_up_u32(h, h_align);
		u32 num_bufs = 2;
		if (mode == CELL_RESC_720x576)
		{
			const u32 pal = mgr.config.pal_temporal_mode;
			if ((pal - CELL_RESC_PAL_60_INTERPOLATE) <= CELL_RESC_PAL_60_INTERPOLATE) num_bufs = 6;
			else if (pal == CELL_RESC_PAL_60_DROP) num_bufs = 3;
		}
		return align_up_u32(pitch * aligned_h, COLOR_BUFFER_ALIGNMENT) * num_bufs;
	}

	void register_display_buffer_both(u8 id, u32 offset, u32 pitch, u32 width, u32 height)
	{
		const auto render = rsx::get_current_renderer();
		if (!render)
		{
			return;
		}
		if (render->isHLE)
		{
			cellGcmSetDisplayBuffer(id, offset, pitch, width, height);
		}
		else if (render->dma_address)
		{
			sys_rsx_context_attribute(
				0x55555555,
				0x104,
				id,
				(u64{width} << 32) | u64{height},
				(u64{pitch} << 32) | u64{offset},
				0);
		}
	}

	void flush_default_fifo_if_mapped(const vm::ptr<CellGcmContextData>& con)
	{
		const auto render = rsx::get_current_renderer();
		if (!render || !render->dma_address || !con)
		{
			return;
		}
		const u32 cur_ea = con->current.addr();
		if ((cur_ea >> 20) >= 0xC00u)
		{
			return;
		}
		const u32 io_page = render->iomap_table.io[cur_ea >> 20];
		if (io_page == umax)
		{
			return;
		}
		const u32 new_put = io_page | (cur_ea & 0xfffffu);
		auto& ctrl = *vm::_ptr<CellGcmControl>(render->dma_address + 0x40);
		// Only advance put when con matches the active ringbuffer segment
		const u32 beg_ea = con->begin.addr();
		const u32 beg_io_page = (beg_ea >> 20) < 0xC00u ? render->iomap_table.io[beg_ea >> 20].load() : umax;
		if (beg_io_page != umax)
		{
			const u32 cur_get = ctrl.get.load();
			const u32 beg_io = beg_io_page | (beg_ea & 0xfffffu);
			const u32 end_ea = con->end.addr();
			const u32 end_io = ((end_ea >> 20) < 0xC00u && render->iomap_table.io[end_ea >> 20].load() != umax)
				? (render->iomap_table.io[end_ea >> 20].load() | (end_ea & 0xfffffu))
				: (beg_io + 0x10000u);
			if (cur_get >= beg_io && cur_get <= end_io + 64u)
			{
				ctrl.put.exchange(new_put);
			}
		}
	}

	u16 float_to_half(f32 f) noexcept
	{
		const u32 bits = std::bit_cast<u32>(f);
		const u32 sign = (bits >> 16) & 0x8000u;
		const s32 exp = static_cast<s32>((bits >> 23) & 0xffu) - 127 + 15;
		u32 mant = bits & 0x007fffffu;
		if (exp <= 0)
		{
			return static_cast<u16>(sign);
		}
		if (exp >= 31)
		{
			return static_cast<u16>(sign | 0x7c00u);
		}
		return static_cast<u16>(sign | (static_cast<u32>(exp) << 10) | (mant >> 13));
	}
}

template <>
void fmt_class_string<CellRescError>::format(std::string& out, u64 arg)
{
	format_enum(out, arg, [](CellRescError value)
	{
		switch (value)
		{
		STR_CASE(CELL_RESC_ERROR_NOT_INITIALIZED);
		STR_CASE(CELL_RESC_ERROR_REINITIALIZED);
		STR_CASE(CELL_RESC_ERROR_BAD_ALIGNMENT);
		STR_CASE(CELL_RESC_ERROR_BAD_ARGUMENT);
		STR_CASE(CELL_RESC_ERROR_LESS_MEMORY);
		STR_CASE(CELL_RESC_ERROR_GCM_FLIP_QUE_FULL);
		STR_CASE(CELL_RESC_ERROR_BAD_COMBINATION);
		STR_CASE(CELL_RESC_ERROR_x308);
		}

		return unknown;
	});
}

error_code cellRescInit(vm::cptr<CellRescInitConfig> initConfig)
{
	cellResc.notice("cellRescInit(initConfig=*0x%x)", initConfig);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_REINITIALIZED;
	}

	if (!initConfig || initConfig->size == 0u || initConfig->size > sizeof(CellRescInitConfig))
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	resc_manager.buffer_mode = 0;
	resc_manager.ratio_adj_x = 1.0f;
	resc_manager.ratio_adj_y = 1.0f;
	resc_manager.flex_ratio = 0.0f;
	resc_manager.register_count = 16;
	resc_manager.dsts = {};
	for (int i = 0; i < 4; ++i)
	{
		const auto [w, _] = mode_dimensions(1u << i);
		resc_manager.dsts[i].format = CELL_RESC_SURFACE_A8R8G8B8;
		resc_manager.dsts[i].pitch = align_up_u32(w * 4u, 64u);
		resc_manager.dsts[i].height_align = 8;
	}
	resc_manager.srcs = {};
	resc_manager.config =
	{
		initConfig->size,
		initConfig->resourcePolicy,
		initConfig->supportModes,
		initConfig->ratioMode,
		initConfig->palTemporalMode,
		initConfig->interlaceMode,
		initConfig->flipMode
	};
	resc_manager.is_initialized = true;

	auto& upscale = emu::host::services().display_upscale();
	upscale.ratio_mode.store(resc_manager.config.ratio_mode, std::memory_order_relaxed);
	upscale.aspect_x.store(1.0f, std::memory_order_relaxed);
	upscale.aspect_y.store(1.0f, std::memory_order_relaxed);
	upscale.active.store(1, std::memory_order_release);

	if (const auto render = rsx::get_current_renderer(); render && render->dma_address)
	{
		const u32 vsync_arg = (resc_manager.config.flip_mode == CELL_RESC_DISPLAY_HSYNC) ? 1u : 2u;
		sys_rsx_context_attribute(0x55555555, 0x101, 0, vsync_arg, 0, 0);
	}

	return CELL_OK;
}

void cellRescExit()
{
	cellResc.notice("cellRescExit()");

	auto& resc_manager = g_fxo->get<cell_resc_manager>();
	resc_manager.is_initialized = false;
	emu::host::services().display_upscale().active.store(0, std::memory_order_release);
}

error_code cellRescVideoOutResolutionId2RescBufferMode(u32 resolutionId, vm::ptr<u32> bufferMode)
{
	cellResc.trace("cellRescVideoOutResolutionId2RescBufferMode(resolutionId=%d, bufferMode=*0x%x)", resolutionId, bufferMode);

	if (!bufferMode)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	switch (resolutionId)
	{
	case CELL_VIDEO_OUT_RESOLUTION_1080:
	case CELL_VIDEO_OUT_RESOLUTION_1600x1080:
	case CELL_VIDEO_OUT_RESOLUTION_1440x1080:
	case CELL_VIDEO_OUT_RESOLUTION_1280x1080:
	case CELL_VIDEO_OUT_RESOLUTION_960x1080:
		*bufferMode = CELL_RESC_1920x1080;
		return CELL_OK;
	case CELL_VIDEO_OUT_RESOLUTION_720:
	case CELL_VIDEO_OUT_RESOLUTION_720_3D_FRAME_PACKING:
	case CELL_VIDEO_OUT_RESOLUTION_720_DUALVIEW_FRAME_PACKING:
		*bufferMode = CELL_RESC_1280x720;
		return CELL_OK;
	case CELL_VIDEO_OUT_RESOLUTION_480:
		*bufferMode = CELL_RESC_720x480;
		return CELL_OK;
	case CELL_VIDEO_OUT_RESOLUTION_576:
		*bufferMode = CELL_RESC_720x576;
		return CELL_OK;
	default:
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}
}

error_code cellRescSetDsts(u32 bufferMode, vm::cptr<CellRescDsts> dsts)
{
	cellResc.trace("cellRescSetDsts(bufferMode=%d, dsts=*0x%x)", bufferMode, dsts);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	const int slot = mode_to_slot(bufferMode);
	if (!dsts || slot < 0)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	resc_manager.dsts[slot] = {
		dsts->format,
		dsts->pitch,
		dsts->heightAlign ? +dsts->heightAlign : 8u,
	};
	return CELL_OK;
}

error_code cellRescSetDisplayMode(u32 bufferMode)
{
	cellResc.notice("cellRescSetDisplayMode(bufferMode=0x%x)", bufferMode);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	const int slot = mode_to_slot(bufferMode);
	if (slot < 0 || !(resc_manager.config.support_modes & bufferMode))
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	if (bufferMode == CELL_RESC_720x576)
	{
		const u32 pal_mode  = resc_manager.config.pal_temporal_mode;
		const u32 flip_mode = resc_manager.config.flip_mode;

		if ((pal_mode - CELL_RESC_PAL_60_INTERPOLATE) <= CELL_RESC_PAL_60_INTERPOLATE || pal_mode == CELL_RESC_PAL_60_DROP)
		{
			if (flip_mode == CELL_RESC_DISPLAY_HSYNC)
			{
				return CELL_RESC_ERROR_BAD_COMBINATION;
			}
		}

		if (pal_mode == CELL_RESC_PAL_60_FOR_HSYNC)
		{
			if (flip_mode == CELL_RESC_DISPLAY_VSYNC)
			{
				return CELL_RESC_ERROR_BAD_COMBINATION;
			}
		}
	}

	resc_manager.buffer_mode = bufferMode;
	const auto [dst_w, dst_h] = mode_dimensions(bufferMode);

	auto& upscale = emu::host::services().display_upscale();
	upscale.buffer_mode.store(bufferMode, std::memory_order_relaxed);
	upscale.dst_width.store(dst_w, std::memory_order_relaxed);
	upscale.dst_height.store(dst_h, std::memory_order_release);

	vm::var<CellVideoOutConfiguration> vcfg{};
	vcfg->resolutionId = mode_to_video_out_res_id(bufferMode);
	vcfg->format = (resc_manager.dsts[slot].format == CELL_RESC_SURFACE_F_W16Z16Y16X16)
		? CELL_VIDEO_OUT_BUFFER_COLOR_FORMAT_R16G16B16X16_FLOAT
		: CELL_VIDEO_OUT_BUFFER_COLOR_FORMAT_X8R8G8B8;
	vcfg->aspect = CELL_VIDEO_OUT_ASPECT_AUTO;
	vcfg->pitch = resc_manager.dsts[slot].pitch ? resc_manager.dsts[slot].pitch : align_up_u32(dst_w * 4u, 64u);
	cellVideoOutConfigure(CELL_VIDEO_OUT_PRIMARY, vcfg, vm::null, 0);

	return CELL_OK;
}

error_code cellRescAdjustAspectRatio(f32 horizontal, f32 vertical)
{
	cellResc.trace("cellRescAdjustAspectRatio(horizontal=%f, vertical=%f)", horizontal, vertical);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	if (horizontal < 0.5f || horizontal > 2.0f || vertical < 0.5f || vertical > 2.0f)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	resc_manager.ratio_adj_x = horizontal;
	resc_manager.ratio_adj_y = vertical;
	auto& upscale = emu::host::services().display_upscale();
	upscale.aspect_x.store(horizontal, std::memory_order_relaxed);
	upscale.aspect_y.store(vertical, std::memory_order_release);

	return CELL_OK;
}

error_code cellRescSetPalInterpolateDropFlexRatio(f32 ratio)
{
	cellResc.trace("cellRescSetPalInterpolateDropFlexRatio(ratio=%f)", ratio);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	if (ratio < 0.0f || ratio > 1.0f)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	resc_manager.flex_ratio = ratio;
	return CELL_OK;
}

error_code cellRescGetBufferSize(vm::ptr<s32> colorBuffers, vm::ptr<s32> vertexArray, vm::ptr<s32> fragmentShader)
{
	cellResc.trace("cellRescGetBufferSize(colorBuffers=*0x%x, vertexArray=*0x%x, fragmentShader=*0x%x)", colorBuffers, vertexArray, fragmentShader);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	const bool min_vram = (resc_manager.config.resource_policy & CELL_RESC_MINIMUM_VRAM) != 0;
	if (min_vram && !resc_manager.buffer_mode)
	{
		return CELL_RESC_ERROR_x308;
	}

	u32 color_size = 0;
	if (min_vram)
	{
		color_size = compute_mode_color_bytes(resc_manager, resc_manager.buffer_mode);
	}
	else
	{
		for (u32 m : {u32{CELL_RESC_720x480}, u32{CELL_RESC_720x576}, u32{CELL_RESC_1280x720}, u32{CELL_RESC_1920x1080}})
		{
			if (resc_manager.config.support_modes & m)
			{
				color_size = std::max<u32>(color_size, compute_mode_color_bytes(resc_manager, m));
			}
		}
		if (!color_size && resc_manager.buffer_mode)
		{
			color_size = compute_mode_color_bytes(resc_manager, resc_manager.buffer_mode);
		}
	}

	if (colorBuffers) *colorBuffers = static_cast<s32>(std::max<u32>(color_size, 0x1000u));
	if (vertexArray) *vertexArray = 0x180;
	if (fragmentShader) *fragmentShader = 0x400;

	return CELL_OK;
}

s32 cellRescGetNumColorBuffers(u32 dstMode, u32 palTemporalMode, s32 reserved)
{
	cellResc.trace("cellRescGetNumColorBuffers(dstMode=%d, palTemporalMode=%d, reserved=%d)", dstMode, palTemporalMode, reserved);

	if (reserved != 0 || mode_to_slot(dstMode) < 0)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	if (dstMode == CELL_RESC_720x576)
	{
		if ((palTemporalMode - CELL_RESC_PAL_60_INTERPOLATE) <= CELL_RESC_PAL_60_INTERPOLATE)
		{
			return 6;
		}

		if (palTemporalMode == CELL_RESC_PAL_60_DROP)
		{
			return 3;
		}
	}

	return 2;
}

error_code cellRescGcmSurface2RescSrc(vm::cptr<CellGcmSurface> gcmSurface, vm::ptr<CellRescSrc> rescSrc)
{
	cellResc.trace("cellRescGcmSurface2RescSrc(gcmSurface=*0x%x, rescSrc=*0x%x)", gcmSurface, rescSrc);

	if (!gcmSurface || !rescSrc)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	u32 fmt = gcmSurface->colorFormat;
	if (gcmSurface->type == CELL_GCM_SURFACE_SWIZZLE)
	{
		fmt |= CELL_GCM_TEXTURE_SZ;
	}
	else
	{
		fmt |= CELL_GCM_TEXTURE_LN;
	}

	rescSrc->format = fmt;
	rescSrc->pitch = gcmSurface->colorPitch[0];
	rescSrc->width = gcmSurface->width;
	rescSrc->height = gcmSurface->height;
	rescSrc->offset = gcmSurface->colorOffset[0];

	return CELL_OK;
}

error_code cellRescSetSrc(s32 idx, vm::cptr<CellRescSrc> src)
{
	cellResc.trace("cellRescSetSrc(idx=0x%x, src=*0x%x)", idx, src);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	if (idx < 0 || idx >= SRC_BUFFER_NUM || !src || !src->width || !src->height || src->width > 4096 || src->height > 4096)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	resc_manager.srcs[idx] = {
		true,
		src->format,
		src->pitch,
		src->width,
		src->height,
		src->offset,
	};

	// Delegate resolution conversion directly to WebGPU's hardware presentation pass:
	// register the game's render target as the RSX display buffer with zero intermediate copies!
	register_display_buffer_both(static_cast<u8>(idx), src->offset, src->pitch, src->width, src->height);

	auto& upscale = emu::host::services().display_upscale();
	upscale.src_width.store(src->width, std::memory_order_relaxed);
	upscale.src_height.store(src->height, std::memory_order_relaxed);
	upscale.src_pitch.store(src->pitch, std::memory_order_relaxed);
	upscale.src_offset.store(src->offset, std::memory_order_release);

	return CELL_OK;
}

error_code cellRescSetConvertAndFlip(ppu_thread& ppu, vm::ptr<CellGcmContextData> con, s32 idx)
{
	cellResc.trace("cellRescSetConvertAndFlip(con=*0x%x, idx=0x%x)", con, idx);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	if (!con || idx < 0 || idx >= SRC_BUFFER_NUM || !resc_manager.srcs[idx].valid)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	const auto& src = resc_manager.srcs[idx];
	register_display_buffer_both(static_cast<u8>(idx), src.offset, src.pitch, src.width, src.height);

	const auto render = rsx::get_current_renderer();
	if (!render)
	{
		return CELL_OK;
	}

	emu::host::services().display_upscale().resc_flips.fetch_add(1, std::memory_order_relaxed);

	if (render->isHLE)
	{
		return cellGcmSetFlip(ppu, con, static_cast<u32>(idx));
	}

	if (con->current + 6 >= con->end && con->callback)
	{
		if (s32 res = con->callback(ppu, con, 24))
		{
			return not_an_error(res);
		}
	}

	rsx::make_command(con->current, GCM_DRIVER_QUEUE, {static_cast<u32>(idx)});
	rsx::make_command(con->current, GCM_FLIP_HEAD, {0x80000000u | static_cast<u32>(idx)});
	flush_default_fifo_if_mapped(con);

	return CELL_OK;
}

error_code cellRescSetWaitFlip(ppu_thread& ppu, vm::ptr<CellGcmContextData> con)
{
	cellResc.trace("cellRescSetWaitFlip(con=*0x%x)", con);

	if (!con)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	cellGcmSetWaitFlip(ppu, con);
	flush_default_fifo_if_mapped(con);

	return CELL_OK;
}

error_code cellRescSetBufferAddress(vm::cptr<u32> colorBuffers, vm::cptr<u32> vertexArray, vm::cptr<u32> fragmentShader)
{
	cellResc.trace("cellRescSetBufferAddress(colorBuffers=*0x%x, vertexArray=*0x%x, fragmentShader=*0x%x)", colorBuffers, vertexArray, fragmentShader);

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.is_initialized)
	{
		return CELL_RESC_ERROR_NOT_INITIALIZED;
	}

	if (!colorBuffers || !vertexArray || !fragmentShader)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	if (!colorBuffers.aligned(128) || !vertexArray.aligned(4) || !fragmentShader.aligned(64))
	{
		return CELL_RESC_ERROR_BAD_ALIGNMENT;
	}

	resc_manager.color_buffers_ea = colorBuffers.addr();
	resc_manager.vertex_array_ea = vertexArray.addr();
	resc_manager.fragment_shader_ea = fragmentShader.addr();

	return CELL_OK;
}

void cellRescSetFlipHandler(vm::ptr<void(u32)> handler)
{
	cellResc.trace("cellRescSetFlipHandler(handler=*0x%x)", handler);
	cellGcmSetFlipHandler(handler);
}

void cellRescResetFlipStatus()
{
	cellResc.trace("cellRescResetFlipStatus()");
	if (const auto render = rsx::get_current_renderer())
	{
		render->flip_status = CELL_GCM_DISPLAY_FLIP_STATUS_WAITING;
		if (!render->isHLE && render->dma_address)
		{
			sys_rsx_context_attribute(0x55555555, 0x10a, 0, ~0x80000000ull, 0, 0);
		}
	}
}

s32 cellRescGetFlipStatus()
{
	cellResc.trace("cellRescGetFlipStatus()");
	if (const auto render = rsx::get_current_renderer())
	{
		if (!render->isHLE && render->driver_info)
		{
			const auto& driver_info = *vm::_ptr<RsxDriverInfo>(render->driver_info);
			return (driver_info.head[0].flipFlags & 0x80000000u) ? 0 : 1;
		}
		return static_cast<s32>(+render->flip_status);
	}
	return 0;
}

s32 cellRescGetRegisterCount()
{
	cellResc.trace("cellRescGetRegisterCount()");
	return g_fxo->get<cell_resc_manager>().register_count;
}

u64 cellRescGetLastFlipTime()
{
	cellResc.trace("cellRescGetLastFlipTime()");
	if (const auto render = rsx::get_current_renderer())
	{
		if (!render->isHLE && render->driver_info)
		{
			const auto& driver_info = *vm::_ptr<RsxDriverInfo>(render->driver_info);
			if (driver_info.head[0].lastFlipTime != 0u)
			{
				return driver_info.head[0].lastFlipTime;
			}
		}
		return +render->last_guest_flip_timestamp;
	}
	return 0;
}

void cellRescSetRegisterCount(s32 regCount)
{
	cellResc.trace("cellRescSetRegisterCount(regCount=0x%x)", regCount);
	g_fxo->get<cell_resc_manager>().register_count = regCount;
}

void cellRescSetVBlankHandler(vm::ptr<void(u32)> handler)
{
	cellResc.trace("cellRescSetVBlankHandler(handler=*0x%x)", handler);
	cellGcmSetVBlankHandler(handler);
}

error_code cellRescCreateInterlaceTable(vm::ptr<void> ea_addr, f32 srcH, CellRescTableElement depth, s32 length)
{
	cellResc.trace("cellRescCreateInterlaceTable(ea_addr=0x%x, srcH=%f, depth=%d, length=%d)", ea_addr, srcH, +depth, length);

	if (!ea_addr || srcH <= 0.0f || depth > CELL_RESC_ELEMENT_FLOAT || length <= 0)
	{
		return CELL_RESC_ERROR_BAD_ARGUMENT;
	}

	auto& resc_manager = g_fxo->get<cell_resc_manager>();

	if (!resc_manager.buffer_mode)
	{
		return CELL_RESC_ERROR_BAD_COMBINATION;
	}

	if (depth == CELL_RESC_ELEMENT_FLOAT)
	{
		auto* dst = static_cast<be_t<f32>*>(ea_addr.get_ptr());
		for (s32 i = 0; i < length; ++i)
		{
			dst[i * 4 + 0] = 0.25f;
			dst[i * 4 + 1] = 0.50f;
			dst[i * 4 + 2] = 0.25f;
			dst[i * 4 + 3] = 0.00f;
		}
	}
	else
	{
		auto* dst = static_cast<be_t<u16>*>(ea_addr.get_ptr());
		const u16 q = float_to_half(0.25f);
		const u16 h = float_to_half(0.50f);
		for (s32 i = 0; i < length; ++i)
		{
			dst[i * 4 + 0] = q;
			dst[i * 4 + 1] = h;
			dst[i * 4 + 2] = q;
			dst[i * 4 + 3] = 0;
		}
	}

	return CELL_OK;
}


DECLARE(ppu_module_manager::cellResc)("cellResc", []()
{
	REG_FUNC(cellResc, cellRescSetConvertAndFlip);
	REG_FUNC(cellResc, cellRescSetWaitFlip);
	REG_FUNC(cellResc, cellRescSetFlipHandler);
	REG_FUNC(cellResc, cellRescGcmSurface2RescSrc);
	REG_FUNC(cellResc, cellRescGetNumColorBuffers);
	REG_FUNC(cellResc, cellRescSetDsts);
	REG_FUNC(cellResc, cellRescResetFlipStatus);
	REG_FUNC(cellResc, cellRescSetPalInterpolateDropFlexRatio);
	REG_FUNC(cellResc, cellRescGetRegisterCount);
	REG_FUNC(cellResc, cellRescAdjustAspectRatio);
	REG_FUNC(cellResc, cellRescSetDisplayMode);
	REG_FUNC(cellResc, cellRescExit);
	REG_FUNC(cellResc, cellRescInit);
	REG_FUNC(cellResc, cellRescGetBufferSize);
	REG_FUNC(cellResc, cellRescGetLastFlipTime);
	REG_FUNC(cellResc, cellRescSetSrc);
	REG_FUNC(cellResc, cellRescSetRegisterCount);
	REG_FUNC(cellResc, cellRescSetBufferAddress);
	REG_FUNC(cellResc, cellRescGetFlipStatus);
	REG_FUNC(cellResc, cellRescVideoOutResolutionId2RescBufferMode);
	REG_FUNC(cellResc, cellRescSetVBlankHandler);
	REG_FUNC(cellResc, cellRescCreateInterlaceTable);
});
