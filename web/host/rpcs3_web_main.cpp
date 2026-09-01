#include "Emu/System.h"
#include "Emu/IdManager.h"
#include "Emu/VFS.h"
#include "Emu/Cell/PPUFunction.h"
#include "Emu/Cell/PPUThread.h"
#include "Emu/Cell/SPUThread.h"
#include "Emu/Cell/SPUWasmAbi.h"
#include "Emu/Cell/timers.hpp"
#include "Emu/RSX/GSFrameBase.h"
#include "Emu/RSX/Null/NullGSRender.h"
#include "Emu/RSX/WG/WebGPUGSRender.h"
#include "Emu/Memory/vm.h"
#include "Emu/Memory/vm_locking.h"
#include "Emu/Audio/Null/NullAudioBackend.h"
#include "Emu/Audio/Null/null_enumerator.h"
#include "Emu/Io/Null/null_camera_handler.h"
#include "Emu/Io/Null/NullKeyboardHandler.h"
#include "Emu/Io/Null/NullMouseHandler.h"
#include "Emu/Io/Null/null_music_handler.h"
#include "Emu/Io/pad_config.h"
#include "Input/pad_thread.h"
#include "Emu/Cell/Modules/cellMsgDialog.h"
#include "Emu/Cell/Modules/cellOskDialog.h"
#include "Emu/Cell/Modules/cellSaveData.h"
#include "Emu/Cell/Modules/sceNp.h"
#include "Emu/Cell/Modules/sceNpTrophy.h"
#include "Emu/system_config.h"
#include "Emu/vfs_config.h"
#include "Crypto/key_vault.h"
#include "Crypto/unself.h"
#include "Loader/PUP.h"
#include "Loader/TAR.h"
#include "Utilities/Thread.h"
#include "util/serialization.hpp"
#include "util/logs.hpp"
#include "util/video_source.h"

#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include <malloc.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
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

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef RPCS3_WEB
extern atomic_t<u64> g_ppu_web_instruction_count;
extern atomic_t<u32> g_ppu_web_last_pc;
extern atomic_t<u32> g_ppu_web_trace_pc;
extern atomic_t<u32> g_ppu_web_trace_hits;
extern atomic_t<u32> g_ppu_web_trace_delay_pc;
extern atomic_t<u32> g_ppu_web_trace_delay_hits;
extern atomic_t<u32> g_ppu_web_trace_delay_ms;
extern atomic_t<u32> g_ppu_web_watch_address;
extern std::vector<std::string> g_ppu_function_names;
extern atomic_t<u64> g_spu_web_instruction_count;
extern atomic_t<u32> g_spu_web_last_pc[6];
extern atomic_t<u64> g_spu_web_ls_boundary_count;
extern atomic_t<u64> g_spu_web_ls_boundary_last;
extern atomic_t<u64> g_spu_web_page_split_dma_count;
extern atomic_t<u32> g_spu_web_aot_hold;
extern atomic_t<u32> g_spu_web_aot_ready_mask;
extern atomic_t<spu_thread*> g_spu_web_aot_context[6];
extern atomic_t<u32> g_spu_web_aot_step_request[6];
extern atomic_t<u32> g_spu_web_aot_step_complete[6];
extern atomic_t<u32> g_spu_web_aot_step_result[6];
extern u32 ppu_web_interpreter_step(ppu_thread& ppu);
extern atomic_t<u32> g_ppu_web_aot_hold_entry;
extern atomic_t<u32> g_ppu_web_aot_entry_ready;
extern atomic_t<u32> g_ppu_web_aot_step_request;
extern atomic_t<u32> g_ppu_web_aot_step_complete;
extern atomic_t<u32> g_ppu_web_aot_step_result;
extern u32 ppu_lwarx(ppu_thread& ppu, u32 addr);
extern u64 ppu_ldarx(ppu_thread& ppu, u32 addr);
extern bool ppu_stwcx(ppu_thread& ppu, u32 addr, u32 reg_value);
extern bool ppu_stdcx(ppu_thread& ppu, u32 addr, u64 reg_value);
#endif

