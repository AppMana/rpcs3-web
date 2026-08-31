#include "guest_memory.hpp"
#include "ppu_interpreter.hpp"
#include "ppu_elf_loader.hpp"
#include "ppu_hle.hpp"

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <memory>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define RPCS3_WEB_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define RPCS3_WEB_EXPORT extern "C"
#endif

namespace
{
    std::unique_ptr<rpcs3::web::guest_memory> memory;
    rpcs3::web::ppu_smoke_result ppu_result;
    rpcs3::web::ppu_elf_load_result elf_result;
    rpcs3::web::ppu_state elf_state;
    rpcs3::web::ppu_hle_context hle_context;
    std::unique_ptr<rpcs3::web::guest_memory> session_memory;
    std::unique_ptr<rpcs3::web::ppu_interpreter> session_interpreter;
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_abi_version()
{
    return 7;
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_memory()
{
    using rpcs3::web::page_access;
    memory = std::make_unique<rpcs3::web::guest_memory>();
    int failures = 0;
    failures |= memory->map(0x00010000, 3 * memory->page_size, page_access::read_write) ? 0 : 1;

    const std::array input{std::byte{0x12}, std::byte{0x34}, std::byte{0x56}, std::byte{0x78}};
    std::array<std::byte, input.size()> output{};
    failures |= memory->write(0x00010ffe, input) ? 0 : 2;
    failures |= memory->read(0x00010ffe, output) && output == input ? 0 : 4;
    failures |= memory->protect(0x00011000, memory->page_size, page_access::read) ? 0 : 8;
    failures |= !memory->write(0x00011000, input) ? 0 : 16;
    failures |= memory->map_alias(0xc0000000, 0x00010000, 2 * memory->page_size, page_access::read) ? 0 : 32;
    std::uint32_t value = 0;
    failures |= memory->load_be(0xc0000ffe, value) && value == 0x12345678u ? 0 : 64;
    return failures;
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_mapped_pages()
{
    return memory ? static_cast<int>(memory->mapped_pages()) : 0;
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_resident_pages()
{
    return memory ? static_cast<int>(memory->resident_pages()) : 0;
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_ppu()
{
    ppu_result = rpcs3::web::run_ppu_smoke();
    return static_cast<int>(ppu_result.failure_mask);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_ppu_steps()
{
    return static_cast<int>(ppu_result.instructions);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_ppu_result()
{
    return static_cast<int>(ppu_result.result_register);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_ppu_loaded()
{
    return static_cast<int>(ppu_result.loaded_register);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_ppu_supported_opcodes()
{
    return static_cast<int>(rpcs3::web::ppu_interpreter::supported_instruction_count);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf(const unsigned char* data, int size, int instruction_limit)
{
    elf_result = {};
    elf_state = {};
    hle_context = {};
    if (!data || size <= 0 || instruction_limit <= 0) return 1;
    session_interpreter.reset();
    session_memory = std::make_unique<rpcs3::web::guest_memory>();
    elf_result = rpcs3::web::load_ppu_elf(
        std::span{reinterpret_cast<const std::byte*>(data), static_cast<std::size_t>(size)}, *session_memory);
    if (!elf_result) return 2;

    constexpr std::uint32_t stack_base = 0xd0000000;
    constexpr std::uint32_t stack_size = 2 * 1024 * 1024;
    if (!session_memory->map(stack_base, stack_size, rpcs3::web::page_access::read_write)) return 4;
    constexpr std::uint32_t launch_data = 0x50000000;
    if (!session_memory->map(launch_data, rpcs3::web::guest_memory::page_size, rpcs3::web::page_access::read_write)) return 4;
    session_interpreter = std::make_unique<rpcs3::web::ppu_interpreter>(*session_memory);
    auto& state = session_interpreter->state();
    state.pc = elf_result.entry;
    state.gpr[1] = static_cast<std::uint64_t>(stack_base) + stack_size;
    state.gpr[2] = elf_result.toc;
    state.gpr[3] = 0;
    state.gpr[4] = launch_data;
    state.gpr[5] = launch_data + 0x100;
    state.gpr[6] = 0;
    state.gpr[7] = 1;
    state.gpr[8] = elf_result.tls_address;
    state.gpr[9] = elf_result.tls_file_size;
    state.gpr[10] = elf_result.tls_memory_size;
    state.gpr[11] = elf_result.entry_descriptor;
    state.gpr[12] = elf_result.malloc_page_size;
    hle_context.elf = &elf_result;
    session_interpreter->set_hle_handler(&rpcs3::web::handle_minimal_ppu_hle, &hle_context);
    session_interpreter->set_syscall_handler(&rpcs3::web::handle_minimal_ppu_syscall, &hle_context);
    while (state.stop_reason == rpcs3::web::ppu_stop_reason::running &&
        state.instructions < static_cast<std::size_t>(instruction_limit) && hle_context.gcm_flip_count == 0)
        session_interpreter->step();
    elf_state = state;
    return elf_state.instructions == 0 ? 8 : 0;
}

RPCS3_WEB_EXPORT int rpcs3_web_session_run_until_flip(int instruction_limit)
{
    if (!session_interpreter || instruction_limit <= 0) return 3;
    auto& state = session_interpreter->state();
    if (state.stop_reason != rpcs3::web::ppu_stop_reason::running) return 2;
    const std::uint32_t starting_flip = hle_context.gcm_flip_count;
    const std::uint64_t end = state.instructions + static_cast<std::uint64_t>(instruction_limit);
    while (state.stop_reason == rpcs3::web::ppu_stop_reason::running && state.instructions < end &&
        hle_context.gcm_flip_count == starting_flip)
        session_interpreter->step();
    elf_state = state;
    if (hle_context.gcm_flip_count != starting_flip) return 0;
    return state.stop_reason == rpcs3::web::ppu_stop_reason::running ? 1 : 2;
}

RPCS3_WEB_EXPORT void rpcs3_web_session_set_pad(int digital1, int digital2, int left_x, int left_y, int right_x, int right_y)
{
    hle_context.pad_digital1 = static_cast<std::uint16_t>(digital1);
    hle_context.pad_digital2 = static_cast<std::uint16_t>(digital2);
    hle_context.pad_left_x = static_cast<std::uint8_t>(left_x);
    hle_context.pad_left_y = static_cast<std::uint8_t>(left_y);
    hle_context.pad_right_x = static_cast<std::uint8_t>(right_x);
    hle_context.pad_right_y = static_cast<std::uint8_t>(right_y);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_loaded()
{
    return elf_result ? 1 : 0;
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_segments()
{
    return static_cast<int>(elf_result.segments);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_entry()
{
    return static_cast<int>(elf_result.entry);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_steps()
{
    return static_cast<int>(elf_state.instructions);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_stop_reason()
{
    return static_cast<int>(elf_state.stop_reason);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_pc()
{
    return static_cast<int>(elf_state.pc);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_last_opcode()
{
    return static_cast<int>(elf_state.last_opcode);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_target()
{
    return static_cast<int>(elf_state.ctr);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_hle_calls()
{
    return static_cast<int>(hle_context.calls);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_hle_nid()
{
    return static_cast<int>(hle_context.last_nid);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_syscalls()
{
    return static_cast<int>(hle_context.syscalls);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_elf_last_syscall()
{
    return static_cast<int>(hle_context.last_syscall);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_flip_count()
{
    return static_cast<int>(hle_context.gcm_flip_count);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_command_words()
{
    return static_cast<int>(hle_context.gcm_command_words.size());
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_vertex_count()
{
    return static_cast<int>(hle_context.gcm_vertices.size());
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_draw_count()
{
    return static_cast<int>(hle_context.gcm_draws.size());
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_draw_primitive(int draw)
{
    if (draw < 0 || static_cast<std::size_t>(draw) >= hle_context.gcm_draws.size()) return 0;
    return static_cast<int>(hle_context.gcm_draws[static_cast<std::size_t>(draw)].primitive);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_draw_vertex_count(int draw)
{
    if (draw < 0 || static_cast<std::size_t>(draw) >= hle_context.gcm_draws.size()) return 0;
    return static_cast<int>(hle_context.gcm_draws[static_cast<std::size_t>(draw)].vertices.size());
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_draw_vertex_component(int draw, int vertex, int component)
{
    if (draw < 0 || static_cast<std::size_t>(draw) >= hle_context.gcm_draws.size() || component < 0 || component > 3) return 0;
    const auto& item = hle_context.gcm_draws[static_cast<std::size_t>(draw)].vertices;
    if (vertex < 0 || static_cast<std::size_t>(vertex) >= item.size()) return 0;
    const float values[]{item[static_cast<std::size_t>(vertex)].x, item[static_cast<std::size_t>(vertex)].y,
        item[static_cast<std::size_t>(vertex)].z, item[static_cast<std::size_t>(vertex)].w};
    return static_cast<int>(std::bit_cast<std::uint32_t>(values[component]));
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_draw_vertex_color(int draw, int vertex)
{
    if (draw < 0 || static_cast<std::size_t>(draw) >= hle_context.gcm_draws.size()) return 0;
    const auto& items = hle_context.gcm_draws[static_cast<std::size_t>(draw)].vertices;
    if (vertex < 0 || static_cast<std::size_t>(vertex) >= items.size()) return 0;
    const auto& color = items[static_cast<std::size_t>(vertex)].color;
    return static_cast<int>((static_cast<std::uint32_t>(color[0]) << 24) | (static_cast<std::uint32_t>(color[1]) << 16) |
        (static_cast<std::uint32_t>(color[2]) << 8) | color[3]);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_width()
{
    return static_cast<int>(hle_context.gcm_frame_width);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_height()
{
    return static_cast<int>(hle_context.gcm_frame_height);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_clear_color()
{
    return static_cast<int>(hle_context.gcm_clear_color);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_primitive()
{
    return static_cast<int>(hle_context.gcm_primitive);
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_vertex_component(int vertex, int component)
{
    if (vertex < 0 || static_cast<std::size_t>(vertex) >= hle_context.gcm_vertices.size() || component < 0 || component > 3) return 0;
    const auto& item = hle_context.gcm_vertices[static_cast<std::size_t>(vertex)];
    const float values[]{item.x, item.y, item.z, item.w};
    return static_cast<int>(std::bit_cast<std::uint32_t>(values[component]));
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_gcm_vertex_color(int vertex)
{
    if (vertex < 0 || static_cast<std::size_t>(vertex) >= hle_context.gcm_vertices.size()) return 0;
    const auto& color = hle_context.gcm_vertices[static_cast<std::size_t>(vertex)].color;
    return static_cast<int>((static_cast<std::uint32_t>(color[0]) << 24) | (static_cast<std::uint32_t>(color[1]) << 16) |
        (static_cast<std::uint32_t>(color[2]) << 8) | color[3]);
}

int main()
{
    return 0;
}
