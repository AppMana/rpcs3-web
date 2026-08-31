#include "Emu/System.h"
#include "Emu/IdManager.h"
#include "Emu/Cell/PPUFunction.h"
#include "Emu/RSX/GSFrameBase.h"
#include "Emu/RSX/WG/WebGPUGSRender.h"
#include "Emu/Memory/vm.h"
#include "Emu/Audio/Null/NullAudioBackend.h"
#include "Emu/Audio/Null/null_enumerator.h"
#include "Emu/Io/Null/null_camera_handler.h"
#include "Emu/Io/Null/null_music_handler.h"
#include "Emu/Io/pad_config.h"
#include "Input/pad_thread.h"
#include "Emu/Cell/Modules/cellMsgDialog.h"
#include "Emu/Cell/Modules/cellOskDialog.h"
#include "Emu/Cell/Modules/cellSaveData.h"
#include "Emu/Cell/Modules/sceNp.h"
#include "Emu/Cell/Modules/sceNpTrophy.h"
#include "Emu/system_config.h"
#include "Utilities/Thread.h"
#include "util/video_source.h"

#include <emscripten.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#ifdef RPCS3_WEB
extern atomic_t<u64> g_ppu_web_instruction_count;
extern atomic_t<u32> g_ppu_web_last_pc;
extern std::vector<std::string> g_ppu_function_names;
#endif

// The desktop frontend owns these input-profile globals. The browser host is
// the frontend for this target, so it owns the same state here.
cfg_input_configurations g_cfg_input_configs;
std::string g_input_config_override;

namespace
{
	std::atomic<bool> s_initialized{false};
	std::atomic<u32> s_last_boot_result{static_cast<u32>(game_boot_result::nothing_to_boot)};

	EM_JS(void, notify_host_event, (const char* event, u32 value), {
		const message = { type: UTF8ToString(event), value };
		if (typeof postMessage === 'function') {
			postMessage(message);
		} else if (typeof globalThis.dispatchEvent === 'function') {
			globalThis.dispatchEvent(new CustomEvent(message.type, { detail: message }));
		}
	});

	class web_gs_frame final : public GSFrameBase
	{
	public:
		void close() override {}
		void reset() override {}
		bool shown() override { return true; }
		void hide() override {}
		void show() override {}
		void toggle_fullscreen() override {}
		void delete_context(draw_context_t) override {}
		draw_context_t make_context() override { return nullptr; }
		void set_current(draw_context_t) override {}
		void flip(draw_context_t, bool skip_frame = false) override
		{
			notify_host_event("rpcs3-frame", skip_frame ? 1u : 0u);
		}
		int client_width() override { return 1280; }
		int client_height() override { return 720; }
		f64 client_display_rate() override { return 60.; }
		bool has_alpha() override { return false; }
		display_handle_t handle() const override { return nullptr; }
		bool can_consume_frame() const override { return false; }
		void present_frame(std::vector<u8>&&, u32, u32, u32, bool) const override {}
		void take_screenshot(std::vector<u8>&&, u32, u32, bool) override {}
		void update_title(double) override {}
	};

	EmuCallbacks make_web_callbacks()
	{
		EmuCallbacks callbacks{};

		callbacks.call_from_main_thread = [](std::function<void()> fn, atomic_t<u32>* wake_up)
		{
			fn();
			if (wake_up)
			{
				*wake_up = 1;
				wake_up->notify_one();
			}
		};
		callbacks.on_run = [](bool) { notify_host_event("rpcs3-running", 0); };
		callbacks.on_pause = [] { notify_host_event("rpcs3-paused", 0); };
		callbacks.on_resume = [] { notify_host_event("rpcs3-running", 0); };
		callbacks.on_stop = [] { notify_host_event("rpcs3-stopped", 0); };
		callbacks.on_ready = [] { notify_host_event("rpcs3-ready", 0); };
		callbacks.on_missing_fw = [] { notify_host_event("rpcs3-missing-firmware", 0); };
		callbacks.on_emulation_stop_no_response = [](std::shared_ptr<atomic_t<bool>> closed, int)
		{
			if (closed)
			{
				*closed = true;
			}
		};
		callbacks.on_save_state_progress = [](std::shared_ptr<atomic_t<bool>>, stx::shared_ptr<utils::serial>,
			stx::atomic_ptr<std::string>*, std::shared_ptr<void>) {};
		callbacks.enable_disc_eject = [](bool) {};
		callbacks.enable_disc_insert = [](bool) {};
		callbacks.try_to_quit = [](bool, std::function<void()> on_exit)
		{
			if (on_exit) on_exit();
			return true;
		};
		callbacks.handle_taskbar_progress = [](s32, s32) {};

		// Browser keyboard, pointer and Gamepad API adapters are installed in the
		// JS host.  The first boot milestone does not manufacture input here.
		callbacks.init_kb_handler = [] {};
		callbacks.init_mouse_handler = [] {};
		callbacks.init_pad_handler = [](std::string_view title_id)
		{
			ensure(g_fxo->init<named_thread<pad_thread>>(nullptr, nullptr, title_id));
		};
		callbacks.update_emu_settings = [] {};
		callbacks.save_emu_settings = [] {};
		callbacks.close_gs_frame = [] {};
		callbacks.get_gs_frame = [] { return std::make_unique<web_gs_frame>(); };
		callbacks.get_camera_handler = [] { return std::make_shared<null_camera_handler>(); };
		callbacks.get_music_handler = [] { return std::make_shared<null_music_handler>(); };
		callbacks.init_gs_render = [](utils::serial* ar)
		{
			g_fxo->init<rsx::thread, named_thread<WebGPUGSRender>>(ar);
		};
		callbacks.get_audio = [] { return std::make_shared<NullAudioBackend>(); };
		callbacks.get_audio_enumerator = [](u64) { return std::make_shared<null_enumerator>(); };

		callbacks.get_msg_dialog = [] { return std::shared_ptr<MsgDialogBase>{}; };
		callbacks.get_osk_dialog = [] { return std::shared_ptr<OskDialogBase>{}; };
		callbacks.get_save_dialog = [] { return std::unique_ptr<SaveDialogBase>{}; };
		callbacks.get_sendmessage_dialog = [] { return std::shared_ptr<SendMessageDialogBase>{}; };
		callbacks.get_recvmessage_dialog = [] { return std::shared_ptr<RecvMessageDialogBase>{}; };
		callbacks.get_trophy_notification_dialog = [] { return std::unique_ptr<TrophyNotificationBase>{}; };
		callbacks.get_localized_string = [](localized_string_id, const char* fallback)
		{
			return fallback ? std::string{fallback} : std::string{};
		};
		callbacks.get_localized_u32string = [](localized_string_id, const char*) { return std::u32string{}; };
		callbacks.get_localized_setting = [](const cfg::_base*, u32) { return std::string{}; };
		callbacks.get_photo_path = [](std::string_view) { return std::string{}; };
		callbacks.play_sound = [](const std::string&, std::optional<f32>) {};
		callbacks.get_image_info = [](const std::string&, std::string&, s32&, s32&, s32&) { return false; };
		callbacks.get_scaled_image = [](const std::string&, s32, s32, s32&, s32&, u8*, bool) { return false; };
		callbacks.resolve_path = [](std::string_view path) { return std::string{path}; };
		callbacks.resolve_path_may_not_exist = [](std::string_view path) { return std::string{path}; };
		callbacks.get_font_dirs = [] { return std::vector<std::string>{}; };
		callbacks.on_install_pkgs = [](const std::vector<std::string>&) { return false; };
		callbacks.add_breakpoint = [](u32) {};
		callbacks.display_sleep_control_supported = [] { return false; };
		callbacks.enable_display_sleep = [](bool) {};
		callbacks.check_microphone_permissions = [] {};
		callbacks.make_video_source = [] { return std::unique_ptr<video_source>{}; };
		callbacks.enable_gamemode = [](bool) {};
		callbacks.get_database_config = [](const std::string&) { return std::string{}; };

		return callbacks;
	}
}