#ifdef RPCS3_WEB
#define RPCS3_SPU_WASM_ABI_ASSERT(name, offset) static_assert(__builtin_offsetof(spu_thread, name) == offset);
RPCS3_SPU_WASM_ABI_FIELDS(RPCS3_SPU_WASM_ABI_ASSERT)
#undef RPCS3_SPU_WASM_ABI_ASSERT
#endif

// The desktop frontend owns these input-profile globals. The browser host is
// the frontend for this target, so it owns the same state here.
cfg_input_configurations g_cfg_input_configs;
std::string g_input_config_override;

namespace
{
	using web_v128 = u8 __attribute__((vector_size(16)));

	template <typename T>
	T read_guest_raw(u32 addr) noexcept
	{
		T value{};
		vm::web_copy_range(addr, &value, sizeof(value), false);
		return value;
	}

	template <typename T>
	void write_guest_raw(u32 addr, T value) noexcept
	{
		vm::web_copy_range(addr, &value, sizeof(value), true);
	}

	std::atomic<bool> s_initialized{false};
	std::atomic<bool> s_null_renderer{false};
	std::atomic<s32> s_storage_state{0};
	std::atomic<u32> s_firmware_result{0};
	std::atomic<u32> s_firmware_progress{0};
	std::atomic<u32> s_firmware_total{0};
	std::atomic<u32> s_last_boot_result{static_cast<u32>(game_boot_result::nothing_to_boot)};
	std::unique_ptr<logs::listener> s_log_listener;
	thread_local bool s_atomic_notify_reentry_observed = false;
	std::atomic<bool> s_atomic_notify_watchdog_fired{false};
	stx::shared_ptr<named_thread<ppu_thread>> s_aot_context_thread;
	atomic_t<u32> s_aot_slice_active{0};
	atomic_t<u32> s_aot_slice_ready{0};
	atomic_t<u32> s_aot_slice_release{0};
	atomic_t<u32> s_aot_slice_complete{0};

	ppu_thread* aot_context(u32 context)
	{
		const auto expected = s_aot_context_thread
			? static_cast<ppu_thread*>(s_aot_context_thread.get()) : nullptr;
		return expected && reinterpret_cast<uptr>(expected) == context ? expected : nullptr;
	}

	u32 acquire_main_ppu()
	{
		if (!s_aot_context_thread)
		{
			auto selected = idm::select<named_thread<ppu_thread>>([](u32, named_thread<ppu_thread>& ppu)
			{
				const auto name = ppu.ppu_tname.load();
				return name && *name == "main_thread";
			});
			if (!selected.ptr)
			{
				return 0;
			}
			s_aot_context_thread = std::move(selected.ptr);
		}

		return static_cast<u32>(reinterpret_cast<uptr>(static_cast<ppu_thread*>(s_aot_context_thread.get())));
	}

	EM_JS(void, notify_host_event, (const char* event, u32 value), {
		const message = { type: UTF8ToString(event), value };
		if (typeof postMessage === 'function') {
			postMessage(message);
		} else if (typeof globalThis.dispatchEvent === 'function') {
			globalThis.dispatchEvent(new CustomEvent(message.type, { detail: message }));
		}
	});

	bool initialize_storage()
	{
		if (s_storage_state.load() == 1)
		{
			return true;
		}

		backend_t opfs = wasmfs_create_opfs_backend();
		if (!opfs || wasmfs_create_directory("/opfs", 0777, opfs) != 0)
		{
			s_storage_state = -1;
			notify_host_event("rpcs3-storage-failed", static_cast<u32>(errno));
			return false;
		}

		// All firmware, caches, saves, and configuration live outside the Wasm
		// heap. The JavaScript importer writes to the same origin-private root,
		// so large games never need to fit in linear memory.
		::setenv("XDG_CONFIG_HOME", "/opfs", 1);
		::setenv("XDG_CACHE_HOME", "/opfs/cache", 1);
		::mkdir("/opfs/cache", 0777);
		::mkdir("/opfs/cache/rpcs3", 0777);
		::mkdir("/opfs/games", 0777);
		::mkdir("/opfs/rpcs3", 0777);

		s_storage_state = 1;
		notify_host_event("rpcs3-storage-ready", 1);
		return true;
	}

