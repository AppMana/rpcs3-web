#pragma once

#include "Emu/RSX/GSRender.h"
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

	bool emit_draw_packet(u32 subdraw);
	void emit_control_packet(rsx::webgpu::packet_kind kind, u32 value, u32 flags = 0);

	rsx::vertex_input_layout m_vertex_layout;
	areau m_scissor{};
	std::vector<rsx::webgpu::texture_packet_record> m_frame_textures;
	std::uint64_t m_sequence = 0;
};
