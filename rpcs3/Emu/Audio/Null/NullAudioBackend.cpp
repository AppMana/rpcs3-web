#include "stdafx.h"
#include "NullAudioBackend.h"

LOG_CHANNEL(NullAudio);

bool NullAudioBackend::Open(std::string_view /* dev_id */, AudioFreq freq, AudioSampleSize sample_size, AudioChannelCnt ch_cnt, audio_channel_layout layout)
{
	Close();

	// Resolve the output layout the same way device backends do: the null
	// device accepts exactly the requested channel count, so an automatic
	// layout becomes the default layout for that count. cell_audio downmixes
	// against this layout and rejects an unresolved (automatic) one.
	m_sampling_rate = freq;
	m_sample_size = sample_size;
	setup_channel_layout(static_cast<u32>(ch_cnt), static_cast<u32>(ch_cnt), layout, NullAudio);

	return true;
}