	u32 install_firmware(const char* path)
	{
		s_firmware_progress = 0;
		s_firmware_total = 0;
		s_firmware_result = 1;
		if (!path || !*path || !s_initialized)
		{
			return 1;
		}

		{
			fs::file pup_file(path);
			if (!pup_file)
			{
				return s_firmware_result = 2;
			}

			pup_object pup(std::move(pup_file));
			if (pup.operator pup_error() != pup_error::ok)
			{
				return s_firmware_result = 3;
			}

			fs::file update_file = pup.get_file(0x300);
			if (!update_file || !update_file.size())
			{
				return s_firmware_result = 4;
			}

			tar_object update_files(update_file);
			auto filenames = update_files.get_filenames();
			filenames.erase(std::remove_if(filenames.begin(), filenames.end(), [](const std::string& name)
			{
				return name.find("dev_flash_") == std::string::npos;
			}), filenames.end());
			if (filenames.empty())
			{
				return s_firmware_result = 5;
			}

			if (!vfs::mount("/dev_flash", g_cfg_vfs.get_dev_flash()))
			{
				return s_firmware_result = 6;
			}
			std::printf("RPCS3 Web firmware target: %s\n", g_cfg_vfs.get_dev_flash().c_str());

			s_firmware_total = static_cast<u32>(filenames.size());
			notify_host_event("rpcs3-firmware-started", s_firmware_total);
			for (const std::string& filename : filenames)
			{
				auto stream = update_files.get_file(filename);
				if (!stream)
				{
					return s_firmware_result = 7;
				}
				if (stream->m_file_handler &&
					!stream->m_file_handler->handle_file_op(*stream, 0, stream->get_size(umax), nullptr))
				{
					return s_firmware_result = 7;
				}

				fs::file package = fs::make_stream(std::move(stream->data));
				SCEDecrypter decrypter(package);
				if (!decrypter.LoadHeaders() || !decrypter.LoadMetadata(SCEPKG_ERK, SCEPKG_RIV) || !decrypter.DecryptData())
				{
					return s_firmware_result = 8;
				}

				auto files = decrypter.MakeFile();
				if (files.size() < 3 || files[2].size() < 3)
				{
					return s_firmware_result = 9;
				}
				tar_object archive(files[2]);
				const auto entries = archive.get_filenames();
				std::printf("RPCS3 Web firmware package: %s (%u entries)\n", filename.c_str(), static_cast<u32>(entries.size()));
				if (entries.empty() || !archive.extract())
				{
					return s_firmware_result = 9;
				}

				const u32 progress = ++s_firmware_progress;
				notify_host_event("rpcs3-firmware-progress", progress);
			}

			update_file.close();
			if (!fs::is_file(g_cfg_vfs.get_dev_flash() + "sys/external/liblv2.sprx"))
			{
				return s_firmware_result = 11;
			}
			s_firmware_result = 0;
			notify_host_event("rpcs3-firmware-installed", s_firmware_progress);
			return 0;
		}
	}

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

		// Browser keyboard and touch state enters through RPCS3's normal pad
		// thread. Pointer devices are not required by the current fixtures.
		callbacks.init_kb_handler = []
		{
			ensure(g_fxo->init<KeyboardHandlerBase, NullKeyboardHandler>(Emu.DeserialManager()));
		};
		callbacks.init_mouse_handler = []
		{
			ensure(g_fxo->init<MouseHandlerBase, NullMouseHandler>(Emu.DeserialManager()));
		};
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
			if (s_null_renderer)
			{
				g_fxo->init<rsx::thread, named_thread<NullGSRender>>(ar);
			}
			else
			{
				g_fxo->init<rsx::thread, named_thread<WebGPUGSRender>>(ar);
			}
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
		if (s_initialized.load())
		{
			return 1;
		}
		if (!initialize_storage())
		{
			return 0;
		}
		s_initialized = true;

