#include "stdafx.h"
#include "WebGPUDirectGSRender.h"
#include "WebGPUHost.h"
#include "WebGPUDrawCommon.h"
#include "Emu/RSX/Common/BufferUtils.h"
#include "Emu/RSX/Common/TextureUtils.h"
#include "Emu/RSX/Program/ProgramStateCache.h"
#include "Emu/RSX/rsx_methods.h"
#include "Emu/RSX/rsx_utils.h"
#include "Emu/Memory/vm.h"
#include "Emu/system_config.h"

#include <emscripten.h>

#include <cstring>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wold-style-cast"
#define XXH_INLINE_ALL
#include <common/xxhash.h>
#pragma clang diagnostic pop

extern volatile u32 g_rpcs3_web_rsx_spawn_pending;


namespace
{
	constexpr u32 vertex_layout_bytes = 144;
	constexpr u32 vertex_state_bytes = 96 + 468 * 16 + vertex_layout_bytes;
	constexpr u32 fragment_constant_slots = 256;
	constexpr u32 fragment_state_bytes = 32 + fragment_constant_slots * 16;
	constexpr u32 uniform_alignment = 256;
	constexpr u32 vertex_state_stride = utils::align(vertex_state_bytes, uniform_alignment);
	constexpr u32 fragment_state_stride = utils::align(fragment_state_bytes, uniform_alignment);

	WGPUStringView sv(const char* text)
	{
		return WGPUStringView{ text, WGPU_STRLEN };
	}

	WGPUStringView sv(const std::string& text)
	{
		return WGPUStringView{ text.data(), text.size() };
	}

	const char* clear_wgsl = R"(
struct RSXClear { color: vec4f, depth: f32 };
@group(0) @binding(0) var<uniform> rsxClear: RSXClear;
struct ClearOut { @builtin(position) position: vec4f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> ClearOut {
  var out: ClearOut;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4f(x, y, 0.0, 1.0);
  return out;
}
)";

	const char* blit_wgsl = R"(
struct BlitRect { source: vec4f };
@group(0) @binding(0) var blitTexture: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;
@group(0) @binding(2) var<uniform> blitRect: BlitRect;
struct BlitOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> BlitOut {
  var out: BlitOut;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}
@fragment fn fragment_main(input: BlitOut) -> @location(0) vec4f {
  return textureSample(blitTexture, blitSampler, mix(blitRect.source.xy, blitRect.source.zw, input.uv));
}
)";

	const char* depth_blit_wgsl = R"(
struct BlitRect { source: vec4f };
@group(0) @binding(0) var blitDepth: texture_depth_2d;
@group(0) @binding(2) var<uniform> blitRect: BlitRect;
struct BlitOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> BlitOut {
  var out: BlitOut;
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}
@fragment fn fragment_main(input: BlitOut) -> @builtin(frag_depth) f32 {
  let texel = vec2i(floor(mix(blitRect.source.xy, blitRect.source.zw, input.uv)));
  return textureLoad(blitDepth, texel, 0);
}
)";

	// Host image formats of rsx::webgpu::host_surface_format (R5G6B5 and A1R5G5B5 render as
	// BGRA8, the way the Vulkan backend falls back without the packed formats)
	WGPUTextureFormat surface_texture_format(u32 host_format)
	{
		switch (host_format)
		{
		case rsx::webgpu::host_format_bgra8: return WGPUTextureFormat_BGRA8Unorm;
		case rsx::webgpu::host_format_rgba8: return WGPUTextureFormat_RGBA8Unorm;
		case rsx::webgpu::host_format_r8: return WGPUTextureFormat_R8Unorm;
		case rsx::webgpu::host_format_rg8: return WGPUTextureFormat_RG8Unorm;
		case rsx::webgpu::host_format_rgba16f: return WGPUTextureFormat_RGBA16Float;
		case rsx::webgpu::host_format_rgba32f: return WGPUTextureFormat_RGBA32Float;
		case rsx::webgpu::host_format_r32f: return WGPUTextureFormat_R32Float;
		case rsx::webgpu::host_format_b5g6r5:
		case rsx::webgpu::host_format_a1r5g5b5: return WGPUTextureFormat_BGRA8Unorm;
		case rsx::webgpu::host_format_d16: return WGPUTextureFormat_Depth16Unorm;
		case rsx::webgpu::host_format_d24s8: return WGPUTextureFormat_Depth24Plus;
		default: return WGPUTextureFormat_Undefined;
		}
	}

	const char* format_name(WGPUTextureFormat format)
	{
		switch (format)
		{
		case WGPUTextureFormat_BGRA8Unorm: return "bgra8unorm";
		case WGPUTextureFormat_RGBA8Unorm: return "rgba8unorm";
		case WGPUTextureFormat_R8Unorm: return "r8unorm";
		case WGPUTextureFormat_RG8Unorm: return "rg8unorm";
		case WGPUTextureFormat_RGBA16Float: return "rgba16float";
		case WGPUTextureFormat_RGBA32Float: return "rgba32float";
		case WGPUTextureFormat_R32Float: return "r32float";
		case WGPUTextureFormat_Depth16Unorm: return "depth16unorm";
		case WGPUTextureFormat_Depth24Plus: return "depth24plus";
		default: return "?";
		}
	}

	// vk::get_compatible_sampler_format for the texture formats the translator handles
	WGPUTextureFormat texture_format(u32 gcm_format)
	{
		switch (gcm_format)
		{
		case CELL_GCM_TEXTURE_B8: return WGPUTextureFormat_R8Unorm;
		case CELL_GCM_TEXTURE_A8R8G8B8:
		case CELL_GCM_TEXTURE_D8R8G8B8: return WGPUTextureFormat_BGRA8Unorm;
		case CELL_GCM_TEXTURE_COMPRESSED_DXT1: return WGPUTextureFormat_BC1RGBAUnorm;
		case CELL_GCM_TEXTURE_COMPRESSED_DXT23: return WGPUTextureFormat_BC2RGBAUnorm;
		case CELL_GCM_TEXTURE_COMPRESSED_DXT45: return WGPUTextureFormat_BC3RGBAUnorm;
		case CELL_GCM_TEXTURE_G8B8: return WGPUTextureFormat_RG8Unorm;
		case CELL_GCM_TEXTURE_W16_Z16_Y16_X16_FLOAT: return WGPUTextureFormat_RGBA16Float;
		case CELL_GCM_TEXTURE_W32_Z32_Y32_X32_FLOAT: return WGPUTextureFormat_RGBA32Float;
		case CELL_GCM_TEXTURE_X32_FLOAT: return WGPUTextureFormat_R32Float;
		case CELL_GCM_TEXTURE_Y16_X16_FLOAT: return WGPUTextureFormat_RG16Float;
		case CELL_GCM_TEXTURE_X16: return WGPUTextureFormat_R16Unorm;
		case CELL_GCM_TEXTURE_Y16_X16: return WGPUTextureFormat_RG16Unorm;
		default: return WGPUTextureFormat_Undefined;
		}
	}

	// vk::get_component_mapping in RSX ARGB order: tokens r g b a 0 1 over the host texel
	std::array<char, 4> texture_native_map(u32 gcm_format)
	{
		switch (gcm_format)
		{
		case CELL_GCM_TEXTURE_B8: return { '1', 'r', 'r', 'r' };
		case CELL_GCM_TEXTURE_G8B8:
		case CELL_GCM_TEXTURE_Y16_X16: return { 'g', 'r', 'g', 'r' };
		case CELL_GCM_TEXTURE_X16: return { 'r', '1', 'r', '1' };
		case CELL_GCM_TEXTURE_X32_FLOAT: return { 'r', 'r', 'r', 'r' };
		case CELL_GCM_TEXTURE_Y16_X16_FLOAT: return { 'r', 'g', 'r', 'g' };
		case CELL_GCM_TEXTURE_D8R8G8B8: return { '1', 'r', 'g', 'b' };
		default: return { 'a', 'r', 'g', 'b' };
		}
	}

	// VKGSRender::get_compatible_surface_format component maps, RSX ARGB order
	std::array<char, 4> surface_native_map(u32 rsx_format)
	{
		switch (rsx_format)
		{
		case 4: case 14: return { '0', 'r', 'g', 'b' };
		case 5: case 15: return { '1', 'r', 'g', 'b' };
		case 9: return { '1', 'r', 'r', 'r' };
		case 10: return { 'g', 'r', 'g', 'r' };
		case 13: return { 'r', 'r', 'r', 'r' };
		default: return { 'a', 'r', 'g', 'b' };
		}
	}

	// vk::apply_swizzle_remap(native map, guest remap) as an RGBA swizzle string
	std::array<char, 4> compose_swizzle(const std::array<char, 4>& native, u32 remap)
	{
		const u32 sources = remap & 0xffff;
		const u32 control = remap >> 8;
		std::array<char, 4> argb{};
		for (u32 channel = 0; channel < 4; channel++)
		{
			const u32 mode = (control >> (channel * 2)) & 3;
			if (mode == 0) argb[channel] = '0';
			else if (mode == 1) argb[channel] = '1';
			else argb[channel] = native[(sources >> (channel * 2)) & 3];
		}
		return std::array<char, 4>{ argb[1], argb[2], argb[3], argb[0] };
	}

	WGPUCompareFunction compare_function(u32 rsx_func)
	{
		switch (rsx_func)
		{
		case 0x200: return WGPUCompareFunction_Never;
		case 0x201: return WGPUCompareFunction_Less;
		case 0x202: return WGPUCompareFunction_Equal;
		case 0x203: return WGPUCompareFunction_LessEqual;
		case 0x204: return WGPUCompareFunction_Greater;
		case 0x205: return WGPUCompareFunction_NotEqual;
		case 0x206: return WGPUCompareFunction_GreaterEqual;
		case 0x207: return WGPUCompareFunction_Always;
		default: return WGPUCompareFunction_Undefined;
		}
	}

	WGPUBlendFactor blend_factor(u32 value)
	{
		switch (value)
		{
		case 0: return WGPUBlendFactor_Zero;
		case 1: return WGPUBlendFactor_One;
		case 0x300: return WGPUBlendFactor_Src;
		case 0x301: return WGPUBlendFactor_OneMinusSrc;
		case 0x302: return WGPUBlendFactor_SrcAlpha;
		case 0x303: return WGPUBlendFactor_OneMinusSrcAlpha;
		case 0x304: return WGPUBlendFactor_DstAlpha;
		case 0x305: return WGPUBlendFactor_OneMinusDstAlpha;
		case 0x306: return WGPUBlendFactor_Dst;
		case 0x307: return WGPUBlendFactor_OneMinusDst;
		case 0x308: return WGPUBlendFactor_SrcAlphaSaturated;
		case 0x8001: case 0x8003: return WGPUBlendFactor_Constant;
		case 0x8002: case 0x8004: return WGPUBlendFactor_OneMinusConstant;
		default: return WGPUBlendFactor_Undefined;
		}
	}

	WGPUBlendOperation blend_operation(u32 value)
	{
		switch (value)
		{
		case 0x8006: case 0xf006: return WGPUBlendOperation_Add;
		case 0x8007: return WGPUBlendOperation_Min;
		case 0x8008: return WGPUBlendOperation_Max;
		case 0x800a: return WGPUBlendOperation_Subtract;
		case 0x800b: case 0xf005: return WGPUBlendOperation_ReverseSubtract;
		default: return WGPUBlendOperation_Undefined;
		}
	}

	WGPUPrimitiveTopology primitive_topology(rsx::primitive_type primitive, bool expanded)
	{
		switch (primitive)
		{
		case rsx::primitive_type::points: return WGPUPrimitiveTopology_PointList;
		case rsx::primitive_type::lines: return WGPUPrimitiveTopology_LineList;
		case rsx::primitive_type::line_loop: return expanded ? WGPUPrimitiveTopology_LineStrip : WGPUPrimitiveTopology_Undefined;
		case rsx::primitive_type::line_strip: return WGPUPrimitiveTopology_LineStrip;
		case rsx::primitive_type::triangles: return WGPUPrimitiveTopology_TriangleList;
		case rsx::primitive_type::triangle_strip: return WGPUPrimitiveTopology_TriangleStrip;
		case rsx::primitive_type::triangle_fan:
		case rsx::primitive_type::quads:
		case rsx::primitive_type::polygon: return expanded ? WGPUPrimitiveTopology_TriangleList : WGPUPrimitiveTopology_Undefined;
		case rsx::primitive_type::quad_strip: return WGPUPrimitiveTopology_TriangleStrip;
		default: return WGPUPrimitiveTopology_Undefined;
		}
	}

	bool copy_guest_range(std::byte* destination, u32 address, usz size)
	{
		usz copied = 0;
		while (copied < size)
		{
			const u32 current = address + static_cast<u32>(copied);
			const usz chunk = std::min<usz>(size - copied, 0x1000 - (current & 0xfff));
			const void* source = vm::base(current);
			if (!source) return false;
			std::memcpy(destination + copied, source, chunk);
			copied += chunk;
		}
		return true;
	}

}

