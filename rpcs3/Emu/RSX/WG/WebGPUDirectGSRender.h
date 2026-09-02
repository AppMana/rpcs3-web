#pragma once

// RSX backend calling WebGPU directly from the RSX thread through emdawnwebgpu.
//
// The pthread worker hosting the RSX thread creates the device and receives the
// presentation OffscreenCanvas before the thread starts (web/host/rpcs3_web_pre.js),
// so this thread never waits on a WebGPU future: the device is imported
// synchronously, buffers are written rather than mapped, and every flip hands the
// canvas contents to the page with transferToImageBitmap without an event-loop turn.

#include "Emu/RSX/GSRender.h"

#include <webgpu/webgpu.h>

class WebGPUDirectGSRender : public GSRender
{
public:
	explicit WebGPUDirectGSRender(utils::serial* ar) noexcept;
	WebGPUDirectGSRender() noexcept : WebGPUDirectGSRender(nullptr) {}
	~WebGPUDirectGSRender() override;

	u64 get_cycles() final;

private:
	void on_init_thread() override;
	void on_exit() override;
	void begin() override;
	void end() override;
	void clear_surface(u32 mask) override;
	void flip(const rsx::display_flip_info_t& info) override;

	bool configure_surface();

	WGPUInstance m_instance = nullptr;
	WGPUDevice m_device = nullptr;
	WGPUQueue m_queue = nullptr;
	WGPUSurface m_surface = nullptr;
	u32 m_surface_width = 0;
	u32 m_surface_height = 0;
	u64 m_presented = 0;
	bool m_ready = false;
};
