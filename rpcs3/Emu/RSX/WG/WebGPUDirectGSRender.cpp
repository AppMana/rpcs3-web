#include "stdafx.h"
#include "WebGPUDirectGSRender.h"
#include "WebGPUHost.h"
#include "Emu/RSX/rsx_methods.h"

#include <emscripten.h>

// The hosting worker's JS keeps the presentation canvas (rpcs3_web_pre.js rpcs3PrepareGpu).
EM_JS(u32, rpcs3_web_direct_canvas_size, (), {
	const canvas = self.__rpcs3GpuCanvas;
	return canvas ? (((canvas.width & 0xffff) << 16) | (canvas.height & 0xffff)) >>> 0 : 0;
});

// Hands the frame rendered into the canvas to the page. transferToImageBitmap is synchronous
// and resets the canvas, so the next wgpuSurfaceGetCurrentTexture starts a new frame without
// this thread returning to its event loop.
EM_JS(void, rpcs3_web_direct_present, (u32 frame), {
	const canvas = self.__rpcs3GpuCanvas;
	if (!canvas) return;
	const bitmap = canvas.transferToImageBitmap();
	self.postMessage({ rpcs3Present: bitmap, frame: frame }, [bitmap]);
});

WebGPUDirectGSRender::WebGPUDirectGSRender(utils::serial* ar) noexcept
	: GSRender(ar)
{
	backend_config.supports_normalized_barycentrics = true;
	backend_config.supports_hw_instanced_rendering = false;
	backend_config.supports_multidraw = false;
	backend_config.supports_hw_conditional_render = false;
	backend_config.supports_last_provoking_vertex = false;
}

WebGPUDirectGSRender::~WebGPUDirectGSRender() = default;

u64 WebGPUDirectGSRender::get_cycles()
{
	return thread_ctrl::get_cycles(static_cast<named_thread<WebGPUDirectGSRender>&>(*this));
}

bool WebGPUDirectGSRender::configure_surface()
{
	const u32 packed = rpcs3_web_direct_canvas_size();
	const u32 width = packed >> 16;
	const u32 height = packed & 0xffff;
	if (!width || !height)
	{
		rsx_log.error("WebGPU direct: the RSX thread's worker holds no presentation canvas");
		return false;
	}

	if (m_surface && width == m_surface_width && height == m_surface_height)
	{
		return true;
	}

	if (!m_surface)
	{
		// The worker registered its OffscreenCanvas as the "#rpcs3-canvas" special target
		WGPUEmscriptenSurfaceSourceCanvasHTMLSelector source{};
		source.chain.sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector;
		source.selector = WGPUStringView{ "#rpcs3-canvas", WGPU_STRLEN };
		WGPUSurfaceDescriptor descriptor{};
		descriptor.nextInChain = &source.chain;
		descriptor.label = WGPUStringView{ "RPCS3 RSX presentation", WGPU_STRLEN };
		m_surface = wgpuInstanceCreateSurface(m_instance, &descriptor);
		if (!m_surface)
		{
			rsx_log.error("WebGPU direct: wgpuInstanceCreateSurface failed");
			return false;
		}
	}

	WGPUSurfaceConfiguration config{};
	config.device = m_device;
	config.format = WGPUTextureFormat_BGRA8Unorm;
	config.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
	config.width = width;
	config.height = height;
	config.alphaMode = WGPUCompositeAlphaMode_Opaque;
	config.presentMode = WGPUPresentMode_Fifo;
	wgpuSurfaceConfigure(m_surface, &config);
	m_surface_width = width;
	m_surface_height = height;
	rsx_log.notice("WebGPU direct: presentation surface %ux%u", width, height);
	return true;
}

void WebGPUDirectGSRender::on_init_thread()
{
	GSRender::on_init_thread();

	m_instance = wgpuCreateInstance(nullptr);
	// Imported from Module.preinitializedWebGPUDevice of this worker: no future to wait on
	m_device = emscripten_webgpu_get_device();
	if (!m_instance || !m_device)
	{
		rsx_log.error("WebGPU direct: no device on the RSX thread's worker (instance=%d device=%d)", !!m_instance, !!m_device);
		return;
	}
	m_queue = wgpuDeviceGetQueue(m_device);
	m_ready = configure_surface();
	rsx_log.success("WebGPU direct: device ready on the RSX thread (surface %s)", m_ready ? "configured" : "missing");
}

void WebGPUDirectGSRender::on_exit()
{
	if (m_surface) { wgpuSurfaceRelease(m_surface); m_surface = nullptr; }
	if (m_queue) { wgpuQueueRelease(m_queue); m_queue = nullptr; }
	if (m_device) { wgpuDeviceRelease(m_device); m_device = nullptr; }
	if (m_instance) { wgpuInstanceRelease(m_instance); m_instance = nullptr; }
	GSRender::on_exit();
}

void WebGPUDirectGSRender::begin()
{
	rsx::thread::begin();
}

void WebGPUDirectGSRender::end()
{
	// Draw execution is the next stage of this backend
	execute_nop_draw();
	rsx::thread::end();
}

void WebGPUDirectGSRender::clear_surface(u32 /*mask*/)
{
}

void WebGPUDirectGSRender::flip(const rsx::display_flip_info_t& info)
{
	if (m_ready && !info.skip_frame)
	{
		WGPUSurfaceTexture surface_texture{};
		wgpuSurfaceGetCurrentTexture(m_surface, &surface_texture);
		if (surface_texture.texture)
		{
			WGPUTextureView view = wgpuTextureCreateView(surface_texture.texture, nullptr);
			WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(m_device, nullptr);
			// Proof of presentation: the guest's clear colour cycles with the frame counter until draws execute
			const f32 phase = static_cast<f32>(m_presented % 120) / 120.f;
			WGPURenderPassColorAttachment attachment{};
			attachment.view = view;
			attachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
			attachment.loadOp = WGPULoadOp_Clear;
			attachment.storeOp = WGPUStoreOp_Store;
			attachment.clearValue = WGPUColor{ phase, 0.25, 1.0 - phase, 1.0 };
			WGPURenderPassDescriptor pass_descriptor{};
			pass_descriptor.colorAttachmentCount = 1;
			pass_descriptor.colorAttachments = &attachment;
			WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
			wgpuRenderPassEncoderEnd(pass);
			wgpuRenderPassEncoderRelease(pass);
			WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
			wgpuQueueSubmit(m_queue, 1, &commands);
			wgpuCommandBufferRelease(commands);
			wgpuCommandEncoderRelease(encoder);
			wgpuTextureViewRelease(view);
			wgpuTextureRelease(surface_texture.texture);
			rpcs3_web_direct_present(static_cast<u32>(m_presented));
			m_presented++;
		}
		else
		{
			rsx_log.error("WebGPU direct: wgpuSurfaceGetCurrentTexture status %d", static_cast<int>(surface_texture.status));
		}
	}

	// The host frame counter is what the runtime worker waits on for frame pacing
	rsx::webgpu::host_command_queue().note_flip();

	if (m_frame)
	{
		m_frame->flip(m_context, info.skip_frame);
	}

	rsx::thread::flip(info);
}