// The hosting worker's JS keeps the presentation canvas (rpcs3_web_pre.js rpcs3PrepareGpu).
EM_JS(u32, rpcs3_web_direct_canvas_size, (), {
	const canvas = self.__rpcs3GpuCanvas;
	return canvas ? (((canvas.width & 0xffff) << 16) | (canvas.height & 0xffff)) >>> 0 : 0;
});

#ifdef RPCS3_WEB_JSPI
// A canvas whose control the page transferred presents what was drawn into it when this worker's
// event loop turns, so the frame is released by suspending here rather than by copying it out.
EM_ASYNC_JS(void, rpcs3_web_direct_present, (u32 frame), {
	if (!self.__rpcs3GpuCanvas) return;
	self.postMessage({ rpcs3Presented: frame });
	await new Promise((resolve) => setTimeout(resolve, 0));
});
#else
// Without a suspending stack this thread never returns to its event loop, so the canvas would never
// present. transferToImageBitmap is synchronous and resets the canvas, which releases the frame and
// starts the next one in place; the page displays it through a bitmaprenderer context.
EM_JS(void, rpcs3_web_direct_present, (u32 frame), {
	const canvas = self.__rpcs3GpuCanvas;
	if (!canvas) return;
	const bitmap = canvas.transferToImageBitmap();
	self.postMessage({ rpcs3Present: bitmap, frame: frame }, [bitmap]);
});
#endif

// RSX program pair to WGSL through the browser-side translator the worker imported
// (rpcs3-webgpu-renderer.mjs translateRsxProgram). Returns a malloc'd string:
// "slots=..;dims=..;constants=N;inputs=..\n<WGSL>" or "error\n<message>".
EM_JS(char*, rpcs3_web_direct_translate, (const u8* vp, u32 vp_len, u32 vp_entry, u32 vp_ctrl, u32 vp_mask,
	const u8* fp, u32 fp_len, u32 fp_ctrl, const u32* tex_dims, const char* swizzles, u32 target_count, u32 alpha_func), {
	const translator = self.__rpcs3Translator;
	if (!translator) return stringToNewUTF8("error\nthe RSX worker has no WGSL translator");
	try {
		const textures = [];
		for (let slot = 0; slot < 16; slot += 1) {
			const dimension = new Uint32Array(wasmMemory.buffer, tex_dims, 16)[slot];
			if (dimension !== 0xff) textures.push({ stage: 0, slot: slot, dimension: dimension });
		}
		const textureSwizzles = {};
		for (const part of UTF8ToString(swizzles).split(";")) {
			if (!part) continue;
			const [slot, swizzle] = part.split("=");
			textureSwizzles[slot] = swizzle;
		}
		const result = translator.translateRsxProgram({
			vertexProgram: new Uint8Array(wasmMemory.buffer, vp, vp_len).slice(),
			vertexProgramEntry: vp_entry,
			vertexProgramControl: vp_ctrl,
			vertexProgramOutputMask: vp_mask,
			fragmentProgram: new Uint8Array(wasmMemory.buffer, fp, fp_len).slice(),
			fragmentProgramControl: fp_ctrl,
			textures: textures,
			colorTargetCount: target_count,
			alphaFunc: alpha_func === 0xff ? undefined : alpha_func,
			textureSwizzles: textureSwizzles,
		});
		const header = "slots=" + result.textureSlots.join(",") + ";dims=" + result.textureSlots.map((slot) => result.textureDimensions[slot]).join(",")
			+ ";constants=" + result.constantCount + ";inputs=" + result.inputs.join(",") + "\n";
		return stringToNewUTF8(header + result.code);
	} catch (error) {
		return stringToNewUTF8("error\n" + String(error && error.stack ? error.stack : error));
	}
});

EM_JS(void, rpcs3_web_direct_log_shader, (const char* label, const char* code), {
	console.log("[rpcs3 direct] " + UTF8ToString(label) + "\n" + UTF8ToString(code));
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
		WGPUEmscriptenSurfaceSourceCanvasHTMLSelector source{};
		source.chain.sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector;
		source.selector = sv("#rpcs3-canvas");
		WGPUSurfaceDescriptor descriptor{};
		descriptor.nextInChain = &source.chain;
		descriptor.label = sv("RPCS3 RSX presentation");
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

	// The Vulkan backend consumes shared tags during initialization; the surface store's first
	// bind must be newer than its initial write tag (see WebGPUGSRender::on_init_thread)
	(void)rsx::get_shared_tag();
	(void)rsx::get_shared_tag();

	m_instance = wgpuCreateInstance(nullptr);
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
	end_pass();
	if (m_encoder) { wgpuCommandEncoderRelease(m_encoder); m_encoder = nullptr; }
	m_rtts.destroy();
	m_surface_ops.ops.clear();
	for (auto& [id, surface] : m_surfaces)
	{
		release_surface_copies(surface);
		if (surface.view) wgpuTextureViewRelease(surface.view);
		if (surface.texture) wgpuTextureRelease(surface.texture);
	}
	m_surfaces.clear();
	for (auto& [key, texture] : m_textures)
	{
		if (texture.view) wgpuTextureViewRelease(texture.view);
		if (texture.texture) wgpuTextureRelease(texture.texture);
	}
	m_textures.clear();
	if (m_surface) { wgpuSurfaceRelease(m_surface); m_surface = nullptr; }
	if (m_queue) { wgpuQueueRelease(m_queue); m_queue = nullptr; }
	if (m_device) { wgpuDeviceRelease(m_device); m_device = nullptr; }
	if (m_instance) { wgpuInstanceRelease(m_instance); m_instance = nullptr; }
	GSRender::on_exit();
}

// ---------------------------------------------------------------------------------------------
// Frame command stream

WGPUCommandEncoder WebGPUDirectGSRender::encoder()
{
	if (!m_encoder)
	{
		WGPUCommandEncoderDescriptor descriptor{};
		descriptor.label = sv("RPCS3 RSX frame");
		m_encoder = wgpuDeviceCreateCommandEncoder(m_device, &descriptor);
	}
	return m_encoder;
}

void WebGPUDirectGSRender::begin_pass(const targets& targets)
{
	end_pass();
	std::array<WGPURenderPassColorAttachment, 4> colors{};
	for (usz i = 0; i < targets.colors.size(); i++)
	{
		colors[i].view = targets.colors[i]->view;
		colors[i].depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
		colors[i].loadOp = WGPULoadOp_Load;
		colors[i].storeOp = WGPUStoreOp_Store;
	}
	WGPURenderPassDepthStencilAttachment depth{};
	if (targets.depth)
	{
		depth.view = targets.depth->view;
		depth.depthLoadOp = WGPULoadOp_Load;
		depth.depthStoreOp = WGPUStoreOp_Store;
	}
	WGPURenderPassDescriptor descriptor{};
	descriptor.colorAttachmentCount = targets.colors.size();
	descriptor.colorAttachments = colors.data();
	descriptor.depthStencilAttachment = targets.depth ? &depth : nullptr;
	m_pass = wgpuCommandEncoderBeginRenderPass(encoder(), &descriptor);
	m_pass_key = targets.key;
}

void WebGPUDirectGSRender::end_pass()
{
	if (m_pass)
	{
		wgpuRenderPassEncoderEnd(m_pass);
		wgpuRenderPassEncoderRelease(m_pass);
		m_pass = nullptr;
		m_pass_key = {};
	}
}

void WebGPUDirectGSRender::submit()
{
	end_pass();
	flush_ring(m_uniform_ring);
	flush_ring(m_stream_ring);
	flush_ring(m_index_ring);
	if (m_encoder)
	{
		WGPUCommandBuffer commands = wgpuCommandEncoderFinish(m_encoder, nullptr);
		wgpuQueueSubmit(m_queue, 1, &commands);
		wgpuCommandBufferRelease(commands);
		wgpuCommandEncoderRelease(m_encoder);
		m_encoder = nullptr;
	}
	for (auto view : m_retired_views) wgpuTextureViewRelease(view);
	for (auto texture : m_retired_textures) wgpuTextureRelease(texture);
	for (auto buffer : m_retired_buffers) wgpuBufferRelease(buffer);
	m_retired_views.clear();
	m_retired_textures.clear();
	m_retired_buffers.clear();
	m_uniform_ring.offset = 0;
	m_stream_ring.offset = 0;
	m_index_ring.offset = 0;
	m_frame_serial++;
}

u64 WebGPUDirectGSRender::ring_allocate(ring_buffer& ring, u64 bytes, WGPUBufferUsage usage, const char* label)
{
	const u64 needed = utils::align(bytes, uniform_alignment);
	if (!ring.buffer || ring.offset + needed > ring.size)
	{
		// Grow: the previous buffer stays referenced by the bind groups and commands of this frame
		const u64 size = std::max<u64>({ ring.size * 2, ring.offset + needed, 4ull << 20 });
		WGPUBufferDescriptor descriptor{};
		descriptor.label = sv(label);
		descriptor.usage = usage | WGPUBufferUsage_CopyDst;
		descriptor.size = size;
		WGPUBuffer buffer = wgpuDeviceCreateBuffer(m_device, &descriptor);
		if (ring.buffer)
		{
			// The bytes staged for the previous buffer reach it before this frame's commands
			flush_ring(ring);
			m_retired_buffers.push_back(ring.buffer);
		}
		ring.buffer = buffer;
		ring.size = size;
		ring.offset = 0;
		ring.staging.resize(size);
	}
	const u64 offset = ring.offset;
	ring.offset += needed;
	return offset;
}

void WebGPUDirectGSRender::ring_write(ring_buffer& ring, u64 offset, const void* data, usz size)
{
	std::memcpy(ring.staging.data() + offset, data, size);
}

// One queue write per ring and frame instead of one per draw and section: every emdawnwebgpu
// call crosses into JS, and the profile showed the per-draw writes above the draw work itself
void WebGPUDirectGSRender::flush_ring(ring_buffer& ring)
{
	if (ring.buffer && ring.offset > ring.flushed)
	{
		const u64 end = std::min<u64>(utils::align(ring.offset, 4), ring.size);
		wgpuQueueWriteBuffer(m_queue, ring.buffer, ring.flushed, ring.staging.data() + ring.flushed, end - ring.flushed);
	}
	ring.flushed = 0;
}

// ---------------------------------------------------------------------------------------------
// Surface store

void WebGPUDirectGSRender::prepare_rtts(rsx::framebuffer_creation_context context)
{
	if (m_current_framebuffer_context == context && !m_graphics_state.test(rsx::rtt_config_dirty) && m_rtts_bound)
	{
		return;
	}

	m_graphics_state.clear(rsx::rtt_config_dirty | rsx::rtt_config_contested | rsx::rtt_config_valid | rsx::rtt_cache_state_dirty);
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
	m_rtts.superseded_surfaces.clear();
	m_rtts.orphaned_surfaces.clear();
	m_current_framebuffer_context = context;
	m_rtts_bound = true;
}

void WebGPUDirectGSRender::read_barrier_sampled_surfaces()
{
	for (u32 i = 0; i < rsx::limits::fragment_textures_count; ++i)
	{
		if (!(current_fp_metadata.referenced_textures_mask & (1u << i))) continue;
		const auto& tex = rsx::method_registers.fragment_textures[i];
		if (!tex.enabled()) continue;
		const u32 address = rsx::get_address(tex.offset(), tex.location());
		const u32 length = std::max<u32>(static_cast<u32>(get_texture_size(tex)), 1);
		m_rtts.for_each_overlapping(rsx::address_range32::start_length(address, length), [&](rsx::webgpu::render_target* surface)
		{
			surface->read_barrier(m_surface_ops);
		});
	}
}

WebGPUDirectGSRender::gpu_surface* WebGPUDirectGSRender::surface_by_id(u32 id)
{
	const auto found = m_surfaces.find(id);
	return found == m_surfaces.end() ? nullptr : &found->second;
}

void WebGPUDirectGSRender::erase_surface(gpu_surface& surface)
{
	end_pass();
	// vk::render_target::clear_memory: color (0, 0, 0, 1), depth 1.0
	WGPURenderPassColorAttachment color{};
	WGPURenderPassDepthStencilAttachment depth{};
	WGPURenderPassDescriptor descriptor{};
	if (surface.depth)
	{
		depth.view = surface.view;
		depth.depthLoadOp = WGPULoadOp_Clear;
		depth.depthStoreOp = WGPUStoreOp_Store;
		depth.depthClearValue = 1.f;
		descriptor.depthStencilAttachment = &depth;
	}
	else
	{
		color.view = surface.view;
		color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
		color.loadOp = WGPULoadOp_Clear;
		color.storeOp = WGPUStoreOp_Store;
		color.clearValue = WGPUColor{ 0, 0, 0, 1 };
		descriptor.colorAttachmentCount = 1;
		descriptor.colorAttachments = &color;
	}
	WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder(), &descriptor);
	wgpuRenderPassEncoderEnd(pass);
	wgpuRenderPassEncoderRelease(pass);
}

