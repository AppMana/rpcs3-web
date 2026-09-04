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
#include "Emu/RSX/WG/WebGPUDirectGSRender.h"

extern volatile u32 g_rpcs3_web_rsx_spawn_pending;
#include "Emu/RSX/WG/WebGPUHost.h"
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
#include <emscripten/threading.h>
#include <emscripten/wasmfs.h>
#include <malloc.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <functional>
#include <mutex>
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
extern atomic_t<u32> g_spu_web_fallback_histogram;
extern std::string spu_web_aot_fallback_report(u32 top);
extern u32 spu_web_miss_count();
extern std::string spu_web_wasm_selftest(const u8* cache, u32 size);
extern std::string spu_web_hot_report();
extern void spu_web_set_hot_table_base(u32 base);
extern u32 spu_web_hot_count();
extern u32 spu_web_hot_index(u32 i);
extern const u8* spu_web_hot_bytes(u32 i);
extern u32 spu_web_hot_size(u32 i);
extern u64 ppu_web_blocks_used();
extern u32 ppu_web_copy_used(u32* out, u32 max);
extern void ppu_web_set_block_base(u32 base);
extern atomic_t<u32> g_spu_web_hot_threshold;
extern void spu_web_hot_info(u32 i, u32* out);
extern void spu_web_llvm_set_enabled(bool enabled);
extern s32 spu_web_llvm_poll();
extern const u8* spu_web_llvm_slot_ls(u32 i);
extern u32 spu_web_llvm_slot_pc(u32 i);
extern void spu_web_llvm_slot_finish(u32 i, u8* bytes, u32 size, u32 memory_size, u32 memory_align, u32 table_size, u32 imports_table);
extern std::pair<const u8*, u32> spu_web_miss_data();
extern atomic_t<spu_thread*> g_spu_web_aot_context[6];
extern atomic_t<u32> g_spu_web_aot_step_request[6];
extern atomic_t<u32> g_spu_web_aot_step_complete[6];
extern atomic_t<u32> g_spu_web_aot_step_result[6];
extern u32 ppu_web_interpreter_step(ppu_thread& ppu);
// Set by web/host/rpcs3_web_pre.js once this worker's function table holds the compiled PPU blocks
EM_JS(int, rpcs3_web_ppu_aot_worker_ready, (), { if (!self.__rpcs3PpuAotReady && Module["rpcs3EnsureAot"]) Module["rpcs3EnsureAot"]("rpcs3PpuAot"); return self.__rpcs3PpuAotReady ? 1 : 0; });

EM_JS(int, rpcs3_web_spu_aot_worker_ready, (), { if (!self.__rpcs3SpuAotReady && Module["rpcs3EnsureAot"]) Module["rpcs3EnsureAot"]("rpcs3SpuAot"); return self.__rpcs3SpuAotReady ? 1 : 0; });

extern u32 g_rpcs3_web_clocks_scale;
extern spu_decoder_type g_rpcs3_web_spu_decoder;
extern spu_block_size_type g_rpcs3_web_spu_block_size;
extern void spu_web_aot_register(const u32* pairs, u32 count);
extern u32 g_spu_web_trace_lo;
extern u32 g_spu_web_trace_hi;
extern u64 spu_web_aot_dispatch_count();
extern u64 spu_web_aot_fallback_count();
[[noreturn]] extern void spu_web_escape_now(spu_thread* spu);

