#pragma once

#include "util/types.hpp"
#include <atomic>

namespace emu::host
{
	// Lock-free shared-memory PCM ringbuffer exposed directly in linear Wasm memory
	// so Browser AudioWorkletProcessor (SharedArrayBuffer) and Desktop Wasm hosts
	// consume float32 audio frames with zero main-thread copies.
	struct alignas(64) SharedAudioRing
	{
		static constexpr u32 k_capacity_frames = 16384; // ~341 ms @ 48 kHz
		static constexpr u32 k_max_channels = 8;

		std::atomic<u32> sample_rate{48000};
		std::atomic<u32> channels{2};
		std::atomic<u32> capacity_frames{k_capacity_frames};
		std::atomic<u32> playing{0};
		std::atomic<u32> consumer_attached{0};
		std::atomic<u32> write_frame{0};
		std::atomic<u32> read_frame{0};
		std::atomic<u32> underruns{0};
		alignas(16) f32 samples[k_capacity_frames * k_max_channels]{};
	};

	// Hardware WebGPU presentation upscale state driven by cellResc HLE so resolution
	// conversion (e.g. 720p -> 1080p, aspect-ratio letterbox/panscan) happens in the
	// WebGPU presentation pass with zero extra RSX passes or guest PPU overhead.
	struct DisplayUpscaleState
	{
		std::atomic<u32> active{0};
		std::atomic<u32> src_width{0};
		std::atomic<u32> src_height{0};
		std::atomic<u32> src_pitch{0};
		std::atomic<u32> src_offset{0};
		std::atomic<u32> dst_width{1280};
		std::atomic<u32> dst_height{720};
		std::atomic<u32> buffer_mode{0};
		std::atomic<u32> ratio_mode{0};
		std::atomic<f32> aspect_x{1.0f};
		std::atomic<f32> aspect_y{1.0f};
		std::atomic<u64> resc_flips{0};
	};

	class PlatformServices
	{
	public:
		SharedAudioRing& audio_ring() noexcept { return m_audio_ring; }
		const SharedAudioRing& audio_ring() const noexcept { return m_audio_ring; }

		DisplayUpscaleState& display_upscale() noexcept { return m_display_upscale; }
		const DisplayUpscaleState& display_upscale() const noexcept { return m_display_upscale; }

		u32 push_audio_frames(const f32* interleaved, u32 frames, u32 channels) noexcept;
		u32 pull_audio_frames(f32* dst_interleaved, u32 frames, u32 dst_channels) noexcept;
		void reset_audio_ring(u32 sample_rate, u32 channels) noexcept;

	private:
		SharedAudioRing m_audio_ring{};
		DisplayUpscaleState m_display_upscale{};
	};

	PlatformServices& services() noexcept;
}