void WebGPUDirectGSRender::copy_surface(gpu_surface& source, gpu_surface& target, u32 sx1, u32 sy1, u32 sx2, u32 sy2, u32 dx1, u32 dy1, u32 dx2, u32 dy2)
{
	end_pass();
	sx1 = std::min(sx1, source.width); sx2 = std::min(sx2, source.width);
	sy1 = std::min(sy1, source.height); sy2 = std::min(sy2, source.height);
	dx1 = std::min(dx1, target.width); dx2 = std::min(dx2, target.width);
	dy1 = std::min(dy1, target.height); dy2 = std::min(dy2, target.height);
	if (sx2 <= sx1 || sy2 <= sy1 || dx2 <= dx1 || dy2 <= dy1) return;
	const u32 sw = sx2 - sx1, sh = sy2 - sy1, dw = dx2 - dx1, dh = dy2 - dy1;

	if (sw == dw && sh == dh)
	{
		WGPUTexelCopyTextureInfo src{ source.texture, 0, { sx1, sy1, 0 }, WGPUTextureAspect_All };
		WGPUTexelCopyTextureInfo dst{ target.texture, 0, { dx1, dy1, 0 }, WGPUTextureAspect_All };
		WGPUExtent3D extent{ dw, dh, 1 };
		wgpuCommandEncoderCopyTextureToTexture(encoder(), &src, &dst, &extent);
		return;
	}

	// vk::blitter::scale_image with nearest filtering
	const bool depth = target.depth;
	const u64 rect_offset = ring_allocate(m_uniform_ring, 16, WGPUBufferUsage_Uniform, "RPCS3 RSX uniforms");
	f32 rect[4];
	if (depth)
	{
		rect[0] = static_cast<f32>(sx1); rect[1] = static_cast<f32>(sy1); rect[2] = static_cast<f32>(sx2); rect[3] = static_cast<f32>(sy2);
	}
	else
	{
		rect[0] = static_cast<f32>(sx1) / source.width; rect[1] = static_cast<f32>(sy1) / source.height;
		rect[2] = static_cast<f32>(sx2) / source.width; rect[3] = static_cast<f32>(sy2) / source.height;
	}
	ring_write(m_uniform_ring, rect_offset, rect, sizeof(rect));

	WGPURenderPipeline pipeline = get_blit_pipeline(target.format, depth);
	WGPURenderPassColorAttachment color{};
	WGPURenderPassDepthStencilAttachment depth_attachment{};
	WGPURenderPassDescriptor descriptor{};
	if (depth)
	{
		depth_attachment.view = target.view;
		depth_attachment.depthLoadOp = WGPULoadOp_Load;
		depth_attachment.depthStoreOp = WGPUStoreOp_Store;
		descriptor.depthStencilAttachment = &depth_attachment;
	}
	else
	{
		color.view = target.view;
		color.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
		color.loadOp = WGPULoadOp_Load;
		color.storeOp = WGPUStoreOp_Store;
		descriptor.colorAttachmentCount = 1;
		descriptor.colorAttachments = &color;
	}
	WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder(), &descriptor);
	wgpuRenderPassEncoderSetPipeline(pass, pipeline);
	wgpuRenderPassEncoderSetViewport(pass, static_cast<f32>(dx1), static_cast<f32>(dy1), static_cast<f32>(dw), static_cast<f32>(dh), 0.f, 1.f);
	wgpuRenderPassEncoderSetScissorRect(pass, dx1, dy1, dw, dh);
	std::array<WGPUBindGroupEntry, 3> entries{};
	entries[0].binding = 0; entries[0].textureView = source.view;
	entries[1].binding = 1; entries[1].sampler = m_nearest_sampler;
	entries[2].binding = 2; entries[2].buffer = m_uniform_ring.buffer; entries[2].offset = rect_offset; entries[2].size = 16;
	WGPUBindGroupDescriptor group_descriptor{};
	group_descriptor.layout = depth ? m_depth_blit_layout : m_blit_layout;
	if (depth)
	{
		entries[1] = entries[2];
		group_descriptor.entryCount = 2;
	}
	else
	{
		group_descriptor.entryCount = 3;
	}
	group_descriptor.entries = entries.data();
	WGPUBindGroup group = wgpuDeviceCreateBindGroup(m_device, &group_descriptor);
	wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
	wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
	wgpuRenderPassEncoderEnd(pass);
	wgpuRenderPassEncoderRelease(pass);
	wgpuBindGroupRelease(group);
}

void WebGPUDirectGSRender::apply_surface_ops()
{
	for (const auto& op : m_surface_ops.ops)
	{
		m_stats.surface_ops++;
		switch (static_cast<rsx::webgpu::surface_op_kind>(op.kind))
		{
		case rsx::webgpu::surface_op_kind::create:
		{
			const WGPUTextureFormat format = surface_texture_format(op.host_format);
			if (format == WGPUTextureFormat_Undefined)
			{
				rsx_log.error("WebGPU direct: surface host format 0x%x is not translated", op.host_format);
				m_stats.unsupported++;
				break;
			}
			gpu_surface surface{};
			surface.format = format;
			surface.width = op.image_width;
			surface.height = op.image_height;
			surface.depth = op.is_depth != 0;
			surface.host_format = op.host_format;
			surface.surface_width = op.image_width;
			surface.surface_height = op.image_height;
			WGPUTextureDescriptor descriptor{};
			const std::string label = fmt::format("RPCS3 RSX %s surface #%u", surface.depth ? "depth" : "color", op.id);
			descriptor.label = sv(label);
			descriptor.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
			descriptor.dimension = WGPUTextureDimension_2D;
			descriptor.size = { op.image_width, op.image_height, 1 };
			descriptor.format = format;
			descriptor.mipLevelCount = 1;
			descriptor.sampleCount = 1;
			surface.texture = wgpuDeviceCreateTexture(m_device, &descriptor);
			surface.view = wgpuTextureCreateView(surface.texture, nullptr);
			if (auto existing = surface_by_id(op.id))
			{
				m_retired_views.push_back(existing->view);
				m_retired_textures.push_back(existing->texture);
			}
			m_surfaces[op.id] = surface;
			break;
		}
		case rsx::webgpu::surface_op_kind::describe:
		{
			if (auto surface = surface_by_id(op.id))
			{
				surface->surface_width = op.surface_width;
				surface->surface_height = op.surface_height;
				surface->samples_x = op.samples_x;
				surface->samples_y = op.samples_y;
				surface->address = op.address;
				surface->pitch = op.pitch;
				surface->rsx_format = op.rsx_format;
			}
			break;
		}
		case rsx::webgpu::surface_op_kind::destroy:
		{
			if (auto surface = surface_by_id(op.id))
			{
				end_pass();
				release_surface_copies(*surface);
				m_retired_views.push_back(surface->view);
				m_retired_textures.push_back(surface->texture);
				m_surfaces.erase(op.id);
			}
			break;
		}
		case rsx::webgpu::surface_op_kind::erase:
		{
			if (auto surface = surface_by_id(op.id)) erase_surface(*surface);
			break;
		}
		case rsx::webgpu::surface_op_kind::copy_scaled:
		{
			auto source = surface_by_id(op.src_id);
			auto target = surface_by_id(op.id);
			if (!source || !target) break;
			if (op.rsx_format == 1 || source->format != target->format || source == target)
			{
				// Typeless (format cast) transfers are not translated yet
				m_stats.unsupported++;
				break;
			}
			copy_surface(*source, *target, op.src_x1, op.src_y1, op.src_x2, op.src_y2, op.dst_x1, op.dst_y1, op.dst_x2, op.dst_y2);
			break;
		}
		case rsx::webgpu::surface_op_kind::load_memory:
			m_stats.unsupported++;
			break;
		default:
			break;
		}
	}
	m_surface_ops.ops.clear();
}