extern void ppu_web_aot_register(const u32* pairs, u32 count);
extern void* ppu_web_aot_exec_base();
extern u32 ppu_web_aot_registered(u32 addr);
extern atomic_t<u64> g_ppu_web_aot_dispatch_count;
extern u32 ppu_lwarx(ppu_thread& ppu, u32 addr);
extern u64 ppu_ldarx(ppu_thread& ppu, u32 addr);
extern bool ppu_stwcx(ppu_thread& ppu, u32 addr, u32 reg_value);
extern bool ppu_stdcx(ppu_thread& ppu, u32 addr, u64 reg_value);
extern void ppu_execute_syscall(ppu_thread& ppu, u64 code);
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

	// PPU AOT memory accesses: an access inside one mapped page is a direct (unaligned) wasm
	// load or store; only page-crossing accesses take the per-page copy loop
	template <typename T>
	T read_guest_raw(u32 addr) noexcept
	{
		T value{};
		if ((addr & 0xfff) + sizeof(T) <= 0x1000) [[likely]]
		{
			std::memcpy(&value, vm::web_ptr(addr), sizeof(T));
			return value;
		}
		vm::web_copy_range(addr, &value, sizeof(value), false);
		return value;
	}

	template <typename T>
	void write_guest_raw(u32 addr, T value) noexcept
	{
		if ((addr & 0xfff) + sizeof(T) <= 0x1000) [[likely]]
		{
			std::memcpy(vm::web_ptr(addr), &value, sizeof(T));
			vm::web_note_write(addr, sizeof(T));
			return;
		}
		vm::web_copy_range(addr, &value, sizeof(value), true);
	}

	std::atomic<bool> s_initialized{false};
	std::atomic<bool> s_null_renderer{false};
	std::atomic<bool> s_direct_renderer{false};
	std::mutex s_host_task_mutex;
	std::deque<std::function<void()>> s_host_tasks;

	// Frame-indexed pad schedule (input trace replay). Entries are applied on
	// the RSX thread when the flip with the given index is produced, so a
	// recorded trace replays at the same guest frames regardless of host timing.
	struct pad_schedule_entry
	{
		u32 frame;
		u32 digital1, digital2, left_x, left_y, right_x, right_y;
	};
	std::mutex s_pad_schedule_mutex;
	std::vector<pad_schedule_entry> s_pad_schedule;
	usz s_pad_schedule_cursor = 0;
	std::atomic<u32> s_pad_schedule_applied{0};

	void apply_pad_schedule(u32 flips)
	{
		std::lock_guard lock(s_pad_schedule_mutex);
		while (s_pad_schedule_cursor < s_pad_schedule.size() && s_pad_schedule[s_pad_schedule_cursor].frame <= flips)
		{
			const auto& e = s_pad_schedule[s_pad_schedule_cursor++];
			web_pad::set_state(e.digital1, e.digital2, e.left_x, e.left_y, e.right_x, e.right_y);
			s_pad_schedule_applied++;
		}
	}
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

		// RPCS3's "main thread" is the Emscripten main runtime thread: the
		// JavaScript worker that owns the module, which drains this queue on
		// its event-loop ticks (rpcs3_web_run_host_tasks). Running the
		// function inline on an emulation thread is wrong in general and
		// deadlocks the stop sequence: Emulator::Kill hands the join thread's
		// last owner to the main thread, and destroying it from the join
		// thread itself joins forever.
		callbacks.call_from_main_thread = [](std::function<void()> fn, atomic_t<u32>* wake_up)
		{
			auto task = [fn = std::move(fn), wake_up]()
			{
				fn();
				if (wake_up)
				{
					*wake_up = 1;
					wake_up->notify_one();
				}
			};

			if (emscripten_is_main_runtime_thread())
			{
				task();
				return;
			}

			std::lock_guard lock(s_host_task_mutex);
			s_host_tasks.emplace_back(std::move(task));
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
			else if (s_direct_renderer)
			{
				g_fxo->init<rsx::thread, named_thread<WebGPUDirectGSRender>>(ar);
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
		rsx::webgpu::host_command_queue().set_flip_callback(apply_pad_schedule);
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

	// Direct backend: the RSX thread calls WebGPU itself (emdawnwebgpu) instead of shipping packets
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_direct_renderer(s32 enabled)
	{
		s_direct_renderer = enabled != 0;
	}
	// Direct backend counters as JSON (draws, programs, pipelines, uploads, surface ops, unsupported)
	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_direct_stats()
	{
		static std::string buffer;
		buffer = "{}";
		if (auto* render = dynamic_cast<WebGPUDirectGSRender*>(g_fxo->try_get<rsx::thread>()))
		{
			const auto& s = render->m_stats;
			buffer = fmt::format("{\"draws\":%llu,\"drawsSkipped\":%llu,\"clears\":%llu,\"programs\":%llu,\"pipelines\":%llu,\"textureUploads\":%llu,\"textureInvalidations\":%llu,\"textureHits\":%llu,\"surfaceHits\":%llu,\"surfaceOps\":%llu,\"translationFailures\":%llu,\"unsupported\":%llu}",
				s.draws, s.draws_skipped, s.clears, s.programs, s.pipelines, s.texture_uploads, s.texture_invalidations, s.texture_hits, s.surface_hits, s.surface_ops, s.translation_failures, s.unsupported);
		}
		return buffer.c_str();
	}
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_rsx_spawn_flag_address()
	{
		return static_cast<u32>(reinterpret_cast<uptr>(&g_rpcs3_web_rsx_spawn_pending));
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

	// Direct dispatch: compiled blocks registered in the wasm function table run on the owning PPU pthread.
	// These are the imports the compiled modules bind to; they mirror the native link table entries.
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_ppu_aot_register_many(u32 pairs, u32 count)
	{
		ppu_web_aot_register(reinterpret_cast<const u32*>(static_cast<uptr>(pairs)), count);
	}

	// How many distinct compiled blocks this run has entered (diagnostic)
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_blocks_used()
	{
		return static_cast<u32>(ppu_web_blocks_used());
	}

	// The guest addresses this run entered, as a bitmap over 4-byte slots (build-ppu-aot-profile.mjs)
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_used_blocks(u32* out, u32 max)
	{
		return ppu_web_copy_used(out, max);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_ppu_set_block_base(u32 base)
	{
		ppu_web_set_block_base(base);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_exec_base()
	{
		return static_cast<u32>(reinterpret_cast<uptr>(ppu_web_aot_exec_base()));
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_aot_registered(u32 addr)
	{
		return ppu_web_aot_registered(addr);
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_aot_dispatches()
	{
		return g_ppu_web_aot_dispatch_count.load();
	}

	// __check: ppu_check
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_ppu_direct_check(u32 thread, u64 addr)
	{
		auto& ppu = *reinterpret_cast<ppu_thread*>(static_cast<uptr>(thread));
		ppu.cia = ::narrow<u32>(addr);
		static_cast<void>(ppu.test_stopped());
	}

	// __error: ppu_error sets cia and falls back to the interpreter, which the thread loop does on return
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_ppu_direct_error(u32 thread, u64 addr, u32 /*op*/)
	{
		auto& ppu = *reinterpret_cast<ppu_thread*>(static_cast<uptr>(thread));
		ppu.cia = ::narrow<u32>(addr);
	}

	// __syscall: ppu_execute_syscall (cia already stored by the compiled block)
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_ppu_direct_syscall(u32 thread, u64 code)
	{
		ppu_execute_syscall(*reinterpret_cast<ppu_thread*>(static_cast<uptr>(thread)), code);
	}

	// __lv1call has no native binding; the interpreter executes the SC instruction at the stored cia
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_ppu_direct_lv1call(u32 /*thread*/, u64 /*code*/)
	{
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_direct_get_tb()
	{
		return get_timebased_time();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_direct_lwarx(u32 thread, u64 addr)
	{
		return ppu_lwarx(*reinterpret_cast<ppu_thread*>(static_cast<uptr>(thread)), static_cast<u32>(addr));
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_ppu_direct_ldarx(u32 thread, u64 addr)
	{
		return ppu_ldarx(*reinterpret_cast<ppu_thread*>(static_cast<uptr>(thread)), static_cast<u32>(addr));
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_direct_stwcx(u32 thread, u64 addr, u32 value)
	{
		return ppu_stwcx(*reinterpret_cast<ppu_thread*>(static_cast<uptr>(thread)), static_cast<u32>(addr), value);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_ppu_direct_stdcx(u32 thread, u64 addr, u64 value)
	{
		return ppu_stdcx(*reinterpret_cast<ppu_thread*>(static_cast<uptr>(thread)), static_cast<u32>(addr), value);
	}

	// Direct SPU dispatch: the imports of compiled SPU blocks, mirroring the helpers the native
	// LLVM recompiler binds (SPULLVMRecompiler.cpp exec_*), running on the owning SPU pthread.
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_aot_register_many(u32 pairs, u32 count)
	{
		spu_web_aot_register(reinterpret_cast<const u32*>(static_cast<uptr>(pairs)), count);
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_spu_aot_dispatches()
	{
		return spu_web_aot_dispatch_count();
	}

	// SPU wasm recompiler self-test over an SPU cache image (see spu_web_wasm_selftest)
	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_spu_wasm_selftest(const u8* cache, u32 size)
	{
		static std::string report;
		report = spu_web_wasm_selftest(cache, size);
		return report.c_str();
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_spu_hot_report()
	{
		static std::string report;
		report = spu_web_hot_report();
		return report.c_str();
	}

	// Misses at an unlisted block start before the recompilers compile it (default 256)
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_set_hot_threshold(u32 misses)
	{
		g_spu_web_hot_threshold = misses ? misses : 256;
	}

	// Hot module registry (rpcs3_web_spu_hot_sync places entries [placed, count) in a worker's table)
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_set_hot_table_base(u32 base)
	{
		spu_web_set_hot_table_base(base);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_hot_count()
	{
		return spu_web_hot_count();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_hot_index(u32 i)
	{
		return spu_web_hot_index(i);
	}

	EMSCRIPTEN_KEEPALIVE const u8* rpcs3_web_spu_hot_bytes(u32 i)
	{
		return spu_web_hot_bytes(i);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_hot_info(u32 i, u32* out)
	{
		spu_web_hot_info(i, out);
	}

	// LLVM tier (web/public/rpcs3-spu-llvm.mjs drives the compiler workers from the module thread)
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_llvm_set_enabled(s32 enabled)
	{
		spu_web_llvm_set_enabled(enabled != 0);
	}

	EMSCRIPTEN_KEEPALIVE s32 rpcs3_web_spu_llvm_poll()
	{
		return spu_web_llvm_poll();
	}

	EMSCRIPTEN_KEEPALIVE const u8* rpcs3_web_spu_llvm_slot_ls(u32 i)
	{
		return spu_web_llvm_slot_ls(i);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_llvm_slot_pc(u32 i)
	{
		return spu_web_llvm_slot_pc(i);
	}

	// The compiler worker's answer: side module bytes from malloc (the waiting SPU LLVM worker thread
	// registers and frees them), or null with size 0 on failure
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_llvm_slot_finish(u32 i, u8* bytes, u32 size, u32 memory_size, u32 memory_align, u32 table_size, u32 imports_table)
	{
		spu_web_llvm_slot_finish(i, bytes, size, memory_size, memory_align, table_size, imports_table);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_hot_size(u32 i)
	{
		return spu_web_hot_size(i);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_miss_count()
	{
		return spu_web_miss_count();
	}

	// Pointer to the recorded SPU programs (SPU cache format); size through rpcs3_web_spu_miss_size
	EMSCRIPTEN_KEEPALIVE const u8* rpcs3_web_spu_miss_data()
	{
		return spu_web_miss_data().first;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_miss_size()
	{
		return spu_web_miss_data().second;
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_spu_aot_fallbacks()
	{
		return spu_web_aot_fallback_count();
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_spu_fallback_histogram(s32 enabled)
	{
		g_spu_web_fallback_histogram = enabled != 0;
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_spu_aot_fallback_report(u32 top)
	{
		static std::string report;
		report = spu_web_aot_fallback_report(top);
		return report.c_str();
	}

	static spu_thread& spu_direct(u32 thread)
	{
		return *reinterpret_cast<spu_thread*>(static_cast<uptr>(thread));
	}

	// spu_escape: unwind to the SPU thread's interpreter loop (never returns)
	[[noreturn]] EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_escape(u32 thread)
	{
		spu_web_escape_now(&spu_direct(thread));
	}

	// spu_dispatch / spu_dispatcher: the block could not continue (verification or an unresolved
	// target); pc is already stored, the thread loop re-dispatches
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_dispatch(u32 /*thread*/, u32 /*ls*/, u64 /*arg2*/)
	{
	}

	// spu_dispatcher is declared as a pointer-returning function by the translator (the address of the
	// native ubertrampoline); nothing on the table path calls through it
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_dispatcher_address()
	{
		return 0;
	}

	// branch patchpoints: same contract, pc already stored
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_patchpoint(u32 /*thread*/, u32 /*ls*/, u32 /*base_pc*/)
	{
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_check_state(u32 thread)
	{
		return spu_direct(thread).check_state();
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_mfc_cmd(u32 thread)
	{
		auto& spu = spu_direct(thread);
		spu.unsavable = true;

		if (!spu.process_mfc_cmd() || spu.state & cpu_flag::again)
		{
			fmt::throw_exception("exec_mfc_cmd(): Should not abort!");
		}

		static_cast<void>(spu.test_stopped());
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_mfc_cmd_saveable(u32 thread)
	{
		auto& spu = spu_direct(thread);

		if (!spu.process_mfc_cmd() || spu.state & cpu_flag::again)
		{
			fmt::throw_exception("exec_mfc_cmd(): Should not abort!");
		}

		static_cast<void>(spu.test_stopped());
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_read_channel(u32 thread, u32 ch)
	{
		auto& spu = spu_direct(thread);
		const s64 result = spu.get_ch_value(ch);

		if (result < 0 || spu.state & cpu_flag::again)
		{
			spu_web_escape_now(&spu);
		}

		static_cast<void>(spu.test_stopped());
		return static_cast<u32>(result & 0xffffffff);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_read_channel_count(u32 thread, u32 ch)
	{
		return spu_direct(thread).get_ch_count(ch);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_read_in_mbox(u32 thread)
	{
		return rpcs3_web_spu_direct_read_channel(thread, SPU_RdInMbox);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_read_decrementer(u32 thread)
	{
		auto& spu = spu_direct(thread);
		const u32 res = spu.read_dec().first;

		if (res > 1500 && g_cfg.core.spu_loop_detection)
		{
			spu.state += cpu_flag::wait;
			std::this_thread::yield();
			static_cast<void>(spu.test_stopped());
		}

		return res;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_read_events(u32 thread)
	{
		return rpcs3_web_spu_direct_read_channel(thread, SPU_RdEventStat);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_get_events(u32 thread, u32 mask)
	{
		return spu_direct(thread).get_events(mask).count;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_write_channel(u32 thread, u32 ch, u32 value)
	{
		auto& spu = spu_direct(thread);

		if (!spu.set_ch_value(ch, value) || spu.state & cpu_flag::again)
		{
			spu_web_escape_now(&spu);
		}

		static_cast<void>(spu.test_stopped());
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_list_unstall(u32 thread, u32 tag)
	{
		auto& spu = spu_direct(thread);

		for (u32 i = 0; i < spu.mfc_size; i++)
		{
			if (spu.mfc_queue[i].tag == (tag | 0x80))
			{
				spu.mfc_queue[i].tag &= 0x7f;
			}
		}

		spu.do_mfc();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_check_interrupts(u32 thread, u32 addr)
	{
		auto& spu = spu_direct(thread);
		spu.set_interrupt_status(true);

		if (spu.ch_events.load().count)
		{
			spu.interrupts_enabled = false;
			spu.srr0 = addr;

			// Test for BR/BRA instructions (they are equivalent at zero pc)
			const u32 br = spu._ref<const u32>(0);

			if ((br & 0xfd80007f) == 0x30000000)
			{
				return (br >> 5) & 0x3fffc;
			}

			return 0;
		}

		return addr;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_syscall(u32 thread, u32 code)
	{
		auto& spu = spu_direct(thread);

		if (!spu.stop_and_signal(code) || spu.state & cpu_flag::again)
		{
			spu_web_escape_now(&spu);
		}

		if (spu.test_stopped())
		{
			spu.pc += 4;
			spu_web_escape_now(&spu);
		}
	}

	[[noreturn]] EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_unknown(u32 /*thread*/, u32 op)
	{
		fmt::throw_exception("Unknown/Illegal instruction (0x%08x)", op);
	}

	[[noreturn]] EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_fatal(u32 /*thread*/, u32 code)
	{
		fmt::throw_exception("SPU compiled block raised fatal signal '%s'", std::string_view(reinterpret_cast<const char*>(&code), 4));
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_spu_direct_memcpy(u32 dst, u32 src, u32 size)
	{
		std::memcpy(reinterpret_cast<void*>(static_cast<uptr>(dst)), reinterpret_cast<const void*>(static_cast<uptr>(src)), size);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_wait_on_channel(u32 thread, u32 channel, u32 is_read)
	{
		auto& spu = spu_direct(thread);
		const auto ch = reinterpret_cast<spu_channel*>(static_cast<uptr>(channel));

		if (is_read)
		{
			ch->pop_wait(spu, false);
		}
		else
		{
			ch->push_wait(spu, 0, false);
		}

		return ch->get_count();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_spu_direct_wait_inbox(u32 thread, u32 channel)
	{
		auto& spu = spu_direct(thread);
		const auto ch = reinterpret_cast<spu_channel_4_t*>(static_cast<uptr>(channel));
		ch->pop_wait(spu, false);
		return ch->get_count();
	}

	EMSCRIPTEN_KEEPALIVE u64 rpcs3_web_spu_direct_get_tb()
	{
		return get_timebased_time();
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

	// Diagnosis: log SPU channel traffic for pcs in [lo, hi)
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_spu_trace_range(u32 lo, u32 hi)
	{
		g_spu_web_trace_lo = lo;
		g_spu_web_trace_hi = hi;
	}

	// RPCS3's own resolution scaling (rsx::surface_scaling_config_t from g_cfg.video): the surface
	// store creates images at this scale, the way the Vulkan backend does. Applied at boot.
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_resolution_scale(u32 percent)
	{
		g_cfg.video.resolution_scale_percent.set(std::clamp(percent, 50u, 800u));
	}
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_clock_scale(u32 percent)
	{
		g_rpcs3_web_clocks_scale = std::clamp(percent, 10u, 3000u);
		g_cfg.core.clocks_scale.set(g_rpcs3_web_clocks_scale);
	}

	// RPCS3's SPU decoder choice (system_config.h): 0 static interpreter, 1 asmjit (the SPU->wasm
	// recompiler as the fast tier), 2 llvm (adds the SPU LLVM thread, compiling in the browser's
	// compiler workers). Applied before boot.
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_spu_decoder(u32 decoder)
	{
		// Emulator::Init() resets the config on Load and reapplies this global (System.cpp)
		g_rpcs3_web_spu_decoder = decoder == 2 ? spu_decoder_type::llvm : decoder == 1 ? spu_decoder_type::asmjit : spu_decoder_type::_static;
		g_cfg.core.spu_decoder.set(g_rpcs3_web_spu_decoder);
	}

	// How much code the analyser may take into one SPU program: 0 safe, 1 mega, 2 giga. Bigger
	// programs mean fewer dispatches out of the SPU thread loop.
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_set_spu_block_size(u32 size)
	{
		g_rpcs3_web_spu_block_size = size == 2 ? spu_block_size_type::giga : size == 1 ? spu_block_size_type::mega : spu_block_size_type::safe;
		g_cfg.core.spu_block_size.set(g_rpcs3_web_spu_block_size);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_webgpu_set_texture_hash_per_draw(s32 enabled)
	{
		rsx_webgpu_set_texture_hash_per_draw(enabled != 0);
	}

	// The renderer never received this texture's payload: drop it from the builder's residency
	EMSCRIPTEN_KEEPALIVE void rpcs3_webgpu_texture_forget(u32 address, u32 format, u32 width, u32 height, u32 depth, u32 pitch,
		u32 mip_count, u32 dimension, u32 content_hash, u32 remap, u32 address_modes, u32 filter_modes)
	{
		if (auto* render = dynamic_cast<WebGPUGSRender*>(g_fxo->try_get<rsx::thread>()))
		{
			rsx::webgpu::texture_packet_record key{};
			key.address = address; key.format = format; key.width = width; key.height = height; key.depth = depth; key.pitch = pitch;
			key.mip_count = mip_count; key.dimension = dimension; key.content_hash = content_hash; key.remap = remap;
			key.address_modes = address_modes; key.filter_modes = filter_modes;
			render->forget_texture(key);
		}
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

	EMSCRIPTEN_KEEPALIVE void rpcs3_web_pad_schedule_clear()
	{
		std::lock_guard lock(s_pad_schedule_mutex);
		s_pad_schedule.clear();
		s_pad_schedule_cursor = 0;
		s_pad_schedule_applied = 0;
	}

	// Entries must be added in non-decreasing frame order.
	EMSCRIPTEN_KEEPALIVE void rpcs3_web_pad_schedule_add(u32 frame, u32 digital1, u32 digital2, u32 left_x, u32 left_y, u32 right_x, u32 right_y)
	{
		std::lock_guard lock(s_pad_schedule_mutex);
		s_pad_schedule.push_back({frame, digital1, digital2, left_x, left_y, right_x, right_y});
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_pad_schedule_applied()
	{
		return s_pad_schedule_applied;
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

	// Names of RPCS3 threads currently running, one per line.
	EMSCRIPTEN_KEEPALIVE const char* rpcs3_web_live_thread_names()
	{
		static std::string names;
		names = thread_ctrl::web_live_thread_names();
		return names.c_str();
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
			// Kill is asynchronous: the join thread stops the emulation threads
			// and they record their stack high-water marks as they exit. The
			// browser polls rpcs3_web_is_stopped instead of blocking this
			// (event-loop) thread, which Emscripten proxies thread cleanup through.
			Emu.Kill(false);
		}
	}

	// Run functions RPCS3 queued for its main thread. Called by the worker
	// on every event-loop tick it owns (progress, frame waits, shutdown).
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_run_host_tasks()
	{
		u32 executed = 0;
		for (;;)
		{
			std::function<void()> task;
			{
				std::lock_guard lock(s_host_task_mutex);
				if (s_host_tasks.empty())
				{
					break;
				}
				task = std::move(s_host_tasks.front());
				s_host_tasks.pop_front();
			}
			task();
			executed++;
		}
		return executed;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_web_is_stopped()
	{
		return !s_initialized || Emu.IsStopped(true) ? 1u : 0u;
	}
}

int main()
{
	return 0;
}
