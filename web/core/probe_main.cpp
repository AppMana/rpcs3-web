#include "guest_memory.hpp"
#include "ppu_interpreter.hpp"
#include "ppu_elf_loader.hpp"
#include "ppu_hle.hpp"

#include <array>
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
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_abi_version()
{
    return 5;
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
    auto memory = std::make_unique<rpcs3::web::guest_memory>();
    elf_result = rpcs3::web::load_ppu_elf(
        std::span{reinterpret_cast<const std::byte*>(data), static_cast<std::size_t>(size)}, *memory);
    if (!elf_result) return 2;

    constexpr std::uint32_t stack_base = 0xd0000000;
    constexpr std::uint32_t stack_size = 2 * 1024 * 1024;
    if (!memory->map(stack_base, stack_size, rpcs3::web::page_access::read_write)) return 4;
    constexpr std::uint32_t launch_data = 0x50000000;
    if (!memory->map(launch_data, rpcs3::web::guest_memory::page_size, rpcs3::web::page_access::read_write)) return 4;
    rpcs3::web::ppu_interpreter interpreter(*memory);
    interpreter.state().pc = elf_result.entry;
    interpreter.state().gpr[1] = static_cast<std::uint64_t>(stack_base) + stack_size;
    interpreter.state().gpr[2] = elf_result.toc;
    interpreter.state().gpr[3] = 0;
    interpreter.state().gpr[4] = launch_data;
    interpreter.state().gpr[5] = launch_data + 0x100;
    interpreter.state().gpr[6] = 0;
    interpreter.state().gpr[7] = 1;
    interpreter.state().gpr[8] = elf_result.tls_address;
    interpreter.state().gpr[9] = elf_result.tls_file_size;
    interpreter.state().gpr[10] = elf_result.tls_memory_size;
    hle_context.elf = &elf_result;
    interpreter.set_hle_handler(&rpcs3::web::handle_minimal_ppu_hle, &hle_context);
    interpreter.set_syscall_handler(&rpcs3::web::handle_minimal_ppu_syscall, &hle_context);
    interpreter.run(static_cast<std::size_t>(instruction_limit));
    elf_state = interpreter.state();
    return elf_state.instructions == 0 ? 8 : 0;
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

int main()
{
    return 0;
}
