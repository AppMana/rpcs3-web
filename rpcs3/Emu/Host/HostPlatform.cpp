#include "stdafx.h"
#include "HostPlatform.h"

#include <algorithm>
#include <cstring>

namespace emu::host
{
	PlatformServices& services() noexcept
	{
		static PlatformServices s_instance;
		return s_instance;
	}

	void PlatformServices::reset_audio_ring(u32 sample_rate, u32 channels) noexcept
	{
		const u32 clamped_ch = std::clamp<u32>(channels, 1, SharedAudioRing::k_max_channels);
		m_audio_ring.playing.store(0, std::memory_order_release);
		m_audio_ring.sample_rate.store(sample_rate ? sample_rate : 48000u, std::memory_order_relaxed);
		m_audio_ring.channels.store(clamped_ch, std::memory_order_relaxed);
		m_audio_ring.write_frame.store(0, std::memory_order_relaxed);
		m_audio_ring.read_frame.store(0, std::memory_order_release);
		std::memset(m_audio_ring.samples, 0, sizeof(m_audio_ring.samples));
	}

	u32 PlatformServices::push_audio_frames(const f32* interleaved, u32 frames, u32 channels) noexcept
	{
		if (!interleaved || !frames || !channels)
		{
			return 0;
		}

		const u32 ch = std::min<u32>(channels, SharedAudioRing::k_max_channels);
		const u32 cap = SharedAudioRing::k_capacity_frames;
		const u32 mask = cap - 1;
		u32 w = m_audio_ring.write_frame.load(std::memory_order_relaxed);
		u32 r = m_audio_ring.read_frame.load(std::memory_order_acquire);

		// If no external AudioWorklet/host consumer is attached or if it fell behind,
		// advance read_frame to drop the oldest frames rather than stalling cellAudio.
		const u32 used = w - r;
		if (used + frames > cap)
		{
			const u32 drop = (used + frames) - cap;
			r += drop;
			m_audio_ring.read_frame.store(r, std::memory_order_release);
		}

		for (u32 i = 0; i < frames; ++i)
		{
			const u32 slot = (w + i) & mask;
			std::memcpy(&m_audio_ring.samples[slot * ch], &interleaved[i * channels], ch * sizeof(f32));
		}

		m_audio_ring.write_frame.store(w + frames, std::memory_order_release);
		return frames;
	}

	u32 PlatformServices::pull_audio_frames(f32* dst_interleaved, u32 frames, u32 dst_channels) noexcept
	{
		if (!dst_interleaved || !frames || !dst_channels)
		{
			return 0;
		}

		m_audio_ring.consumer_attached.store(1, std::memory_order_relaxed);
		const u32 src_ch = m_audio_ring.channels.load(std::memory_order_relaxed);
		const u32 cap = SharedAudioRing::k_capacity_frames;
		const u32 mask = cap - 1;
		const u32 w = m_audio_ring.write_frame.load(std::memory_order_acquire);
		const u32 r = m_audio_ring.read_frame.load(std::memory_order_relaxed);
		const u32 avail = std::min<u32>(w - r, cap);
		const u32 to_read = std::min<u32>(frames, avail);

		for (u32 i = 0; i < to_read; ++i)
		{
			const u32 slot = (r + i) & mask;
			const f32* src = &m_audio_ring.samples[slot * src_ch];
			f32* dst = &dst_interleaved[i * dst_channels];
			if (src_ch == dst_channels)
			{
				std::memcpy(dst, src, dst_channels * sizeof(f32));
			}
			else
			{
				for (u32 c = 0; c < dst_channels; ++c)
				{
					dst[c] = (c < src_ch) ? src[c] : 0.0f;
				}
			}
		}

		if (to_read < frames)
		{
			std::memset(&dst_interleaved[to_read * dst_channels], 0, (frames - to_read) * dst_channels * sizeof(f32));
			m_audio_ring.underruns.fetch_add(1, std::memory_order_relaxed);
		}

		m_audio_ring.read_frame.store(r + to_read, std::memory_order_release);
		return to_read;
	}
}