		Emu.SetCallbacks(make_web_callbacks());
		if (!s_log_listener)
		{
			s_log_listener = logs::make_file_listener("/opfs/cache/rpcs3/RPCS3.log", 32 * 1024 * 1024);
		}
		Emu.SetHasGui(false);
		Emu.SetHeadless(false);
		const video_renderer renderer = s_null_renderer ? video_renderer::null : video_renderer::webgpu;
		Emu.SetSupportedRenderers({renderer});
		Emu.SetDefaultRenderer(renderer);
		Emu.SetUsr("00000001");
		Emu.Init();
		notify_host_event("rpcs3-initialized", 0);
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE s32 rpcs3_web_storage_state()
	{
		return s_storage_state;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_install_firmware(const char* path)
	{
		return install_firmware(path);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_firmware_result()
	{
		return s_firmware_result;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_null_renderer(s32 enabled)
	{
		if (!s_initialized)
		{
			s_null_renderer = enabled != 0;
		}
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_firmware_progress()
	{
		return s_firmware_progress;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_firmware_total()
	{
		return s_firmware_total;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_has_firmware()
	{
		return s_initialized && fs::is_file(g_cfg_vfs.get_dev_flash() + "sys/external/liblv2.sprx");
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_dev_flash_path()
	{
		static std::string path;
		path = s_initialized ? g_cfg_vfs.get_dev_flash() : "";
		return path.c_str();
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

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_hold_ppu_at_entry(s32 enabled)
	{
		Emu.SetHoldAtEntry(enabled != 0);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_ppu_aot_handoff(s32 enabled)
	{
		g_ppu_web_aot_entry_ready = 0;
		g_ppu_web_aot_step_request = 0;
		g_ppu_web_aot_step_complete = 0;
		g_ppu_web_aot_hold_entry = enabled != 0;
		g_ppu_web_aot_step_request.notify_all();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_entry_ready()
	{
		return g_ppu_web_aot_entry_ready;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_entry_ready_address()
	{
		return static_cast<u32>(reinterpret_cast<uptr>(&g_ppu_web_aot_entry_ready));
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_status()
	{
		return static_cast<u32>(Emu.GetStatus(false));
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_atomic_notify_reentry_probe()
	{
		atomic_t<u32> value{0};
		s_atomic_notify_watchdog_fired = false;
		s_atomic_notify_reentry_observed = false;
		atomic_wait_engine::set_wait_callback([](const void* data, u64 attempts, u64)
		{
			if (attempts == 1)
			{
				s_atomic_notify_reentry_observed = !s_atomic_notify_watchdog_fired.load(std::memory_order_acquire);
				atomic_wait_engine::notify_all(data);
				return false;
			}

			return true;
		});

		std::thread notifier([&value]
		{
			std::this_thread::sleep_for(std::chrono::milliseconds(100));
			s_atomic_notify_watchdog_fired.store(true, std::memory_order_release);
			value = 1;
			value.notify_all();
		});
		value.wait(0);
		notifier.join();
		atomic_wait_engine::set_wait_callback(nullptr);
		return s_atomic_notify_reentry_observed;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_sparse_vm_probe()
	{
		constexpr u32 base = 0x60000000;
		constexpr u32 page_size = 0x1000;
		constexpr u32 transfer_address = base + page_size - 0x100;
		constexpr u32 transfer_size = 0x400;
		if (vm::web_base(base) || vm::web_base(base + page_size))
		{
			return 0;
		}

		u8* first = static_cast<u8*>(std::aligned_alloc(page_size, page_size));
		u8* second = static_cast<u8*>(std::aligned_alloc(page_size, page_size));
		if (!first || !second)
		{
			std::free(first);
			std::free(second);
			return 0;
		}

		u8* const higher = reinterpret_cast<uptr>(first) > reinterpret_cast<uptr>(second) ? first : second;
		u8* const lower = higher == first ? second : first;
		vm::web_map(base, page_size, higher);
		vm::web_map(base + page_size, page_size, lower);

		std::array<u8, transfer_size> input{};
		std::array<u8, transfer_size> output{};
		for (u32 index = 0; index < transfer_size; ++index)
		{
			input[index] = static_cast<u8>((index * 37 + 11) & 0xff);
		}

		const u32 result = !vm::web_is_contiguous(transfer_address, transfer_size) &&
			vm::web_copy_range(transfer_address, input.data(), transfer_size, true) &&
			vm::web_copy_range(transfer_address, output.data(), transfer_size, false) &&
			input == output;
		vm::web_unmap(base, page_size * 2);
		std::free(first);
		std::free(second);
		return result;
	}

	EMSCRIPTEN_KEEPALIVE u8 rpcs3_web_vm_read8_raw(u32 addr)
	{
		return read_guest_raw<u8>(addr);
	}

	EMSCRIPTEN_KEEPALIVE u16 rpcs3_web_vm_read16_raw(u32 addr)
	{
		return read_guest_raw<u16>(addr);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_vm_read32_raw(u32 addr)
	{
		return read_guest_raw<u32>(addr);
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_vm_read64_raw(u32 addr)
	{
		return read_guest_raw<u64>(addr);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_vm_read128_raw(u32 addr, web_v128* output)
	{
		if (output)
		{
			*output = read_guest_raw<web_v128>(addr);
		}
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_vm_write8_raw(u32 addr, u8 value)
	{
		write_guest_raw(addr, value);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_vm_write16_raw(u32 addr, u16 value)
	{
		write_guest_raw(addr, value);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_vm_write32_raw(u32 addr, u32 value)
	{
		write_guest_raw(addr, value);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_vm_write64_raw(u32 addr, u64 value)
	{
		write_guest_raw(addr, value);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_vm_write128_raw(u32 addr, const web_v128* value)
	{
		if (value)
		{
			write_guest_raw(addr, *value);
		}
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_create_context(u32 entry, u32 rtoc, u32 tls)
	{
		if (s_aot_context_thread)
		{
			return acquire_main_ppu();
		}

		const u32 context = acquire_main_ppu();
		if (!context) return 0;
		auto expected = static_cast<ppu_thread*>(s_aot_context_thread.get());
		atomic_t<u32> complete{0};
		(*s_aot_context_thread)([expected, entry, rtoc, tls, &complete]
		{
			expected->cia = entry;
			expected->gpr[2] = rtoc;
			expected->gpr[13] = tls;
			expected->stop_flag_removal_protection = true;
			expected->state -= cpu_flag::notify;
			complete.release(1);
			complete.notify_one();
		});
		expected->state += cpu_flag::notify;
		expected->notify();
		while (!complete)
		{
			complete.wait(0);
		}
		return context;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_acquire_main()
	{
		const u32 context = acquire_main_ppu();
		if (!context) return 0;
		if (g_ppu_web_aot_entry_ready)
		{
			return context;
		}

		auto expected = static_cast<ppu_thread*>(s_aot_context_thread.get());
		atomic_t<u32> complete{0};
		(*s_aot_context_thread)([expected, &complete]
		{
			expected->stop_flag_removal_protection = true;
			expected->state -= cpu_flag::notify;
			complete.release(1);
			complete.notify_one();
		});
		expected->state += cpu_flag::notify;
		expected->notify();
		while (!complete)
		{
			complete.wait(0);
		}
		return context;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_release(u32 context)
	{
		if (!aot_context(context) || s_aot_slice_active)
		{
			return 0;
		}
		s_aot_context_thread.reset();
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_pc(u32 context)
	{
		const auto expected = aot_context(context);
		return expected ? expected->cia : 0;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_aot_gpr(u32 context, u32 index)
	{
		const auto expected = aot_context(context);
		return expected && index < std::size(expected->gpr) ? expected->gpr[index] : 0;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_aot_lr(u32 context)
	{
		const auto expected = aot_context(context);
		return expected ? expected->lr : 0;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_state(u32 context)
	{
		const auto expected = aot_context(context);
		return expected ? static_cast<u32>(+expected->state) : umax;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_terminal(u32 context)
	{
		const auto expected = aot_context(context);
		return !expected || is_stopped(expected->state);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_set_pc(u32 context, u32 pc)
	{
		const auto expected = aot_context(context);
		if (!expected || !s_aot_slice_active) return 0;
		expected->cia = pc;
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_check(u32 context, u32 pc)
	{
		const auto expected = aot_context(context);
		if (!expected || !s_aot_slice_active) return 1;
		expected->cia = pc;
		return is_stopped(expected->state);
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_aot_timebase()
	{
		return get_timebased_time();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_lwarx(u32 context, u64 address)
	{
		const auto expected = aot_context(context);
		return expected && s_aot_slice_active ? ppu_lwarx(*expected, static_cast<u32>(address)) : 0;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_aot_ldarx(u32 context, u64 address)
	{
		const auto expected = aot_context(context);
		return expected && s_aot_slice_active ? ppu_ldarx(*expected, static_cast<u32>(address)) : 0;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_stwcx(u32 context, u64 address, u32 value)
	{
		const auto expected = aot_context(context);
		return expected && s_aot_slice_active && ppu_stwcx(*expected, static_cast<u32>(address), value);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_stdcx(u32 context, u64 address, u64 value)
	{
		const auto expected = aot_context(context);
		return expected && s_aot_slice_active && ppu_stdcx(*expected, static_cast<u32>(address), value);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_begin(u32 context)
	{
		const auto expected = aot_context(context);
		if (!expected || !s_aot_slice_active.compare_and_swap_test(0, 1))
		{
			return 0;
		}
		if (g_ppu_web_aot_entry_ready)
		{
			return 1;
		}

		s_aot_slice_ready = 0;
		s_aot_slice_release = 0;
		s_aot_slice_complete = 0;
		(*s_aot_context_thread)([expected]
		{
			const auto idle_state = expected->state.exchange({});
			s_aot_slice_ready.release(1);
			s_aot_slice_ready.notify_one();
			while (!s_aot_slice_release)
			{
				s_aot_slice_release.wait(0);
			}
			expected->state.store(idle_state - cpu_flag::notify);
			s_aot_slice_complete.release(1);
			s_aot_slice_complete.notify_one();
		});
		expected->state += cpu_flag::notify;
		expected->notify();
		while (!s_aot_slice_ready)
		{
			s_aot_slice_ready.wait(0);
		}
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_end(u32 context)
	{
		const auto expected = aot_context(context);
		if (!expected || !s_aot_slice_active)
		{
			return 0;
		}
		if (g_ppu_web_aot_entry_ready)
		{
			s_aot_slice_active = 0;
			return 1;
		}

		s_aot_slice_release.release(1);
		s_aot_slice_release.notify_one();
		while (!s_aot_slice_complete)
		{
			s_aot_slice_complete.wait(0);
		}
		s_aot_slice_active = 0;
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_interpreter_step(u32 context)
	{
		const auto expected = aot_context(context);
		if (!expected)
		{
			return 0;
		}
		if (g_ppu_web_aot_entry_ready)
		{
			g_ppu_web_aot_step_complete = 0;
			g_ppu_web_aot_step_request.release(1);
			g_ppu_web_aot_step_request.notify_one();
			while (!g_ppu_web_aot_step_complete)
			{
				g_ppu_web_aot_step_complete.wait(0);
			}
			return g_ppu_web_aot_step_result;
		}

		atomic_t<u32> next{0};
		atomic_t<u32> complete{0};
		(*s_aot_context_thread)([expected, &next, &complete]
		{
			const auto idle_state = expected->state.exchange(cpu_flag::wait + cpu_flag::memory);
			static_cast<void>(expected->check_state());
			next = ppu_web_interpreter_step(*expected);
			vm::temporary_unlock(*expected);
			expected->state.store(idle_state - cpu_flag::notify);
			complete.release(1);
			complete.notify_one();
		});
		expected->state += cpu_flag::notify;
		expected->notify();
		while (!complete)
		{
			complete.wait(0);
		}
		return next;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_sync_logs()
	{
		logs::listener::sync_all();
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

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_spu_instruction_count()
	{
		return g_spu_web_instruction_count;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_last_pc(u32 index)
	{
		return index < std::size(g_spu_web_last_pc) ? g_spu_web_last_pc[index].load() : 0;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_spu_ls_boundary_count()
	{
		return g_spu_web_ls_boundary_count;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_spu_ls_boundary_last()
	{
		return g_spu_web_ls_boundary_last;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_spu_page_split_dma_count()
	{
		return g_spu_web_page_split_dma_count;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_spu_aot_handoff(s32 enabled)
	{
		if (!enabled)
		{
			g_spu_web_aot_hold = 0;
			for (auto& request : g_spu_web_aot_step_request)
			{
				request.notify_all();
			}
			return;
		}

		g_spu_web_aot_ready_mask = 0;
		for (u32 index = 0; index < std::size(g_spu_web_aot_context); index++)
		{
			g_spu_web_aot_context[index] = nullptr;
			g_spu_web_aot_step_request[index] = 0;
			g_spu_web_aot_step_complete[index] = 0;
		}
		g_spu_web_aot_hold = (1u << std::size(g_spu_web_aot_context)) - 1;
		for (auto& request : g_spu_web_aot_step_request)
		{
			request.notify_all();
		}
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_ready_mask()
	{
		return g_spu_web_aot_ready_mask;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_context(u32 index)
	{
		return index < std::size(g_spu_web_aot_context)
			? static_cast<u32>(reinterpret_cast<uptr>(g_spu_web_aot_context[index].load())) : 0;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_ls(u32 context)
	{
		const auto expected = reinterpret_cast<spu_thread*>(static_cast<uptr>(context));
		for (const auto& candidate : g_spu_web_aot_context)
		{
			if (candidate.load() == expected)
			{
				return static_cast<u32>(reinterpret_cast<uptr>(expected->_ptr<u8>(0)));
			}
		}
		return 0;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_pc(u32 context)
	{
		const auto expected = reinterpret_cast<spu_thread*>(static_cast<uptr>(context));
		for (const auto& candidate : g_spu_web_aot_context)
		{
			if (candidate.load() == expected)
				return expected->pc;
		}
		return 0;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_step(u32 index)
	{
		if (index >= std::size(g_spu_web_aot_context) || !g_spu_web_aot_context[index])
			return 0;

		g_spu_web_aot_step_complete[index] = 0;
		g_spu_web_aot_step_request[index].release(1);
		g_spu_web_aot_step_request[index].notify_one();
		while (!g_spu_web_aot_step_complete[index])
		{
			g_spu_web_aot_step_complete[index].wait(0);
		}
		return g_spu_web_aot_step_result[index];
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_terminal(u32 context)
	{
		const auto expected = reinterpret_cast<spu_thread*>(static_cast<uptr>(context));
		for (const auto& candidate : g_spu_web_aot_context)
		{
			if (candidate.load() == expected)
				return is_stopped(expected->state);
		}
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_release(u32 index)
	{
		if (index >= std::size(g_spu_web_aot_context))
			return 0;
		g_spu_web_aot_hold.fetch_and(~(1u << index));
		g_spu_web_aot_step_request[index].notify_all();
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_aot_abi(u32 field)
	{
		switch (field)
		{
		case 0: return sizeof(spu_thread);
		case 1: return ::offset32(&spu_thread::state);
		case 2: return ::offset32(&spu_thread::pc);
		case 3: return ::offset32(&spu_thread::gpr);
		case 4: return ::offset32(&spu_thread::block_hash);
		case 5: return ::offset32(&spu_thread::block_counter);
		case 6: return ::offset32(&spu_thread::block_failure);
		default: return umax;
		}
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_vm_range_lock_bits(u32 exclusive)
	{
		return vm::g_range_lock_bits[exclusive != 0].load();
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_vm_range_lock(u32 index)
	{
		return index < std::size(vm::g_range_lock_set) ? vm::g_range_lock_set[index].load() : 0;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_vm_ppu_lock_count()
	{
		return vm::web_ppu_lock_count();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_vm_ppu_lock_id(u32 index)
	{
		return vm::web_ppu_lock_id(index);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_vm_ppu_lock_state(u32 index)
	{
		return vm::web_ppu_lock_state(index);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_clock_scale(u32 percent)
	{
		g_cfg.core.clocks_scale.set(std::clamp(percent, 10u, 3000u));
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_accurate_spu_dma(s32 enabled)
	{
		g_cfg.core.spu_accurate_dma.set(enabled != 0);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_trace_pc(u32 pc)
	{
		g_ppu_web_trace_hits = 0;
		g_ppu_web_trace_pc = pc;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_trace_delay(u32 pc, u32 delay_ms)
	{
		g_ppu_web_trace_delay_hits = 0;
		g_ppu_web_trace_delay_pc = pc;
		g_ppu_web_trace_delay_ms = std::min(delay_ms, 10'000u);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_trace_hits()
	{
		return g_ppu_web_trace_hits;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_watch_address(u32 address)
	{
		g_ppu_web_watch_address = address;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_debug_read32(u32 addr)
	{
		return vm::check_addr<4>(addr) ? static_cast<u32>(vm::read32(addr)) : 0u;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_pad(u32 digital1, u32 digital2, u32 left_x, u32 left_y, u32 right_x, u32 right_y)
	{
		web_pad::set_state(digital1, digital2, left_x, left_y, right_x, right_y);
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

	// Working-set telemetry consumed by the browser worker's progress reports.
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_live_thread_count()
	{
		return thread_ctrl::web_live_threads();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_peak_thread_count()
	{
		return thread_ctrl::web_peak_threads();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_started_thread_count()
	{
		return thread_ctrl::web_started_threads();
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_stack_max_used()
	{
		return thread_ctrl::web_stack_max_used();
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_stack_paint(s32 enabled)
	{
		thread_ctrl::web_set_stack_paint(enabled != 0);
	}

	// name<TAB>max used bytes<TAB>stack size, one thread name per line
	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_stack_report()
	{
		static std::string report;
		report = thread_ctrl::web_stack_report();
		return report.c_str();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_vm_mapped_pages()
	{
		return vm::web_mapped_pages();
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_vm_backing_bytes()
	{
		return utils::web_backing_bytes();
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_malloc_bytes()
	{
		const struct mallinfo info = mallinfo();
		return static_cast<u64>(static_cast<unsigned>(info.uordblks));
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_malloc_arena_bytes()
	{
		const struct mallinfo info = mallinfo();
		return static_cast<u64>(static_cast<unsigned>(info.arena));
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_thread_snapshot()
	{
		static std::string snapshot;
		snapshot.clear();
		if (const auto render = rsx::get_current_renderer())
		{
			const u64 get_put = render->new_get_put;
			fmt::append(snapshot,
				"RSX running=%u initialized=%u state=0x%x pause-lock=%u pause-ack=%u interrupts=0x%x new-get=0x%08x new-put=0x%08x fifo=%u\n",
				static_cast<u32>(render->rsx_thread_running.load()), render->is_initialized.load(),
				static_cast<u32>(+render->state), render->external_interrupt_lock.load(),
				static_cast<u32>(render->external_interrupt_ack.load()),
				static_cast<u32>(render->m_eng_interrupt_mask.load()), static_cast<u32>(get_put),
				static_cast<u32>(get_put >> 32), static_cast<u32>(render->fifo_ctrl != nullptr));
		}
		idm::select<named_thread<ppu_thread>>([&](u32 id, ppu_thread& ppu)
		{
			const auto name = ppu.ppu_tname.load();
			fmt::append(snapshot, "PPU id=0x%08x name=%s pc=0x%08x lr=0x%llx ctr=0x%llx state=0x%x current=%s last=%s args=[0x%llx,0x%llx,0x%llx,0x%llx]\n",
				id, name ? name->c_str() : "", ppu.cia, ppu.lr, ppu.ctr, static_cast<u32>(+ppu.state),
				ppu.current_function ? ppu.current_function : "", ppu.last_function ? ppu.last_function : "",
				ppu.gpr[3], ppu.gpr[4], ppu.gpr[5], ppu.gpr[6]);
		});
		idm::select<named_thread<spu_thread>>([&](u32, spu_thread& spu)
		{
			const auto name = spu.spu_tname.load();
			fmt::append(snapshot, "SPU id=0x%08x name=%s pc=0x%05x state=0x%x current=%s\n",
				spu.lv2_id, name ? name->c_str() : "", spu.pc, static_cast<u32>(+spu.state),
				spu.current_func ? spu.current_func : "");
		});
		return snapshot.c_str();
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_stop()
	{
		g_ppu_web_aot_hold_entry = 0;
		g_ppu_web_aot_step_request.notify_all();
		if (s_aot_slice_active)
		{
			s_aot_slice_release.release(1);
			s_aot_slice_release.notify_one();
			while (!s_aot_slice_complete)
			{
				s_aot_slice_complete.wait(0);
			}
			s_aot_slice_active = 0;
		}
		s_aot_context_thread.reset();
		if (s_initialized && !Emu.IsStopped())
		{
			Emu.Kill(false);
			while (!Emu.IsStopped())
			{
				std::this_thread::yield();
			}
		}
	}
}

int main()
{
	return 0;
}
