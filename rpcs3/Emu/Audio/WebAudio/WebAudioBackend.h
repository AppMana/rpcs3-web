#pragma once

#include "Emu/Audio/AudioBackend.h"
#include <atomic>
#include <vector>

class WebAudioBackend final : public AudioBackend
{
public:
	WebAudioBackend() = default;
	~WebAudioBackend() override;

	std::string_view GetName() const override { return "WebAudio"sv; }

	bool Open(std::string_view dev_id, AudioFreq freq, AudioSampleSize sample_size, AudioChannelCnt ch_cnt, audio_channel_layout layout) override;
	void Close() override;

	f64 GetCallbackFrameLen() override;

	void Play() override;
	void Pause() override;
	bool IsPlaying() override;
	bool Operational() override { return m_opened.load(std::memory_order_relaxed); }
	void OnDataEnqueued() override;

private:
	void drain_elapsed_locked(u64 now_us);

	std::atomic<bool> m_opened{false};
	u64 m_last_drain_us = 0;
	u64 m_frac_frames_num = 0;
	std::vector<u8> m_raw_scratch;
	std::vector<f32> m_float_scratch;
};
