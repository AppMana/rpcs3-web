#pragma once

// RSX backend calling WebGPU directly from the RSX thread through emdawnwebgpu.
//
// The pthread worker hosting the RSX thread creates the device and receives the
// presentation OffscreenCanvas before the thread starts (web/host/rpcs3_web_pre.js),
// so this thread never waits on a WebGPU future: the device is imported
// synchronously, buffers are written rather than mapped, and every flip hands the
// canvas contents to the page with transferToImageBitmap without an event-loop turn.
//
// Render targets are RPCS3's surface store (WebGPURenderTargets.h); the ops it
// emits are executed here against WGPUTextures. Programs are translated to WGSL by
// the browser-side translator (rpcs3-webgpu-renderer.mjs) the worker loaded.

#include "Emu/RSX/GSRender.h"
#include "WebGPURenderTargets.h"
#include "WebGPUCommand.h"

#include <webgpu/webgpu.h>

#include <array>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

class WebGPUDirectGSRender : public GSRender
{
public:
	explicit WebGPUDirectGSRender(utils::serial* ar) noexcept;
	WebGPUDirectGSRender() noexcept : WebGPUDirectGSRender(nullptr) {}
	~WebGPUDirectGSRender() override;

	u64 get_cycles() final;

	struct gpu_surface
	{
		WGPUTexture texture = nullptr;
		WGPUTextureView view = nullptr;
		WGPUTextureFormat format = WGPUTextureFormat_Undefined;
		u32 width = 0;
		u32 height = 0;
		bool depth = false;
		u32 host_format = 0;
		// Guest placement (describe op): pixels, sample factors, address, pitch, RSX format
		u32 surface_width = 0;
		u32 surface_height = 0;
		u32 samples_x = 1;
		u32 samples_y = 1;
		u32 address = 0;
		u32 pitch = 0;
		u32 rsx_format = 0;
	};

	struct gpu_program
	{
		WGPUShaderModule module = nullptr;
		WGPUBindGroupLayout bind_group_layout = nullptr;
		WGPUPipelineLayout pipeline_layout = nullptr;
		std::vector<u32> texture_slots;
		std::array<u8, 16> texture_dimensions{};
		u32 constant_count = 0;
		bool valid = false;
	};

	struct gpu_texture
	{
		WGPUTexture texture = nullptr;
		WGPUTextureView view = nullptr;
		u32 bytes = 0;
		u64 last_use = 0;
	};

	struct ring_buffer
	{
		WGPUBuffer buffer = nullptr;
		u64 size = 0;
		u64 offset = 0;
	};

	struct targets
	{
		std::vector<gpu_surface*> colors;
		gpu_surface* depth = nullptr;
		std::string key;
		std::string format_key;
	};

private:
	void on_init_thread() override;
	void on_exit() override;
	void begin() override;
	void end() override;
	void clear_surface(u32 mask) override;
	void flip(const rsx::display_flip_info_t& info) override;

	bool configure_surface();
	void prepare_rtts(rsx::framebuffer_creation_context context);
	void read_barrier_sampled_surfaces();

	// Surface store ops (create/describe/destroy/erase/copy) executed against gpu_surfaces
	void apply_surface_ops();
	void erase_surface(gpu_surface& surface);
	void copy_surface(gpu_surface& source, gpu_surface& target, u32 sx1, u32 sy1, u32 sx2, u32 sy2, u32 dx1, u32 dy1, u32 dx2, u32 dy2);
	gpu_surface* surface_by_id(u32 id);
	targets bound_targets();

	// Frame command stream
	WGPUCommandEncoder encoder();
	void begin_pass(const targets& targets);
	void end_pass();
	void submit();
	u64 ring_allocate(ring_buffer& ring, u64 bytes, WGPUBufferUsage usage, const char* label);