WebGPUDirectGSRender::targets WebGPUDirectGSRender::bound_targets()
{
	targets result;
	for (u8 index : rsx::utility::get_rtt_indexes(m_framebuffer_layout.target))
	{
		if (!m_framebuffer_layout.color_write_enabled[index]) continue;
		const auto& bound = m_rtts.m_bound_render_targets[index];
		if (!bound.second || bound.first != m_framebuffer_layout.color_addresses[index]) continue;
		if (auto surface = surface_by_id(bound.second->id))
		{
			result.key.colors[result.colors.size()] = bound.second->id;
			result.formats.colors[result.colors.size()] = surface->format;
			result.colors.push_back(surface);
		}
	}
	if (const auto& bound = m_rtts.m_bound_depth_stencil; bound.second && bound.first == m_framebuffer_layout.zeta_address)
	{
		if (auto surface = surface_by_id(bound.second->id))
		{
			result.depth = surface;
			result.key.depth = bound.second->id;
			result.formats.depth = surface->format;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------------------------
// Programs, pipelines, samplers, textures

WebGPUDirectGSRender::gpu_program& WebGPUDirectGSRender::get_program(const program_key& key, const std::array<sampled_texture, 16>& textures)
{
	if (const auto found = m_programs.find(key); found != m_programs.end())
	{
		return found->second;
	}

	gpu_program program{};
	std::array<u32, 16> dims{};
	for (u32 slot = 0; slot < 16; slot++) dims[slot] = key.dimensions[slot];

	// The translator takes the non-default swizzles as "slot=rgba;" pairs
	std::string swizzles;
	for (u32 slot = 0; slot < 16; slot++)
	{
		if (!(current_fp_metadata.referenced_textures_mask & (1u << slot))) continue;
		const auto& swizzle = textures[slot].swizzle;
		if (swizzle == std::array<char, 4>{ 'r', 'g', 'b', 'a' }) continue;
		fmt::append(swizzles, "%u=%c%c%c%c;", slot, swizzle[0], swizzle[1], swizzle[2], swizzle[3]);
	}
	const u32 color_target_count = key.target_count;
	const u32 alpha_func = key.alpha_func;
	char* translated = rpcs3_web_direct_translate(
		reinterpret_cast<const u8*>(current_vertex_program.data.data()), static_cast<u32>(current_vertex_program.data.size() * sizeof(u32)),
		current_vertex_program.entry, current_vertex_program.ctrl, rsx::method_registers.vertex_attrib_output_mask(),
		static_cast<const u8*>(current_fragment_program.get_data()), current_fragment_program.ucode_length, rsx::method_registers.shader_control(),
		dims.data(), swizzles.c_str(), color_target_count, alpha_func);
	std::string text = translated ? translated : "error\ntranslator returned null";
	std::free(translated);

	const usz newline = text.find('\n');
	const std::string header = text.substr(0, newline);
	if (header == "error" || newline == std::string::npos)
	{
		rsx_log.error("WebGPU direct: program translation failed: %s", text.substr(std::min(newline + 1, text.size()), 400));
		m_stats.translation_failures++;
		return m_programs.emplace(key, program).first->second;
	}
	const std::string code = text.substr(newline + 1);

	// header: slots=..;dims=..;constants=N;inputs=..
	auto field = [&](const std::string& name) -> std::string
	{
		const usz start = header.find(name + "=");
		if (start == std::string::npos) return {};
		const usz end = header.find(';', start);
		return header.substr(start + name.size() + 1, end == std::string::npos ? std::string::npos : end - start - name.size() - 1);
	};
	auto parse_list = [](const std::string& list)
	{
		std::vector<u32> values;
		usz position = 0;
		while (position < list.size())
		{
			const usz comma = list.find(',', position);
			const std::string item = list.substr(position, comma == std::string::npos ? std::string::npos : comma - position);
			if (!item.empty()) values.push_back(static_cast<u32>(std::stoul(item)));
			if (comma == std::string::npos) break;
			position = comma + 1;
		}
		return values;
	};
	program.texture_slots = parse_list(field("slots"));
	const auto slot_dims = parse_list(field("dims"));
	for (usz i = 0; i < program.texture_slots.size() && i < slot_dims.size(); i++)
	{
		program.texture_dimensions[program.texture_slots[i]] = static_cast<u8>(slot_dims[i]);
	}
	program.constant_count = static_cast<u32>(std::stoul(field("constants").empty() ? "0" : field("constants")));

	WGPUShaderSourceWGSL source{};
	source.chain.sType = WGPUSType_ShaderSourceWGSL;
	source.code = sv(code);
	WGPUShaderModuleDescriptor module_descriptor{};
	module_descriptor.nextInChain = &source.chain;
	module_descriptor.label = sv("RPCS3 translated RSX program");
	program.module = wgpuDeviceCreateShaderModule(m_device, &module_descriptor);

	std::vector<WGPUBindGroupLayoutEntry> entries;
	auto buffer_entry = [&](u32 binding, WGPUShaderStage stage, WGPUBufferBindingType type)
	{
		WGPUBindGroupLayoutEntry entry{};
		entry.binding = binding;
		entry.visibility = stage;
		entry.buffer.type = type;
		entries.push_back(entry);
	};
	buffer_entry(32, WGPUShaderStage_Vertex, WGPUBufferBindingType_Uniform);
	buffer_entry(34, WGPUShaderStage_Vertex, WGPUBufferBindingType_ReadOnlyStorage);
	buffer_entry(35, WGPUShaderStage_Vertex, WGPUBufferBindingType_ReadOnlyStorage);
	buffer_entry(33, WGPUShaderStage_Fragment, WGPUBufferBindingType_Uniform);
	static const WGPUTextureViewDimension view_dimensions[4] = { WGPUTextureViewDimension_1D, WGPUTextureViewDimension_2D, WGPUTextureViewDimension_Cube, WGPUTextureViewDimension_3D };
	for (u32 slot : program.texture_slots)
	{
		WGPUBindGroupLayoutEntry texture{};
		texture.binding = slot * 2;
		texture.visibility = WGPUShaderStage_Fragment;
		texture.texture.sampleType = WGPUTextureSampleType_Float;
		texture.texture.viewDimension = view_dimensions[program.texture_dimensions[slot] & 3];
		entries.push_back(texture);
		WGPUBindGroupLayoutEntry sampler{};
		sampler.binding = slot * 2 + 1;
		sampler.visibility = WGPUShaderStage_Fragment;
		sampler.sampler.type = WGPUSamplerBindingType_Filtering;
		entries.push_back(sampler);
	}
	WGPUBindGroupLayoutDescriptor layout_descriptor{};
	layout_descriptor.entryCount = entries.size();
	layout_descriptor.entries = entries.data();
	program.bind_group_layout = wgpuDeviceCreateBindGroupLayout(m_device, &layout_descriptor);
	WGPUPipelineLayoutDescriptor pipeline_layout_descriptor{};
	pipeline_layout_descriptor.bindGroupLayoutCount = 1;
	pipeline_layout_descriptor.bindGroupLayouts = &program.bind_group_layout;
	program.pipeline_layout = wgpuDeviceCreatePipelineLayout(m_device, &pipeline_layout_descriptor);
	program.valid = true;
	m_stats.programs++;
	return m_programs.emplace(key, program).first->second;
}

WGPURenderPipeline WebGPUDirectGSRender::get_pipeline(const pipeline_key& key, const gpu_program& program, const targets& targets,
	WGPUPrimitiveTopology topology, WGPUIndexFormat strip_index_format, const rsx::webgpu::resolved_state_packet& state)
{
	if (const auto found = m_pipelines.find(key); found != m_pipelines.end())
	{
		return found->second;
	}

	std::array<WGPUColorTargetState, 4> color_targets{};
	std::array<WGPUBlendState, 4> blends{};
	for (usz i = 0; i < targets.colors.size(); i++)
	{
		color_targets[i].format = targets.colors[i]->format;
		const u32 mask = state.color_write_mask[i];
		color_targets[i].writeMask = (mask & 1 ? WGPUColorWriteMask_Red : 0) | (mask & 2 ? WGPUColorWriteMask_Green : 0) |
			(mask & 4 ? WGPUColorWriteMask_Blue : 0) | (mask & 8 ? WGPUColorWriteMask_Alpha : 0);
		if (state.blend_enabled_mask & (1u << i))
		{
			blends[i].color = { blend_operation(state.blend_equation_rgb), blend_factor(state.blend_sfactor_rgb), blend_factor(state.blend_dfactor_rgb) };
			blends[i].alpha = { blend_operation(state.blend_equation_a), blend_factor(state.blend_sfactor_a), blend_factor(state.blend_dfactor_a) };
			color_targets[i].blend = &blends[i];
		}
	}
	WGPUFragmentState fragment{};
	fragment.module = program.module;
	fragment.entryPoint = sv("fragment_main");
	fragment.targetCount = targets.colors.size();
	fragment.targets = color_targets.data();

	WGPUDepthStencilState depth{};
	if (targets.depth)
	{
		depth.format = targets.depth->format;
		// Like RPCS3's Vulkan backend: depth write is meaningless without depth test
		const bool test = state.depth_test_enabled != 0;
		depth.depthWriteEnabled = (test && state.depth_write_enabled) ? WGPUOptionalBool_True : WGPUOptionalBool_False;
		depth.depthCompare = test ? compare_function(state.depth_func) : WGPUCompareFunction_Always;
		depth.stencilFront = { WGPUCompareFunction_Always, WGPUStencilOperation_Keep, WGPUStencilOperation_Keep, WGPUStencilOperation_Keep };
		depth.stencilBack = depth.stencilFront;
	}

	WGPURenderPipelineDescriptor descriptor{};
	descriptor.label = sv("RPCS3 RSX pipeline");
	descriptor.layout = program.pipeline_layout;
	descriptor.vertex.module = program.module;
	descriptor.vertex.entryPoint = sv("vertex_main");
	descriptor.primitive.topology = topology;
	descriptor.primitive.stripIndexFormat = strip_index_format;
	descriptor.primitive.frontFace = state.front_face_mode == 0x0901 ? WGPUFrontFace_CW : WGPUFrontFace_CCW;
	descriptor.primitive.cullMode = !state.cull_face_enabled ? WGPUCullMode_None : state.cull_face_mode == 0x0404 ? WGPUCullMode_Front : WGPUCullMode_Back;
	descriptor.multisample.count = 1;
	descriptor.multisample.mask = 0xffffffff;
	descriptor.depthStencil = targets.depth ? &depth : nullptr;
	descriptor.fragment = &fragment;
	WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(m_device, &descriptor);
	m_stats.pipelines++;
	m_pipelines.emplace(key, pipeline);
	return pipeline;
}

WGPUSampler WebGPUDirectGSRender::get_sampler(u32 address_modes, u32 filter_modes, u32 mip_count)
{
	const u64 key = (static_cast<u64>(address_modes) << 32) | (static_cast<u64>(filter_modes & 0xffff) << 8) | (mip_count & 0xff);
	if (const auto found = m_samplers.find(key); found != m_samplers.end()) return found->second;
	auto address_mode = [](u32 value) { return value == 1 ? WGPUAddressMode_Repeat : value == 2 ? WGPUAddressMode_MirrorRepeat : WGPUAddressMode_ClampToEdge; };
	const u32 min_filter = filter_modes & 0xff;
	const u32 mag_filter = (filter_modes >> 8) & 0xff;
	// CELL_GCM_TEXTURE_NEAREST/LINEAR sample the base level only; *_NEAREST_NEAREST/LINEAR_NEAREST
	// pick a level, *_NEAREST_LINEAR/LINEAR_LINEAR blend two levels.
	const bool mipmapped = min_filter >= 3 && min_filter <= 6;
	WGPUSamplerDescriptor descriptor{};
	descriptor.addressModeU = address_mode(address_modes & 0xff);
	descriptor.addressModeV = address_mode((address_modes >> 8) & 0xff);
	descriptor.addressModeW = address_mode((address_modes >> 16) & 0xff);
	descriptor.magFilter = mag_filter == 1 ? WGPUFilterMode_Nearest : WGPUFilterMode_Linear;
	descriptor.minFilter = (min_filter == 1 || min_filter == 3 || min_filter == 5) ? WGPUFilterMode_Nearest : WGPUFilterMode_Linear;
	descriptor.mipmapFilter = (min_filter == 5 || min_filter == 6) ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
	descriptor.lodMinClamp = 0.f;
	descriptor.lodMaxClamp = mipmapped ? static_cast<f32>(std::max<u32>(mip_count, 1) - 1) : 0.f;
	descriptor.maxAnisotropy = 1;
	WGPUSampler sampler = wgpuDeviceCreateSampler(m_device, &descriptor);
	m_samplers.emplace(key, sampler);
	return sampler;
}

WGPUTextureView WebGPUDirectGSRender::null_texture_view(u8 dimension)
{
	dimension &= 3;
	if (m_null_views[dimension]) return m_null_views[dimension];
	const bool cube = dimension == 2;
	WGPUTextureDescriptor descriptor{};
	descriptor.label = sv("RPCS3 RSX null texture");
	descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
	descriptor.dimension = dimension == 3 ? WGPUTextureDimension_3D : dimension == 0 ? WGPUTextureDimension_1D : WGPUTextureDimension_2D;
	descriptor.size = { 4, dimension == 0 ? 1u : 4u, cube ? 6u : 1u };
	descriptor.format = WGPUTextureFormat_RGBA8Unorm;
	descriptor.mipLevelCount = 1;
	descriptor.sampleCount = 1;
	WGPUTexture texture = wgpuDeviceCreateTexture(m_device, &descriptor);
	std::array<u8, 4 * 4 * 4 * 6> zeros{};
	WGPUTexelCopyTextureInfo destination{ texture, 0, { 0, 0, 0 }, WGPUTextureAspect_All };
	WGPUTexelCopyBufferLayout layout{ 0, 16, dimension == 0 ? 1u : 4u };
	WGPUExtent3D extent = descriptor.size;
	wgpuQueueWriteTexture(m_queue, &destination, zeros.data(), zeros.size(), &layout, &extent);
	WGPUTextureViewDescriptor view_descriptor{};
	static const WGPUTextureViewDimension view_dimensions[4] = { WGPUTextureViewDimension_1D, WGPUTextureViewDimension_2D, WGPUTextureViewDimension_Cube, WGPUTextureViewDimension_3D };
	view_descriptor.dimension = view_dimensions[dimension];
	view_descriptor.format = WGPUTextureFormat_RGBA8Unorm;
	view_descriptor.mipLevelCount = 1;
	view_descriptor.arrayLayerCount = cube ? 6 : 1;
	view_descriptor.aspect = WGPUTextureAspect_All;
	m_null_views[dimension] = wgpuTextureCreateView(texture, &view_descriptor);
	return m_null_views[dimension];
}

WGPUSampler WebGPUDirectGSRender::null_sampler()
{
	if (!m_null_sampler)
	{
		WGPUSamplerDescriptor descriptor{};
		descriptor.addressModeU = descriptor.addressModeV = descriptor.addressModeW = WGPUAddressMode_ClampToEdge;
		descriptor.magFilter = descriptor.minFilter = WGPUFilterMode_Nearest;
		descriptor.mipmapFilter = WGPUMipmapFilterMode_Nearest;
		descriptor.lodMaxClamp = 32.f;
		descriptor.maxAnisotropy = 1;
		m_null_sampler = wgpuDeviceCreateSampler(m_device, &descriptor);
	}
	return m_null_sampler;
}

WGPURenderPipeline WebGPUDirectGSRender::get_clear_pipeline(const targets& targets, u32 write_mask, bool depth_write)
{
	const clear_pipeline_key key{ targets.formats, write_mask, depth_write ? 1u : 0u };
	if (const auto found = m_clear_pipelines.find(key); found != m_clear_pipelines.end()) return found->second;

	const usz count = std::max<usz>(1, targets.colors.size());
	std::string code = clear_wgsl;
	code += "struct ClearFragment {";
	for (usz i = 0; i < count; i++) code += fmt::format(" @location(%d) color%d: vec4f,", i, i);
	if (targets.depth) code += " @builtin(frag_depth) depth: f32";
	code += " };\n@fragment fn fragment_main() -> ClearFragment {\n  var out: ClearFragment;\n";
	for (usz i = 0; i < count; i++) code += fmt::format("  out.color%d = rsxClear.color;\n", i);
	if (targets.depth) code += "  out.depth = rsxClear.depth;\n";
	code += "  return out;\n}\n";

	WGPUShaderSourceWGSL source{};
	source.chain.sType = WGPUSType_ShaderSourceWGSL;
	source.code = sv(code);
	WGPUShaderModuleDescriptor module_descriptor{};
	module_descriptor.nextInChain = &source.chain;
	WGPUShaderModule module = wgpuDeviceCreateShaderModule(m_device, &module_descriptor);

	if (!m_clear_layout)
	{
		WGPUBindGroupLayoutEntry entry{};
		entry.binding = 0;
		entry.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
		entry.buffer.type = WGPUBufferBindingType_Uniform;
		entry.buffer.minBindingSize = 32;
		WGPUBindGroupLayoutDescriptor descriptor{};
		descriptor.entryCount = 1;
		descriptor.entries = &entry;
		m_clear_layout = wgpuDeviceCreateBindGroupLayout(m_device, &descriptor);
	}
	WGPUPipelineLayoutDescriptor layout_descriptor{};
	layout_descriptor.bindGroupLayoutCount = 1;
	layout_descriptor.bindGroupLayouts = &m_clear_layout;
	WGPUPipelineLayout layout = wgpuDeviceCreatePipelineLayout(m_device, &layout_descriptor);

	std::array<WGPUColorTargetState, 4> color_targets{};
	for (usz i = 0; i < targets.colors.size(); i++)
	{
		color_targets[i].format = targets.colors[i]->format;
		color_targets[i].writeMask = write_mask;
	}
	WGPUFragmentState fragment{};
	fragment.module = module;
	fragment.entryPoint = sv("fragment_main");
	fragment.targetCount = targets.colors.size();
	fragment.targets = color_targets.data();
	WGPUDepthStencilState depth{};
	if (targets.depth)
	{
		depth.format = targets.depth->format;
		depth.depthWriteEnabled = depth_write ? WGPUOptionalBool_True : WGPUOptionalBool_False;
		depth.depthCompare = WGPUCompareFunction_Always;
		depth.stencilFront = { WGPUCompareFunction_Always, WGPUStencilOperation_Keep, WGPUStencilOperation_Keep, WGPUStencilOperation_Keep };
		depth.stencilBack = depth.stencilFront;
	}
	WGPURenderPipelineDescriptor descriptor{};
	descriptor.label = sv("RPCS3 RSX clear");
	descriptor.layout = layout;
	descriptor.vertex.module = module;
	descriptor.vertex.entryPoint = sv("vertex_main");
	descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
	descriptor.primitive.cullMode = WGPUCullMode_None;
	descriptor.multisample.count = 1;
	descriptor.multisample.mask = 0xffffffff;
	descriptor.depthStencil = targets.depth ? &depth : nullptr;
	descriptor.fragment = &fragment;
	WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(m_device, &descriptor);
	wgpuPipelineLayoutRelease(layout);
	wgpuShaderModuleRelease(module);
	m_clear_pipelines.emplace(key, pipeline);
	return pipeline;
}

WGPURenderPipeline WebGPUDirectGSRender::get_blit_pipeline(WGPUTextureFormat format, bool depth)
{
	const u32 key = (static_cast<u32>(format) << 1) | (depth ? 1u : 0u);
	if (const auto found = m_blit_pipelines.find(key); found != m_blit_pipelines.end()) return found->second;

	if (!m_nearest_sampler)
	{
		WGPUSamplerDescriptor descriptor{};
		descriptor.addressModeU = descriptor.addressModeV = descriptor.addressModeW = WGPUAddressMode_ClampToEdge;
		descriptor.magFilter = descriptor.minFilter = WGPUFilterMode_Nearest;
		descriptor.mipmapFilter = WGPUMipmapFilterMode_Nearest;
		descriptor.lodMaxClamp = 32.f;
		descriptor.maxAnisotropy = 1;
		m_nearest_sampler = wgpuDeviceCreateSampler(m_device, &descriptor);
	}
	if (!m_blit_layout)
	{
		std::array<WGPUBindGroupLayoutEntry, 3> entries{};
		entries[0].binding = 0; entries[0].visibility = WGPUShaderStage_Fragment; entries[0].texture.sampleType = WGPUTextureSampleType_Float; entries[0].texture.viewDimension = WGPUTextureViewDimension_2D;
		entries[1].binding = 1; entries[1].visibility = WGPUShaderStage_Fragment; entries[1].sampler.type = WGPUSamplerBindingType_Filtering;
		entries[2].binding = 2; entries[2].visibility = WGPUShaderStage_Fragment; entries[2].buffer.type = WGPUBufferBindingType_Uniform; entries[2].buffer.minBindingSize = 16;
		WGPUBindGroupLayoutDescriptor descriptor{};
		descriptor.entryCount = 3;
		descriptor.entries = entries.data();
		m_blit_layout = wgpuDeviceCreateBindGroupLayout(m_device, &descriptor);
		std::array<WGPUBindGroupLayoutEntry, 2> depth_entries{};
		depth_entries[0].binding = 0; depth_entries[0].visibility = WGPUShaderStage_Fragment; depth_entries[0].texture.sampleType = WGPUTextureSampleType_Depth; depth_entries[0].texture.viewDimension = WGPUTextureViewDimension_2D;
		depth_entries[1].binding = 2; depth_entries[1].visibility = WGPUShaderStage_Fragment; depth_entries[1].buffer.type = WGPUBufferBindingType_Uniform; depth_entries[1].buffer.minBindingSize = 16;
		WGPUBindGroupLayoutDescriptor depth_descriptor{};
		depth_descriptor.entryCount = 2;
		depth_descriptor.entries = depth_entries.data();
		m_depth_blit_layout = wgpuDeviceCreateBindGroupLayout(m_device, &depth_descriptor);
	}

	WGPUShaderSourceWGSL source{};
	source.chain.sType = WGPUSType_ShaderSourceWGSL;
	source.code = sv(depth ? depth_blit_wgsl : blit_wgsl);
	WGPUShaderModuleDescriptor module_descriptor{};
	module_descriptor.nextInChain = &source.chain;
	WGPUShaderModule module = wgpuDeviceCreateShaderModule(m_device, &module_descriptor);
	WGPUBindGroupLayout group_layout = depth ? m_depth_blit_layout : m_blit_layout;
	WGPUPipelineLayoutDescriptor layout_descriptor{};
	layout_descriptor.bindGroupLayoutCount = 1;
	layout_descriptor.bindGroupLayouts = &group_layout;
	WGPUPipelineLayout layout = wgpuDeviceCreatePipelineLayout(m_device, &layout_descriptor);

	WGPUColorTargetState color_target{};
	color_target.format = format;
	color_target.writeMask = WGPUColorWriteMask_All;
	WGPUFragmentState fragment{};
	fragment.module = module;
	fragment.entryPoint = sv("fragment_main");
	fragment.targetCount = depth ? 0 : 1;
	fragment.targets = depth ? nullptr : &color_target;
	WGPUDepthStencilState depth_state{};
	if (depth)
	{
		depth_state.format = format;
		depth_state.depthWriteEnabled = WGPUOptionalBool_True;
		depth_state.depthCompare = WGPUCompareFunction_Always;
		depth_state.stencilFront = { WGPUCompareFunction_Always, WGPUStencilOperation_Keep, WGPUStencilOperation_Keep, WGPUStencilOperation_Keep };
		depth_state.stencilBack = depth_state.stencilFront;
	}
	WGPURenderPipelineDescriptor descriptor{};
	descriptor.label = sv("RPCS3 RSX blit");
	descriptor.layout = layout;
	descriptor.vertex.module = module;
	descriptor.vertex.entryPoint = sv("vertex_main");
	descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
	descriptor.primitive.cullMode = WGPUCullMode_None;
	descriptor.multisample.count = 1;
	descriptor.multisample.mask = 0xffffffff;
	descriptor.depthStencil = depth ? &depth_state : nullptr;
	descriptor.fragment = &fragment;
	WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(m_device, &descriptor);
	wgpuPipelineLayoutRelease(layout);
	wgpuShaderModuleRelease(module);
	m_blit_pipelines.emplace(key, pipeline);
	return pipeline;
}

WebGPUDirectGSRender::gpu_texture* WebGPUDirectGSRender::upload_texture(const rsx::fragment_texture& texture,
	const rsx::webgpu::texture_packet_record& record, u32 address, u32 size)
{
	const u32 gcm_format = record.format & ~(CELL_GCM_TEXTURE_LN | CELL_GCM_TEXTURE_UN);
	const WGPUTextureFormat format = texture_format(gcm_format);
	if (format == WGPUTextureFormat_Undefined || !size)
	{
		return nullptr;
	}

	// Keyed by placement (descriptor, address, size). The upload stays valid while the write
	// versions of its guest pages are unchanged (vm::web_page_version_sum): every guest write
	// path bumps them, which is what RPCS3's texture cache gets from page protection.
	struct placement_key { rsx::webgpu::texture_packet_record record; u32 address; u32 size; } placement{ record, address, size };
	std::memset(reinterpret_cast<u8*>(&placement.record) + sizeof(record) - 8, 0, 8);
	const u64 key = XXH64(&placement, sizeof(placement), 0);
	const u64 version = vm::web_page_version_sum(address, size);
	if (const auto found = m_textures.find(key); found != m_textures.end())
	{
		if (found->second.version == version)
		{
			found->second.last_use = m_frame_serial;
			m_stats.texture_hits++;
			return &found->second;
		}
		// The guest wrote these pages since the upload: decode again
		m_retired_views.push_back(found->second.view);
		m_retired_textures.push_back(found->second.texture);
		m_texture_bytes -= found->second.bytes;
		m_textures.erase(found);
		m_stats.texture_invalidations++;
	}

	const bool cube = record.dimension == 2;
	const u32 mip_count = std::max<u32>(record.mip_count, 1);
	WGPUTextureDescriptor descriptor{};
	descriptor.label = sv("RPCS3 RSX texture");
	descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
	descriptor.dimension = record.dimension == 3 ? WGPUTextureDimension_3D : record.dimension == 0 ? WGPUTextureDimension_1D : WGPUTextureDimension_2D;
	descriptor.size = { record.width, record.dimension == 0 ? 1u : record.height, cube ? 6u : (record.dimension == 3 ? std::max<u32>(record.depth, 1) : 1u) };
	descriptor.format = format;
	descriptor.mipLevelCount = record.dimension == 0 ? 1 : mip_count;
	descriptor.sampleCount = 1;
	gpu_texture result{};
	result.texture = wgpuDeviceCreateTexture(m_device, &descriptor);

	const bool swizzled = !(record.format & CELL_GCM_TEXTURE_LN);
	const u32 block_bytes = rsx::get_format_block_size_in_bytes(gcm_format);
	const u32 block_texels = rsx::get_format_block_size_in_texel(gcm_format);
	rsx::texture_uploader_capabilities caps{};
	caps.supports_byteswap = false;
	caps.supports_vtc_decoding = false;
	caps.supports_hw_deswizzle = false;
	caps.supports_zero_copy = false;
	caps.supports_dxt = true;
	caps.alignment = 256;

	// Guest bytes staged contiguously, 16-byte aligned: the decoder casts spans to the block type
	// (DXT3/5 blocks are 16 bytes) and requires natural alignment of pointer and size
	m_guest_staging.resize(utils::align<usz>(size, 16) + 16);
	std::byte* guest_bytes = reinterpret_cast<std::byte*>(utils::align(reinterpret_cast<uptr>(m_guest_staging.data()), 16));
	if (!copy_guest_range(guest_bytes, address, size))
	{
		wgpuTextureRelease(result.texture);
		return nullptr;
	}
	u16 layout_height = record.height, layout_depth = 1;
	u8 layout_layers = 1;
	switch (record.dimension)
	{
	case 0: layout_height = 1; break;
	case 2: layout_layers = 6; break;
	case 3: layout_depth = static_cast<u16>(std::max<u32>(record.depth, 1)); break;
	default: break;
	}
	// The sparse web page table cannot hand out flat guest spans: layouts over the staged copy
	const auto layouts = rsx::get_subresources_layout(guest_bytes, gcm_format,
		static_cast<u16>(record.width), layout_height, layout_depth, layout_layers, static_cast<u16>(mip_count), record.pitch, swizzled, !texture.border_type());
	for (const auto& layout : layouts)
	{
		if (layout.level >= descriptor.mipLevelCount) continue;
		const u32 row_pitch = utils::align(layout.width_in_block * block_bytes, 256u);
		const usz bytes = static_cast<usz>(row_pitch) * layout.height_in_block * std::max<u16>(layout.depth, 1);
		m_decode_staging.resize(utils::align<usz>(bytes, 16) + 16);
		std::byte* staging_bytes = reinterpret_cast<std::byte*>(utils::align(reinterpret_cast<uptr>(m_decode_staging.data()), 16));
		std::span<std::byte> staging_span(staging_bytes, bytes);
		rsx::io_buffer buffer(staging_span);
		rsx::upload_texture_subresource(buffer, layout, gcm_format, swizzled, caps);
		WGPUTexelCopyTextureInfo destination{ result.texture, layout.level, { 0, 0, layout.layer }, WGPUTextureAspect_All };
		WGPUTexelCopyBufferLayout data_layout{ 0, row_pitch, layout.height_in_block };
		const u32 mip_width = std::max<u32>(record.width >> layout.level, 1);
		const u32 mip_height = std::max<u32>(record.height >> layout.level, 1);
		WGPUExtent3D extent{ std::min<u32>(mip_width, layout.width_in_block * block_texels), std::min<u32>(mip_height, layout.height_in_block * block_texels),
			record.dimension == 3 ? std::max<u32>(layout.depth, 1) : 1u };
		wgpuQueueWriteTexture(m_queue, &destination, staging_bytes, bytes, &data_layout, &extent);
		result.bytes += static_cast<u32>(bytes);
	}

	static const WGPUTextureViewDimension view_dimensions[4] = { WGPUTextureViewDimension_1D, WGPUTextureViewDimension_2D, WGPUTextureViewDimension_Cube, WGPUTextureViewDimension_3D };
	WGPUTextureViewDescriptor view_descriptor{};
	view_descriptor.format = format;
	view_descriptor.dimension = view_dimensions[record.dimension & 3];
	view_descriptor.mipLevelCount = descriptor.mipLevelCount;
	view_descriptor.arrayLayerCount = cube ? 6 : 1;
	view_descriptor.aspect = WGPUTextureAspect_All;
	result.view = wgpuTextureCreateView(result.texture, &view_descriptor);
	result.last_use = m_frame_serial;
	result.version = version;
	m_texture_bytes += result.bytes;
	m_stats.texture_uploads++;

	// Budget: retire the least recently used uploads beyond 512 MiB
	if (m_texture_bytes > (512ull << 20))
	{
		for (auto it = m_textures.begin(); it != m_textures.end() && m_texture_bytes > (384ull << 20);)
		{
			if (it->second.last_use + 2 < m_frame_serial)
			{
				m_retired_views.push_back(it->second.view);
				m_retired_textures.push_back(it->second.texture);
				m_texture_bytes -= it->second.bytes;
				it = m_textures.erase(it);
			}
			else
			{
				++it;
			}
		}
	}
	return &m_textures.emplace(key, result).first->second;
}

WebGPUDirectGSRender::sampled_texture WebGPUDirectGSRender::resolve_texture(const rsx::fragment_texture& texture, u32 slot)
{
	sampled_texture result{};
	rsx::webgpu::texture_packet_record record{};
	u32 address = 0;
	u32 size = 0;
	if (!rsx::webgpu::describe_fragment_texture(texture, slot, record, address, size))
	{
		// A referenced but disabled sampler binds RPCS3's null image
		result.view = null_texture_view(1);
		result.sampler = null_sampler();
		result.dimension = 1;
		return result;
	}
	result.dimension = static_cast<u8>(record.dimension & 3);
	const u32 gcm_format = record.format & ~(CELL_GCM_TEXTURE_LN | CELL_GCM_TEXTURE_UN);

	// Render targets of the store as textures: whole surfaces, row-aligned sub-rectangles and 3D
	// slice stacks (the texture cache's surface path), before any guest-memory upload
	if ((result.dimension == 1 || result.dimension == 3) && alias_surface_texture(record, address, gcm_format, result))
	{
		m_stats.surface_hits++;
		return result;
	}

	if (auto uploaded = upload_texture(texture, record, address, size))
	{
		result.view = uploaded->view;
		result.sampler = get_sampler(record.address_modes, record.filter_modes, record.mip_count);
		result.swizzle = compose_swizzle(texture_native_map(gcm_format), record.remap);
		return result;
	}

	m_stats.unsupported++;
	result.view = null_texture_view(result.dimension);
	result.sampler = null_sampler();
	return result;
}

void WebGPUDirectGSRender::release_surface_copies(gpu_surface& surface)
{
	for (auto& [key, region] : surface.regions)
	{
		m_retired_views.push_back(region.view);
		m_retired_textures.push_back(region.texture);
	}
	surface.regions.clear();
	if (surface.scratch.texture)
	{
		m_retired_views.push_back(surface.scratch.view);
		m_retired_textures.push_back(surface.scratch.texture);
		surface.scratch = {};
	}
}

bool WebGPUDirectGSRender::alias_surface_texture(const rsx::webgpu::texture_packet_record& record, u32 address, u32 gcm_format, sampled_texture& result)
{
	// vk::get_compatible_sampler_format of the texture must be the surface's image format
	const WGPUTextureFormat expected = texture_format(gcm_format);
	if (expected == WGPUTextureFormat_Undefined) return false;
	const u32 depth = record.dimension == 3 ? std::max<u32>(record.depth, 1) : 1;

	gpu_surface* hit = nullptr;
	u32 hit_id = 0;
	u32 row_offset = 0;
	m_rtts.for_each_overlapping(rsx::address_range32::start_length(address, 1), [&](rsx::webgpu::render_target* surface)
	{
		if (hit || surface->is_depth_surface()) return;
		auto image = surface_by_id(surface->id);
		if (!image || image->format != expected || !image->pitch) return;
		// texture_cache_helpers::check_framebuffer_resource compares in rsx::surface_metrics::samples
		const u32 sample_width = image->surface_width * image->samples_x;
		const u32 sample_height = image->surface_height * image->samples_y;
		const u64 span = static_cast<u64>(image->pitch) * sample_height;
		if (address < image->address || address >= image->address + span) return;
		const u32 offset = address - image->address;
		if (offset % image->pitch != 0) return;
		// rsx::pitch_compatible: a single-row texture matches any pitch, otherwise pitches must agree
		if (record.pitch && record.height != 1 && record.pitch != image->pitch) return;
		const u32 row = offset / image->pitch;
		if (record.width > sample_width || row + record.height * depth > sample_height) return;
		hit = image;
		hit_id = surface->id;
		row_offset = row;
	});
	if (!hit) return false;

	result.sampler = get_sampler(record.address_modes, record.filter_modes, 1);
	result.swizzle = compose_swizzle(surface_native_map(hit->rsx_format), record.remap);
	const bool whole = row_offset == 0 && depth == 1 && record.width == hit->surface_width * hit->samples_x && record.height == hit->surface_height * hit->samples_y;

	// A target of this very draw cannot be bound as a texture of the same pass: sample a scratch copy
	bool cyclic = false;
	for (const auto& bound : m_rtts.m_bound_render_targets)
	{
		if (bound.second && bound.second->id == hit_id) cyclic = true;
	}
	if (whole && !cyclic)
	{
		result.view = hit->view;
		return true;
	}

	end_pass();
	if (whole)
	{
		if (!hit->scratch.texture)
		{
			WGPUTextureDescriptor descriptor{};
			descriptor.label = sv("RPCS3 RSX surface scratch");
			descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
			descriptor.dimension = WGPUTextureDimension_2D;
			descriptor.size = { hit->width, hit->height, 1 };
			descriptor.format = hit->format;
			descriptor.mipLevelCount = 1;
			descriptor.sampleCount = 1;
			hit->scratch.texture = wgpuDeviceCreateTexture(m_device, &descriptor);
			hit->scratch.view = wgpuTextureCreateView(hit->scratch.texture, nullptr);
			hit->scratch.width = hit->width;
			hit->scratch.height = hit->height;
		}
		WGPUTexelCopyTextureInfo src{ hit->texture, 0, { 0, 0, 0 }, WGPUTextureAspect_All };
		WGPUTexelCopyTextureInfo dst{ hit->scratch.texture, 0, { 0, 0, 0 }, WGPUTextureAspect_All };
		WGPUExtent3D extent{ hit->width, hit->height, 1 };
		wgpuCommandEncoderCopyTextureToTexture(encoder(), &src, &dst, &extent);
		result.view = hit->scratch.view;
		return true;
	}

	// Rows and sizes are guest samples; the copy is taken in image pixels scaled like the surface
	const f32 scale_x = static_cast<f32>(hit->width) / hit->surface_width;
	const f32 scale_y = static_cast<f32>(hit->height) / hit->surface_height;
	const u32 region_width = std::max<u32>(1, static_cast<u32>(std::lround((static_cast<f32>(record.width) / hit->samples_x) * scale_x)));
	const u32 region_height = std::max<u32>(1, static_cast<u32>(std::lround((static_cast<f32>(record.height) / hit->samples_y) * scale_y)));
	const u32 region_row = static_cast<u32>(std::lround((static_cast<f32>(row_offset) / hit->samples_y) * scale_y));
	const std::string key = fmt::format("%u:%ux%ux%u", row_offset, record.width, record.height, depth);
	auto& region = hit->regions[key];
	if (region.texture && (region.width != region_width || region.height != region_height || region.depth != depth))
	{
		m_retired_views.push_back(region.view);
		m_retired_textures.push_back(region.texture);
		region = {};
	}
	if (!region.texture)
	{
		WGPUTextureDescriptor descriptor{};
		descriptor.label = sv("RPCS3 RSX surface region");
		descriptor.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
		descriptor.dimension = depth > 1 ? WGPUTextureDimension_3D : WGPUTextureDimension_2D;
		descriptor.size = { region_width, region_height, depth };
		descriptor.format = hit->format;
		descriptor.mipLevelCount = 1;
		descriptor.sampleCount = 1;
		region.texture = wgpuDeviceCreateTexture(m_device, &descriptor);
		WGPUTextureViewDescriptor view_descriptor{};
		view_descriptor.format = hit->format;
		view_descriptor.dimension = depth > 1 ? WGPUTextureViewDimension_3D : WGPUTextureViewDimension_2D;
		view_descriptor.mipLevelCount = 1;
		view_descriptor.arrayLayerCount = 1;
		view_descriptor.aspect = WGPUTextureAspect_All;
		region.view = wgpuTextureCreateView(region.texture, &view_descriptor);
		region.width = region_width;
		region.height = region_height;
		region.depth = depth;
	}
	region.row = region_row;
	for (u32 slice = 0; slice < depth; slice++)
	{
		const u32 source_row = region_row + slice * region_height;
		if (source_row + region_height > hit->height || region_width > hit->width) break;
		WGPUTexelCopyTextureInfo src{ hit->texture, 0, { 0, source_row, 0 }, WGPUTextureAspect_All };
		WGPUTexelCopyTextureInfo dst{ region.texture, 0, { 0, 0, slice }, WGPUTextureAspect_All };
		WGPUExtent3D extent{ region_width, region_height, 1 };
		wgpuCommandEncoderCopyTextureToTexture(encoder(), &src, &dst, &extent);
	}
	result.view = region.view;
	return true;
}

// ---------------------------------------------------------------------------------------------
// RSX thread entry points

void WebGPUDirectGSRender::begin()
{
	rsx::thread::begin();
	if (skip_current_frame || cond_render_ctrl.disable_rendering())
	{
		return;
	}
	prepare_rtts(rsx::framebuffer_creation_context::context_draw);
}

void WebGPUDirectGSRender::end()
{
	if (skip_current_frame || !m_ready || !m_graphics_state.test(rsx::rtt_config_valid) || cond_render_ctrl.disable_rendering())
	{
		execute_nop_draw();
		rsx::thread::end();
		return;
	}

	analyse_current_rsx_pipeline();
	if (!current_fp_metadata.referenced_textures_mask)
	{
		get_current_fragment_program(fs_sampler_state);
	}
	if (!current_vp_metadata.referenced_textures_mask)
	{
		get_current_vertex_program(vs_sampler_state);
	}

	// Apply write memory barriers (VKGSRender::end), then the read barriers of sampled surfaces
	if (auto ds = std::get<1>(m_rtts.m_bound_depth_stencil)) ds->write_barrier(m_surface_ops);
	for (auto& rtt : m_rtts.m_bound_render_targets)
	{
		if (auto surface = std::get<1>(rtt)) surface->write_barrier(m_surface_ops);
	}
	read_barrier_sampled_surfaces();
	apply_surface_ops();

	const targets targets = bound_targets();
	if (targets.colors.empty() && !targets.depth)
	{
		m_stats.draws_skipped++;
		execute_nop_draw();
		rsx::thread::end();
		return;
	}

	// Textures of this draw (the program key depends on their dimensions and swizzles)
	std::array<sampled_texture, 16> textures{};
	std::array<u8, 16> dimensions{};
	dimensions.fill(0xff);
	for (u32 slot = 0; slot < 16; slot++)
	{
		if (!(current_fp_metadata.referenced_textures_mask & (1u << slot))) continue;
		textures[slot] = resolve_texture(rsx::method_registers.fragment_textures[slot], slot);
		dimensions[slot] = textures[slot].dimension;
	}

	rsx::webgpu::resolved_state_packet state{};
	rsx::webgpu::fill_resolved_state(state, 0, m_framebuffer_layout);
	const u32 alpha_func = state.alpha_test_enabled ? (state.alpha_func & 7) : 0xff;
	const u32 target_count = static_cast<u32>(targets.colors.size());

	// RPCS3's ucode hashes: the fragment hash skips the inline constants, which the draw
	// supplies through the fragment uniform (fragment_program_utils::get_fragment_program_ucode_hash)
	const u64 vp_hash = program_hash_util::vertex_program_utils::get_vertex_program_ucode_hash(current_vertex_program);
	const u64 fp_hash = program_hash_util::fragment_program_utils::get_fragment_program_ucode_hash(current_fragment_program);
	program_key program_id{};
	program_id.vertex_hash = vp_hash;
	program_id.fragment_hash = fp_hash;
	program_id.vertex_entry = current_vertex_program.entry;
	program_id.vertex_ctrl = current_vertex_program.ctrl;
	program_id.output_mask = rsx::method_registers.vertex_attrib_output_mask();
	program_id.shader_control = rsx::method_registers.shader_control();
	program_id.target_count = target_count;
	program_id.alpha_func = alpha_func;
	program_id.dimensions = dimensions;
	for (u32 slot = 0; slot < 16; slot++)
	{
		if (current_fp_metadata.referenced_textures_mask & (1u << slot)) program_id.swizzles[slot] = textures[slot].swizzle;
	}
	gpu_program& program = get_program(program_id, textures);
	if (!program.valid)
	{
		m_stats.draws_skipped++;
		execute_nop_draw();
		rsx::thread::end();
		return;
	}

	if (state.logic_op_enabled)
	{
		// WebGPU has no logic operations
		m_stats.unsupported++;
	}

	auto& clause = rsx::method_registers.current_draw_clause;
	clause.begin();
	u32 subdraw = 0;
	do
	{
		const auto pipeline_state = subdraw == 0 ? rsx::flags32_t{ rsx::vertex_arrays_changed } : rsx::flags32_t{ clause.execute_pipeline_dependencies(m_ctx) };
		subdraw++;
		if (pipeline_state & rsx::vertex_arrays_changed)
		{
			m_draw_processor.analyse_inputs_interleaved(m_vertex_layout, current_vp_metadata);
		}
		else if (pipeline_state & rsx::vertex_base_changed)
		{
			for (auto* block : m_vertex_layout.interleaved_blocks)
			{
				block->vertex_range.second = 0;
				block->real_offset_address = rsx::get_address(rsx::get_vertex_offset_from_base(rsx::method_registers.vertex_data_base_offset(), block->base_offset), block->memory_location);
			}
		}
		if (!m_vertex_layout.validate()) continue;

		const auto command = m_draw_processor.get_draw_command(rsx::method_registers);
		const auto upload = rsx::webgpu::prepare_draw_vertex_upload(m_vertex_layout, command);
		if (!upload.draw_count || !upload.allocated_vertex_count) continue;

		const WGPUPrimitiveTopology topology = primitive_topology(clause.primitive, upload.primitive_expanded);
		if (topology == WGPUPrimitiveTopology_Undefined)
		{
			m_stats.unsupported++;
			continue;
		}
		const WGPUIndexFormat index_format = upload.index_type == rsx::index_array_type::u32 ? WGPUIndexFormat_Uint32 : WGPUIndexFormat_Uint16;
		const bool strip = topology == WGPUPrimitiveTopology_LineStrip || topology == WGPUPrimitiveTopology_TriangleStrip;
		const WGPUIndexFormat strip_index_format = (upload.indexed && strip) ? index_format : WGPUIndexFormat_Undefined;

		// Vertex streams and uniforms (the same RPCS3 draw-processor data the packet backend ships)
		const auto requirements = calculate_memory_requirements(m_vertex_layout, upload.first_vertex, upload.allocated_vertex_count);
		auto& persistent = m_draw_persistent;
		auto& transient = m_draw_transient;
		persistent.resize(requirements.first);
		transient.resize(requirements.second);
		m_draw_processor.write_vertex_data_to_memory(m_vertex_layout, upload.first_vertex, upload.allocated_vertex_count,
			persistent.empty() ? nullptr : persistent.data(), transient.empty() ? nullptr : transient.data());

		auto& vertex_state = m_draw_vertex_state;
		vertex_state.assign(vertex_state_bytes, std::byte{});
		m_draw_processor.fill_scale_offset_data(vertex_state.data(), false);
		m_draw_processor.fill_user_clip_data(vertex_state.data() + 64);
		*reinterpret_cast<u32*>(vertex_state.data() + 68) = rsx::method_registers.transform_branch_bits();
		*reinterpret_cast<f32*>(vertex_state.data() + 72) = rsx::method_registers.point_size() * resolution_scaling_config.scale_factor();
		*reinterpret_cast<f32*>(vertex_state.data() + 76) = rsx::method_registers.clip_min();
		*reinterpret_cast<f32*>(vertex_state.data() + 80) = rsx::method_registers.clip_max();
		m_draw_processor.fill_vertex_program_constants_data(vertex_state.data() + 96, {});
		auto* layout_words = reinterpret_cast<u32*>(vertex_state.data() + 96 + 468 * 16);
		layout_words[0] = upload.vertex_index_base;
		layout_words[1] = upload.vertex_index_offset;
		m_draw_processor.fill_vertex_layout_state(m_vertex_layout, current_vp_metadata, upload.first_vertex, upload.allocated_vertex_count, reinterpret_cast<s32*>(layout_words + 4), 0, 0);

		auto& fragment_state = m_draw_fragment_state;
		fragment_state.assign(fragment_state_bytes, std::byte{});
		m_draw_processor.fill_fragment_state_buffer(fragment_state.data(), current_fragment_program);
		if (program.constant_count)
		{
			const auto offsets = rsx::webgpu::fragment_inline_constant_offsets(current_fragment_program.get_data(), current_fragment_program.ucode_length);
			std::vector<f32> constants(offsets.size() * 4);
			rsx::write_fragment_constants_to_buffer(constants, current_fragment_program, offsets, false);
			std::memcpy(fragment_state.data() + 32, constants.data(), std::min<usz>(constants.size() * 4, fragment_constant_slots * 16));
		}

		const u64 uniform_offset = ring_allocate(m_uniform_ring, vertex_state_stride + fragment_state_stride, WGPUBufferUsage_Uniform, "RPCS3 RSX uniforms");
		ring_write(m_uniform_ring, uniform_offset, vertex_state.data(), vertex_state.size());
		ring_write(m_uniform_ring, uniform_offset + vertex_state_stride, fragment_state.data(), fragment_state.size());
		const u64 persistent_offset = ring_allocate(m_stream_ring, std::max<usz>(persistent.size(), 16), WGPUBufferUsage_Storage, "RPCS3 RSX vertex streams");
		if (!persistent.empty()) ring_write(m_stream_ring, persistent_offset, persistent.data(), persistent.size());
		const u64 transient_offset = ring_allocate(m_stream_ring, std::max<usz>(transient.size(), 16), WGPUBufferUsage_Storage, "RPCS3 RSX vertex streams");
		if (!transient.empty()) ring_write(m_stream_ring, transient_offset, transient.data(), transient.size());
		u64 index_offset = 0;
		if (upload.indexed)
		{
			index_offset = ring_allocate(m_index_ring, upload.indices.size(), WGPUBufferUsage_Index, "RPCS3 RSX indices");
			ring_write(m_index_ring, index_offset, upload.indices.data(), upload.indices.size());
		}

		// Bind group of this draw
		std::vector<WGPUBindGroupEntry> entries;
		auto buffer_entry = [&](u32 binding, WGPUBuffer buffer, u64 offset, u64 size)
		{
			WGPUBindGroupEntry entry{};
			entry.binding = binding;
			entry.buffer = buffer;
			entry.offset = offset;
			entry.size = size;
			entries.push_back(entry);
		};
		buffer_entry(32, m_uniform_ring.buffer, uniform_offset, vertex_state_bytes);
		buffer_entry(34, m_stream_ring.buffer, persistent_offset, utils::align(std::max<usz>(persistent.size(), 16), 16));
		buffer_entry(35, m_stream_ring.buffer, transient_offset, utils::align(std::max<usz>(transient.size(), 16), 16));
		buffer_entry(33, m_uniform_ring.buffer, uniform_offset + vertex_state_stride, fragment_state_bytes);
		for (u32 slot : program.texture_slots)
		{
			WGPUBindGroupEntry view{};
			view.binding = slot * 2;
			view.textureView = textures[slot].view ? textures[slot].view : null_texture_view(program.texture_dimensions[slot]);
			entries.push_back(view);
			WGPUBindGroupEntry sampler{};
			sampler.binding = slot * 2 + 1;
			sampler.sampler = textures[slot].sampler ? textures[slot].sampler : null_sampler();
			entries.push_back(sampler);
		}
		WGPUBindGroupDescriptor group_descriptor{};
		group_descriptor.layout = program.bind_group_layout;
		group_descriptor.entryCount = entries.size();
		group_descriptor.entries = entries.data();
		WGPUBindGroup group = wgpuDeviceCreateBindGroup(m_device, &group_descriptor);

		pipeline_key pipeline_id{};
		pipeline_id.program = &program;
		pipeline_id.formats = targets.formats;
		pipeline_id.topology = static_cast<u32>(topology);
		pipeline_id.index_format = static_cast<u32>(strip_index_format);
		pipeline_id.front_face = state.front_face_mode;
		pipeline_id.cull_face = state.cull_face_enabled ? state.cull_face_mode : 0;
		pipeline_id.depth_state = state.depth_test_enabled | (state.depth_write_enabled << 1) | (state.depth_func << 2);
		pipeline_id.blend_mask = state.blend_enabled_mask;
		pipeline_id.blend_rgb = state.blend_sfactor_rgb | (state.blend_dfactor_rgb << 8) | (state.blend_equation_rgb << 16);
		pipeline_id.blend_alpha = state.blend_sfactor_a | (state.blend_dfactor_a << 8) | (state.blend_equation_a << 16);
		pipeline_id.color_write = state.color_write_mask[0] | (state.color_write_mask[1] << 4) | (state.color_write_mask[2] << 8) | (state.color_write_mask[3] << 12);
		WGPURenderPipeline pipeline = get_pipeline(pipeline_id, program, targets, topology, strip_index_format, state);

		if (m_pass_key != targets.key) begin_pass(targets);
		(void)get_scissor(m_scissor, true);
		const u32 extent_w = targets.colors.empty() ? targets.depth->width : targets.colors[0]->width;
		const u32 extent_h = targets.colors.empty() ? targets.depth->height : targets.colors[0]->height;
		const u32 sx = std::min<u32>(m_scissor.x1, extent_w), sy = std::min<u32>(m_scissor.y1, extent_h);
		const u32 sx2 = std::min<u32>(m_scissor.x2, extent_w), sy2 = std::min<u32>(m_scissor.y2, extent_h);
		if (sx2 <= sx || sy2 <= sy)
		{
			wgpuBindGroupRelease(group);
			continue;
		}
		wgpuRenderPassEncoderSetPipeline(m_pass, pipeline);
		wgpuRenderPassEncoderSetScissorRect(m_pass, sx, sy, sx2 - sx, sy2 - sy);
		if (state.blend_enabled_mask)
		{
			const WGPUColor constant{ state.blend_color[0], state.blend_color[1], state.blend_color[2], state.blend_color[3] };
			wgpuRenderPassEncoderSetBlendConstant(m_pass, &constant);
		}
		wgpuRenderPassEncoderSetBindGroup(m_pass, 0, group, 0, nullptr);
		if (upload.indexed)
		{
			wgpuRenderPassEncoderSetIndexBuffer(m_pass, m_index_ring.buffer, index_format, index_offset, upload.indices.size());
			wgpuRenderPassEncoderDrawIndexed(m_pass, upload.draw_count, 1, 0, 0, 0);
		}
		else
		{
			wgpuRenderPassEncoderDraw(m_pass, upload.draw_count, 1, 0, 0);
		}
		wgpuBindGroupRelease(group);
		m_stats.draws++;
	}
	while (clause.next());

	m_rtts.on_write(m_framebuffer_layout.color_write_enabled, m_framebuffer_layout.zeta_write_enabled);
	rsx::thread::end();
}

void WebGPUDirectGSRender::clear_surface(u32 mask)
{
	if (skip_current_frame || !m_ready || !(mask & RSX_GCM_CLEAR_ANY_MASK))
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
			if (ds->state_flags & rsx::surface_state_flags::erase_bkgnd && ds->old_contents.empty() && !g_cfg.video.read_depth_buffer)
			{
				const auto ds_mask = (mask & RSX_GCM_CLEAR_DEPTH_STENCIL_MASK);
				if (ds_mask == RSX_GCM_CLEAR_DEPTH_BIT && (aspect & stencil_aspect)) m_clear_initialize_stencil = true;
				else if (ds_mask == RSX_GCM_CLEAR_STENCIL_BIT) m_clear_initialize_depth = true;
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

	// Execute: resolved clear values (the same helpers the Vulkan backend uses) as a masked draw
	rsx::webgpu::resolved_state_packet state{};
	rsx::webgpu::fill_resolved_state(state, mask, m_framebuffer_layout);
	if (m_clear_initialize_depth) { state.clear_mask |= RSX_GCM_CLEAR_DEPTH_BIT; state.clear_depth = 1.f; }
	if (m_clear_initialize_stencil) { state.clear_mask |= RSX_GCM_CLEAR_STENCIL_BIT; state.clear_stencil = 0xff; }
	m_clear_initialize_depth = m_clear_initialize_stencil = false;

	apply_surface_ops();
	const targets targets = bound_targets();
	if (targets.colors.empty() && !targets.depth) return;
	u32 write_mask = 0;
	if (state.clear_mask & RSX_GCM_CLEAR_RED_BIT) write_mask |= WGPUColorWriteMask_Red;
	if (state.clear_mask & RSX_GCM_CLEAR_GREEN_BIT) write_mask |= WGPUColorWriteMask_Green;
	if (state.clear_mask & RSX_GCM_CLEAR_BLUE_BIT) write_mask |= WGPUColorWriteMask_Blue;
	if (state.clear_mask & RSX_GCM_CLEAR_ALPHA_BIT) write_mask |= WGPUColorWriteMask_Alpha;
	const bool depth_write = (state.clear_mask & RSX_GCM_CLEAR_DEPTH_BIT) && targets.depth;
	if (write_mask == 0 && !depth_write) return;
	const u32 extent_w = targets.colors.empty() ? targets.depth->width : targets.colors[0]->width;
	const u32 extent_h = targets.colors.empty() ? targets.depth->height : targets.colors[0]->height;
	const u32 sx = std::min<u32>(m_scissor.x1, extent_w), sy = std::min<u32>(m_scissor.y1, extent_h);
	const u32 sx2 = std::min<u32>(m_scissor.x2, extent_w), sy2 = std::min<u32>(m_scissor.y2, extent_h);
	if (sx2 <= sx || sy2 <= sy) return;

	const u64 offset = ring_allocate(m_uniform_ring, 32, WGPUBufferUsage_Uniform, "RPCS3 RSX uniforms");
	const f32 values[8] = { state.clear_color[0], state.clear_color[1], state.clear_color[2], state.clear_color[3],
		(state.clear_mask & RSX_GCM_CLEAR_DEPTH_BIT) ? state.clear_depth : 1.f, 0.f, 0.f, 0.f };
	ring_write(m_uniform_ring, offset, values, sizeof(values));
	WGPURenderPipeline pipeline = get_clear_pipeline(targets, write_mask, depth_write);
	WGPUBindGroupEntry entry{};
	entry.binding = 0;
	entry.buffer = m_uniform_ring.buffer;
	entry.offset = offset;
	entry.size = 32;
	WGPUBindGroupDescriptor group_descriptor{};
	group_descriptor.layout = m_clear_layout;
	group_descriptor.entryCount = 1;
	group_descriptor.entries = &entry;
	WGPUBindGroup group = wgpuDeviceCreateBindGroup(m_device, &group_descriptor);
	if (m_pass_key != targets.key) begin_pass(targets);
	wgpuRenderPassEncoderSetPipeline(m_pass, pipeline);
	wgpuRenderPassEncoderSetScissorRect(m_pass, sx, sy, sx2 - sx, sy2 - sy);
	wgpuRenderPassEncoderSetBindGroup(m_pass, 0, group, 0, nullptr);
	wgpuRenderPassEncoderDraw(m_pass, 3, 1, 0, 0);
	wgpuBindGroupRelease(group);
	m_stats.clears++;
}

void WebGPUDirectGSRender::flip(const rsx::display_flip_info_t& info)
{
	if (m_ready && !info.skip_frame)
	{
		gpu_surface* display = nullptr;
		if (info.buffer < display_buffers_count)
		{
			const auto& buffer = display_buffers[info.buffer];
			const u32 address = rsx::get_address(buffer.offset, CELL_GCM_LOCATION_LOCAL);
			if (auto surface = m_rtts.get_surface_at(address); surface && !surface->is_depth_surface())
			{
				surface->read_barrier(m_surface_ops);
				apply_surface_ops();
				display = surface_by_id(surface->id);
			}
		}
		end_pass();

		WGPUSurfaceTexture surface_texture{};
		wgpuSurfaceGetCurrentTexture(m_surface, &surface_texture);
		if (surface_texture.texture)
		{
			WGPUTextureView view = wgpuTextureCreateView(surface_texture.texture, nullptr);
			WGPURenderPassColorAttachment attachment{};
			attachment.view = view;
			attachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
			attachment.loadOp = WGPULoadOp_Clear;
			attachment.storeOp = WGPUStoreOp_Store;
			attachment.clearValue = WGPUColor{ 0, 0, 0, 1 };
			WGPURenderPassDescriptor pass_descriptor{};
			pass_descriptor.colorAttachmentCount = 1;
			pass_descriptor.colorAttachments = &attachment;
			WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder(), &pass_descriptor);
			if (display)
			{
				// Present: the display buffer blitted into the canvas texture, nearest filtered
				const u64 rect_offset = ring_allocate(m_uniform_ring, 16, WGPUBufferUsage_Uniform, "RPCS3 RSX uniforms");
				const f32 rect[4] = { 0.f, 0.f, 1.f, 1.f };
				ring_write(m_uniform_ring, rect_offset, rect, sizeof(rect));
				WGPURenderPipeline pipeline = get_blit_pipeline(WGPUTextureFormat_BGRA8Unorm, false);
				std::array<WGPUBindGroupEntry, 3> entries{};
				entries[0].binding = 0; entries[0].textureView = display->view;
				entries[1].binding = 1; entries[1].sampler = m_nearest_sampler;
				entries[2].binding = 2; entries[2].buffer = m_uniform_ring.buffer; entries[2].offset = rect_offset; entries[2].size = 16;
				WGPUBindGroupDescriptor group_descriptor{};
				group_descriptor.layout = m_blit_layout;
				group_descriptor.entryCount = 3;
				group_descriptor.entries = entries.data();
				WGPUBindGroup group = wgpuDeviceCreateBindGroup(m_device, &group_descriptor);
				wgpuRenderPassEncoderSetPipeline(pass, pipeline);
				wgpuRenderPassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
				wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
				wgpuBindGroupRelease(group);
			}
			wgpuRenderPassEncoderEnd(pass);
			wgpuRenderPassEncoderRelease(pass);
			wgpuTextureViewRelease(view);
			wgpuTextureRelease(surface_texture.texture);
			submit();
			rpcs3_web_direct_present(static_cast<u32>(m_presented));
			m_presented++;
		}
		else
		{
			rsx_log.error("WebGPU direct: wgpuSurfaceGetCurrentTexture status %d", static_cast<int>(surface_texture.status));
			submit();
		}
	}

	rsx::webgpu::set_current_frame_id(rsx::webgpu::current_frame_id() + 1);
	m_rtts.trim(m_surface_ops, rsx::problem_severity::low);

	// The host frame counter is what the runtime worker waits on for frame pacing
	rsx::webgpu::host_command_queue().note_flip();

	if (m_frame)
	{
		m_frame->flip(m_context, info.skip_frame);
	}

	rsx::thread::flip(info);
}
