#include "guest_memory.hpp"
#include "ppu_interpreter.hpp"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>

int main()
{
    using rpcs3::web::guest_memory;
    using rpcs3::web::page_access;

    guest_memory memory;
    assert(memory.map(0x00010000, 3 * guest_memory::page_size, page_access::read_write));
    assert(!memory.map(0x00010000, guest_memory::page_size, page_access::read));
    assert(memory.mapped_pages() == 3);
    assert(memory.resident_pages() == 0);

    std::array<std::byte, 6> input{
        std::byte{0xaa}, std::byte{0xbb}, std::byte{0xcc},
        std::byte{0xdd}, std::byte{0xee}, std::byte{0xff},
    };
    std::array<std::byte, 6> output{};
    assert(memory.write(0x00010ffd, input));
    assert(memory.resident_pages() == 2);
    assert(memory.read(0x00010ffd, output));
    assert(output == input);

    assert(memory.map_alias(0xc0000000, 0x00010000, 2 * guest_memory::page_size, page_access::read));
    std::array<std::byte, 6> alias_output{};
    assert(memory.read(0xc0000ffd, alias_output));
    assert(alias_output == input);
    assert(!memory.write(0xc0000000, input));

    assert(memory.store_be<std::uint32_t>(0x00012000, 0x12345678u));
    std::uint32_t value = 0;
    assert(memory.load_be(0x00012000, value));
    assert(value == 0x12345678u);

    assert(memory.protect(0x00012000, guest_memory::page_size, page_access::read));
    assert(!memory.write(0x00012000, input));
    assert(memory.unmap(0x00012000, guest_memory::page_size));
    assert(!memory.read(0x00012000, output));
    assert(!memory.map(0xfffff000, 2 * guest_memory::page_size, page_access::read));

    const auto ppu = rpcs3::web::run_ppu_smoke();
    assert(ppu.failure_mask == 0);
    assert(ppu.stop_reason == rpcs3::web::ppu_stop_reason::syscall);
    assert(ppu.instructions == 46);
    assert(ppu.result_register == 70);
    assert(ppu.loaded_register == 70);
    assert(ppu.stored_value == 70);
    return 0;
}