	// Programs, pipelines, samplers, textures
	gpu_program& get_program(const std::string& key, const std::array<u8, 16>& dimensions, u32 color_target_count, u32 alpha_func, const std::string& swizzles);
	WGPURenderPipeline get_pipeline(const std::string& key, const gpu_program& program, const targets& targets, WGPUPrimitiveTopology topology,
		WGPUIndexFormat strip_index_format, const rsx::webgpu::resolved_state_packet& state);
	WGPUSampler get_sampler(u32 address_modes, u32 filter_modes, u32 mip_count);
	WGPUTextureView null_texture_view(u8 dimension);
	WGPUSampler null_sampler();
	WGPURenderPipeline get_clear_pipeline(const targets& targets, u32 write_mask, bool depth_write);
	WGPURenderPipeline get_blit_pipeline(WGPUTextureFormat format, bool depth);

	struct sampled_texture
	{
		WGPUTextureView view = nullptr;
		WGPUSampler sampler = nullptr;
		std::string swizzle = "rgba";
		u8 dimension = 1;
	};
	// Resolves a fragment texture: a surface of the store (whole match), else an upload
	sampled_texture resolve_texture(const rsx::fragment_texture& texture, u32 slot);
	gpu_texture* upload_texture(const rsx::fragment_texture& texture, const rsx::webgpu::texture_packet_record& record, u32 address, u32 size);

	WGPUInstance m_instance = nullptr;
	WGPUDevice m_device = nullptr;
	WGPUQueue m_queue = nullptr;
	WGPUSurface m_surface = nullptr;
	u32 m_surface_width = 0;
	u32 m_surface_height = 0;
	u64 m_presented = 0;
	bool m_ready = false;

	rsx::vertex_input_layout m_vertex_layout;
	areau m_scissor{};
	rsx::webgpu::surface_command_list m_surface_ops;
	rsx::webgpu::surface_cache m_rtts;
	rsx::framebuffer_creation_context m_current_framebuffer_context = rsx::framebuffer_creation_context::context_draw;
	bool m_rtts_bound = false;
	bool m_clear_initialize_depth = false;
	bool m_clear_initialize_stencil = false;

	std::unordered_map<u32, gpu_surface> m_surfaces;
	std::vector<WGPUTexture> m_retired_textures;
	std::vector<WGPUTextureView> m_retired_views;
	std::vector<WGPUBuffer> m_retired_buffers;

	WGPUCommandEncoder m_encoder = nullptr;
	WGPURenderPassEncoder m_pass = nullptr;
	std::string m_pass_key;
	ring_buffer m_uniform_ring;
	ring_buffer m_stream_ring;
	ring_buffer m_index_ring;
	u64 m_frame_serial = 0;

	std::unordered_map<std::string, gpu_program> m_programs;
	std::unordered_map<std::string, WGPURenderPipeline> m_pipelines;
	std::unordered_map<u64, WGPUSampler> m_samplers;
	std::unordered_map<u64, gpu_texture> m_textures;
	u64 m_texture_bytes = 0;
	std::array<WGPUTextureView, 4> m_null_views{};
	WGPUSampler m_null_sampler = nullptr;
	std::unordered_map<std::string, WGPURenderPipeline> m_clear_pipelines;
	WGPUBindGroupLayout m_clear_layout = nullptr;
	std::unordered_map<u32, WGPURenderPipeline> m_blit_pipelines;
	WGPUBindGroupLayout m_blit_layout = nullptr;
	WGPUBindGroupLayout m_depth_blit_layout = nullptr;
	WGPUSampler m_nearest_sampler = nullptr;

	// Diagnostics counters (rpcs3_web_direct_stats)
public:
	struct stats
	{
		u64 draws = 0;
		u64 draws_skipped = 0;
		u64 clears = 0;
		u64 programs = 0;
		u64 pipelines = 0;
		u64 texture_uploads = 0;
		u64 texture_hits = 0;
		u64 surface_hits = 0;
		u64 surface_ops = 0;
		u64 translation_failures = 0;
		u64 unsupported = 0;
	};
	stats m_stats;
};
