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
		// Copies a draw samples: sub-rectangles / 3D slice stacks (texture_cache _3d_gather) and the
		// scratch copy of a target sampled while bound (cyclic reference)
		struct region
		{
			WGPUTexture texture = nullptr;
			WGPUTextureView view = nullptr;
			u32 width = 0;
			u32 height = 0;
			u32 depth = 0;
			u32 row = 0;
		};
		std::unordered_map<std::string, region> regions;
		region scratch;
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
		u64 version = 0; // vm::web_page_version_sum of the guest pages at upload
	};

	struct ring_buffer
	{
		WGPUBuffer buffer = nullptr;
		u64 size = 0;
		u64 offset = 0;
		u64 flushed = 0;                 // staged bytes below this offset already reached the buffer
		std::vector<std::byte> staging;  // this frame's contents, written to the buffer at submit
	};

	// Cache keys are plain data hashed by their bytes: a draw looks up a program and a pipeline, and
	// building a formatted string for each of those lookups costs more than the lookup. Every key is
	// value-initialized so its padding hashes and compares as zero.
	struct target_key
	{
		std::array<u32, 4> colors{};  // surface ids, 0 where unbound
		u32 depth = 0;
		bool operator==(const target_key&) const = default;
	};

	struct format_key
	{
		std::array<WGPUTextureFormat, 4> colors{ WGPUTextureFormat_Undefined, WGPUTextureFormat_Undefined,
			WGPUTextureFormat_Undefined, WGPUTextureFormat_Undefined };
		WGPUTextureFormat depth = WGPUTextureFormat_Undefined;
		bool operator==(const format_key&) const = default;
	};

	struct program_key
	{
		u64 vertex_hash = 0;
		u64 fragment_hash = 0;
		u32 vertex_entry = 0;
		u32 vertex_ctrl = 0;
		u32 output_mask = 0;
		u32 shader_control = 0;
		u32 target_count = 0;
		u32 alpha_func = 0;
		std::array<u8, 16> dimensions{};
		std::array<std::array<char, 4>, 16> swizzles{};
		bool operator==(const program_key&) const = default;
	};

	struct pipeline_key
	{
		const gpu_program* program = nullptr;
		format_key formats{};
		u32 topology = 0;
		u32 index_format = 0;
		u32 front_face = 0;
		u32 cull_face = 0;
		u32 depth_state = 0;
		u32 blend_mask = 0;
		u32 blend_rgb = 0;
		u32 blend_alpha = 0;
		u32 color_write = 0;
		bool operator==(const pipeline_key&) const = default;
	};

	struct clear_pipeline_key
	{
		format_key formats{};
		u32 write_mask = 0;
		u32 depth_write = 0;
		bool operator==(const clear_pipeline_key&) const = default;
	};

	// FNV-1a over the key's bytes; every key is a trivially copyable aggregate
	template <typename Key>
	struct byte_hash
	{
		usz operator()(const Key& key) const noexcept
		{
			const auto* bytes = reinterpret_cast<const u8*>(&key);
			u64 hash = 0xcbf29ce484222325ull;
			for (usz i = 0; i < sizeof(Key); i++) hash = (hash ^ bytes[i]) * 0x100000001b3ull;
			return static_cast<usz>(hash);
		}
	};

	struct targets
	{
		std::vector<gpu_surface*> colors;
		gpu_surface* depth = nullptr;
		target_key key;
		format_key formats;
	};

	struct sampled_texture
	{
		WGPUTextureView view = nullptr;
		WGPUSampler sampler = nullptr;
		std::array<char, 4> swizzle{ 'r', 'g', 'b', 'a' };
		u8 dimension = 1;
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
	void ring_write(ring_buffer& ring, u64 offset, const void* data, usz size);
	void flush_ring(ring_buffer& ring);

	// Programs, pipelines, samplers, textures
	gpu_program& get_program(const program_key& key, const std::array<sampled_texture, 16>& textures);
	WGPURenderPipeline get_pipeline(const pipeline_key& key, const gpu_program& program, const targets& targets, WGPUPrimitiveTopology topology,
		WGPUIndexFormat strip_index_format, const rsx::webgpu::resolved_state_packet& state);
	WGPUSampler get_sampler(u32 address_modes, u32 filter_modes, u32 mip_count);
	WGPUTextureView null_texture_view(u8 dimension);
	WGPUSampler null_sampler();
	WGPURenderPipeline get_clear_pipeline(const targets& targets, u32 write_mask, bool depth_write);
	WGPURenderPipeline get_blit_pipeline(WGPUTextureFormat format, bool depth);

	// Resolves a fragment texture: a surface of the store (whole match), else an upload
	sampled_texture resolve_texture(const rsx::fragment_texture& texture, u32 slot);
	gpu_texture* upload_texture(const rsx::fragment_texture& texture, const rsx::webgpu::texture_packet_record& record, u32 address, u32 size);
	// texture_cache::upload_texture surface path (check_framebuffer_resource): a texture over a row of a colour surface
	bool alias_surface_texture(const rsx::webgpu::texture_packet_record& record, u32 address, u32 gcm_format, sampled_texture& result);
	void release_surface_copies(gpu_surface& surface);

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
	target_key m_pass_key;
	ring_buffer m_uniform_ring;
	ring_buffer m_stream_ring;
	ring_buffer m_index_ring;
	u64 m_frame_serial = 0;
	std::vector<std::byte> m_draw_persistent, m_draw_transient, m_draw_vertex_state, m_draw_fragment_state;

	std::unordered_map<program_key, gpu_program, byte_hash<program_key>> m_programs;
	std::unordered_map<pipeline_key, WGPURenderPipeline, byte_hash<pipeline_key>> m_pipelines;
	std::unordered_map<u64, WGPUSampler> m_samplers;
	std::unordered_map<u64, gpu_texture> m_textures;
	std::vector<std::byte> m_guest_staging;   // contiguous copy of a texture's guest bytes (16-byte aligned inside)
	std::vector<std::byte> m_decode_staging;  // decoded subresource rows for wgpuQueueWriteTexture
	u64 m_texture_bytes = 0;
	std::array<WGPUTextureView, 4> m_null_views{};
	WGPUSampler m_null_sampler = nullptr;
	std::unordered_map<clear_pipeline_key, WGPURenderPipeline, byte_hash<clear_pipeline_key>> m_clear_pipelines;
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
		u64 texture_invalidations = 0;
		u64 texture_hits = 0;
		u64 surface_hits = 0;
		u64 surface_ops = 0;
		u64 translation_failures = 0;
		u64 unsupported = 0;
	};
	stats m_stats;
};
