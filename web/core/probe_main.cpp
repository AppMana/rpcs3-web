#include "guest_memory.hpp"
#include "ppu_interpreter.hpp"

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
}

RPCS3_WEB_EXPORT int rpcs3_web_probe_abi_version()
{
    return 2;
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

int main()
{
    return 0;
}
