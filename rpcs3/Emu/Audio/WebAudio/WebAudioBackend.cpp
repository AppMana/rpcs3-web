#include "stdafx.h"
#include "WebAudioBackend.h"
#include "Emu/Host/HostPlatform.h"
#include "Emu/Cell/timers.hpp"

#include <algorithm>
#include <cstring>

LOG_CHANNEL(WebAudio);

WebAudioBackend::~WebAudioBackend()
{
	Close();
}

bool WebAudioBackend::Open(std::string_view /*dev_id*/, AudioFreq freq, AudioSampleSize sample_size, AudioChannelCnt ch_cnt, audio_channel_layout layout)
{
	Close();

	std::lock_guard lock(m_cb_mutex);
	m_sampling_rate = freq;
	m_sample_size = sample_size;
	const u32 out_ch = std::clamp<u32>(static_cast<u32>(ch_cnt), 2u, 8u);
	setup_channel_layout(static_cast<u32>(ch_cnt), out_ch, layout, WebAudio);

	emu::host::services().reset_audio_ring(get_sampling_rate(), get_channels());

	const u32 frame_bytes = get_channels() * get_sample_size();
	m_raw_scratch.assign(AUDIO_BUFFER_SAMPLES * 8 * frame_bytes, 0);
	m_float_scratch.assign(AUDIO_BUFFER_SAMPLES * 8 * get_channels(), 0.0f);
	m_last_drain_us = 0;
	m_frac_frames_num = 0;
	m_opened.store(true, std::memory_order_release);

	WebAudio.notice("Opened WebAudio shared-ring backend (%u Hz, %u ch, sample_size=%u)",
		get_sampling_rate(), get_channels(), get_sample_size());
	return true;
}

void WebAudioBackend::Close()
{
	std::lock_guard lock(m_cb_mutex);
	m_playing = false;
	m_opened.store(false, std::memory_order_release);
	m_last_drain_us = 0;
	m_frac_frames_num = 0;
	emu::host::services().audio_ring().playing.store(0, std::memory_order_release);
}

f64 WebAudioBackend::GetCallbackFrameLen()
{
	const u32 rate = get_sampling_rate();
	return rate ? static_cast<f64>(AUDIO_BUFFER_SAMPLES) / static_cast<f64>(rate) : (256.0 / 48000.0);
}

void WebAudioBackend::Play()
{
	std::lock_guard lock(m_cb_mutex);
	if (m_playing)
	{
		return;
	}
	m_playing = true;
	m_last_drain_us = get_system_time();
	m_frac_frames_num = 0;
	emu::host::services().audio_ring().playing.store(1, std::memory_order_release);
	if (m_write_callback && !m_raw_scratch.empty())
	{
		// Activate cellAudio's backend_active flag immediately on Play()
		m_write_callback(0, m_raw_scratch.data());
	}
}

void WebAudioBackend::Pause()
{
	std::lock_guard lock(m_cb_mutex);
	m_playing = false;
	m_last_drain_us = 0;
	m_frac_frames_num = 0;
	emu::host::services().audio_ring().playing.store(0, std::memory_order_release);
}

bool WebAudioBackend::IsPlaying()
{
	return m_playing;
}

void WebAudioBackend::OnDataEnqueued()
{
	std::lock_guard lock(m_cb_mutex);
	if (!m_playing || !m_write_callback)
	{
		return;
	}
	drain_elapsed_locked(get_system_time());
}

void WebAudioBackend::drain_elapsed_locked(u64 now_us)
{
	if (!m_last_drain_us || now_us <= m_last_drain_us)
	{
		m_last_drain_us = now_us;
		return;
	}

	const u64 elapsed_us = std::min<u64>(now_us - m_last_drain_us, 250'000ull);
	m_last_drain_us = now_us;

	const u32 rate = std::max<u32>(8000u, get_sampling_rate());
	const u32 channels = std::max<u32>(1u, get_channels());
	const u32 sample_bytes = get_sample_size();
	const u32 frame_bytes = channels * sample_bytes;

	const u64 total_num = elapsed_us * rate + m_frac_frames_num;
	u32 due_frames = static_cast<u32>(total_num / 1'000'000ull);
	m_frac_frames_num = total_num % 1'000'000ull;

	const u32 max_chunk_frames = static_cast<u32>(m_raw_scratch.size() / frame_bytes);
	while (due_frames > 0 && max_chunk_frames > 0)
	{
		const u32 req_frames = std::min<u32>(due_frames, max_chunk_frames);
		const u32 req_bytes = req_frames * frame_bytes;
		const u32 got_bytes = m_write_callback(req_bytes, m_raw_scratch.data());
		const u32 got_frames = got_bytes / frame_bytes;
		if (!got_frames)
		{
			break;
		}
		if (get_convert_to_s16())
		{
			const auto* src16 = reinterpret_cast<const s16*>(m_raw_scratch.data());
			const u32 count = got_frames * channels;
			for (u32 i = 0; i < count; ++i)
			{
				m_float_scratch[i] = static_cast<f32>(src16[i]) * (1.0f / 32768.0f);
			}
			emu::host::services().push_audio_frames(m_float_scratch.data(), got_frames, channels);
		}
		else
		{
			emu::host::services().push_audio_frames(reinterpret_cast<const f32*>(m_raw_scratch.data()), got_frames, channels);
		}
		if (got_frames < req_frames)
		{
			break;
		}
		due_frames -= got_frames;
	}
}