[[noreturn]] void report_fatal_error(std::string_view text, bool, bool)
{
	std::fprintf(stderr, "RPCS3 fatal error: %.*s\n", static_cast<int>(text.size()), text.data());
	notify_host_event("rpcs3-fatal", 1);
	std::abort();
}

// System.cpp uses this coordination helper while stopping and replacing real
// RPCS3 worker threads.  Qt's implementation additionally pumps GUI events;
// the browser runtime executes in a Worker and therefore needs only the
// original non-GUI wait path.  The interval is supplied by the caller and is
// unrelated to frame presentation.
void qt_events_aware_op(int repeat_duration_ms, std::function<bool()> wrapped_op)
{
	ensure(wrapped_op);

	while (!wrapped_op())
	{
		if (repeat_duration_ms == 0)
		{
			std::this_thread::yield();
		}
		else if (thread_ctrl::get_current())
		{
			thread_ctrl::wait_for(repeat_duration_ms * 1000);
		}
		else
		{
			std::this_thread::sleep_for(std::chrono::milliseconds(repeat_duration_ms));
		}
	}
}

extern "C"
{
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_init()
	{
		if (s_initialized.exchange(true))
		{
			return 1;
		}

		Emu.SetCallbacks(make_web_callbacks());
		Emu.SetHasGui(false);
		Emu.SetHeadless(false);
		Emu.SetSupportedRenderers({video_renderer::webgpu});
		Emu.SetDefaultRenderer(video_renderer::webgpu);
		Emu.SetUsr("00000001");
		Emu.Init();
		notify_host_event("rpcs3-initialized", 0);
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_boot(const char* path)
	{
		if (!path || !*path || !s_initialized)
		{
			return static_cast<u32>(game_boot_result::invalid_file_or_folder);
		}

		Emu.SetForceBoot(true);
		const game_boot_result result = Emu.BootGame(path, {}, true, cfg_mode::default_config);
		s_last_boot_result = static_cast<u32>(result);
		notify_host_event("rpcs3-boot-result", static_cast<u32>(result));
		return static_cast<u32>(result);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_status()
	{
		return static_cast<u32>(Emu.GetStatus(false));
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_last_boot_result()
	{
		return s_last_boot_result;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_instruction_count()
	{
		return g_ppu_web_instruction_count;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_last_pc()
	{
		return g_ppu_web_last_pc;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_debug_read32(u32 addr)
	{
		return vm::check_addr<4>(addr) ? static_cast<u32>(vm::read32(addr)) : 0u;
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_ppu_last_function()
	{
		const u32 pc = g_ppu_web_last_pc;
		if (!g_fxo || !g_fxo->is_init<ppu_function_manager>())
		{
			return "";
		}

		const u32 base = g_fxo->get<ppu_function_manager>().addr;
		if (!base || pc < base || pc % 8 != 4)
		{
			return "";
		}

		const u32 index = (pc - base) / 8;
		return index < g_ppu_function_names.size() ? g_ppu_function_names[index].c_str() : "";
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_stop()
	{
		if (s_initialized && !Emu.IsStopped())
		{
			Emu.Kill(false);
		}
	}
}

int main()
{
	return 0;
}
