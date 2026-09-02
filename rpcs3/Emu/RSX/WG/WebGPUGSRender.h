#pragma once

#include <unordered_map>
#include <list>
#include <deque>

#include "Emu/RSX/GSRender.h"
#include "WebGPURenderTargets.h"
#include "Emu/RSX/Core/RSXVertexTypes.h"
#include "WebGPUCommand.h"

#include <cstdint>
#include <vector>

class WebGPUGSRender : public GSRender
{
public:
	explicit WebGPUGSRender(utils::serial* ar) noexcept;
	WebGPUGSRender() noexcept : WebGPUGSRender(nullptr) {}

	u64 get_cycles() final;

private:
	void begin() override;
	void end() override;
	void clear_surface(u32 mask) override;
	void flip(const rsx::display_flip_info_t& info) override;
	void on_init_thread() override;
	void on_exit() override;

	// VKGSRender::prepare_rtts: bind the framebuffer layout's surfaces through RPCS3's surface store
	void prepare_rtts(rsx::framebuffer_creation_context context);
	// Surfaces the referenced fragment textures alias get their memory barriers before the draw
	void read_barrier_sampled_surfaces();

	bool emit_draw_packet(u32 subdraw);
	void emit_control_packet(rsx::webgpu::packet_kind kind, u32 value, u32 flags = 0);
	void fill_resolved_state(rsx::webgpu::resolved_state_packet& state, u32 clear_mask) const;

	rsx::vertex_input_layout m_vertex_layout;
	areau m_scissor{};
	// Surface store effects not yet shipped (declared before the store so it outlives it)
	rsx::webgpu::surface_command_list m_surface_ops;
	rsx::webgpu::surface_cache m_rtts;
	rsx::framebuffer_creation_context m_current_framebuffer_context = rsx::framebuffer_creation_context::context_draw;
	bool m_rtts_bound = false;
	// VKGSRender::clear_surface: a partial depth-stencil clear of an uninitialized surface initializes the other aspect
	bool m_clear_initialize_depth = false;
	bool m_clear_initialize_stencil = false;
	// Textures the renderer currently holds (payload delivered earlier and not yet evicted).
	// The builder decides eviction (LRU under a byte budget) and tells the renderer through
	// stage-2 texture records, so both sides agree on residency without a return channel.
public:
	struct texture_residency
	{
		struct entry
		{
			rsx::webgpu::texture_packet_record record;
			u32 bytes = 0;
			std::list<u64>::iterator lru;
		};
		std::unordered_map<u64, entry> entries;
		std::list<u64> lru;
		u64 bytes = 0;
		u64 budget = 384ull << 20;
	};
	// The renderer reports a referenced texture whose payload it never received (its packet was
	// dropped or skipped); the builder forgets it so the next reference carries the payload again.
	void forget_texture(const rsx::webgpu::texture_packet_record& key);
	void forget_texture_keys(const std::vector<u64>& keys);
	// Host popped the oldest queued packet; an undelivered one retracts its texture payloads
	void on_packet_popped(bool delivered);

private:
	shared_mutex m_texture_residency_mutex;
	texture_residency m_texture_residency;
	// Residency keys of the payloads carried by each packet still in the host queue (FIFO)
	std::deque<std::vector<u64>> m_queued_packet_textures;
	// Content hashes of guest textures already hashed this frame, keyed by (address << 32 | size).
	// Cleared on flip; see rpcs3_webgpu_set_texture_hash_per_draw.
	std::unordered_map<u64, u32> m_frame_texture_hashes;
	std::uint64_t m_sequence = 0;
};

// Hash guest textures for every draw instead of once per frame (conformance lanes).
void rsx_webgpu_set_texture_hash_per_draw(bool enabled);
