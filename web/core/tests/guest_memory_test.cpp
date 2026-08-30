#include "guest_memory.hpp"
#include "ppu_interpreter.hpp"
#include "ppu_elf_loader.hpp"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <ranges>
#include <vector>

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

    std::ifstream fixture(std::string{RPCS3_SOURCE_DIR} + "/bin/test/ppu_thread.elf", std::ios::binary | std::ios::ate);
    assert(fixture);
    const auto fixture_size = fixture.tellg();
    assert(fixture_size > 0);
    fixture.seekg(0);
    std::vector<std::byte> fixture_bytes(static_cast<std::size_t>(fixture_size));
    fixture.read(reinterpret_cast<char*>(fixture_bytes.data()), fixture_size);
    assert(fixture);

    guest_memory elf_memory;
    const auto loaded = rpcs3::web::load_ppu_elf(fixture_bytes, elf_memory);
    assert(loaded);
    assert(loaded.entry == 0x0001022c);
    assert(loaded.toc == 0x00038b50);
    assert(loaded.segments == 2);
    assert(loaded.tls_address == 0x00030e0c);
    assert(loaded.tls_file_size == 0);
    assert(loaded.tls_memory_size == 0x84);
    assert(loaded.imports.size() == 17);
    const auto tls_import = std::ranges::find_if(loaded.imports, [](const auto& item) { return item.nid == 0x744680a2; });
    assert(tls_import != loaded.imports.end());
    assert(tls_import->module == "sysPrxForUser");
    assert(tls_import->call_address == 0x00025c5c);
    assert(elf_memory.map(0xd0000000, 2 * 1024 * 1024, page_access::read_write));
    rpcs3::web::ppu_interpreter elf_interpreter(elf_memory);
    elf_interpreter.state().pc = loaded.entry;
    elf_interpreter.state().gpr[1] = 0xd0200000;
    elf_interpreter.state().gpr[2] = loaded.toc;
    elf_interpreter.run(1000);
    assert(elf_interpreter.state().instructions == 38);
    assert(elf_interpreter.state().stop_reason == rpcs3::web::ppu_stop_reason::hle_call);
    assert(elf_interpreter.state().pc == 0x00025c5c);
    assert(elf_interpreter.state().ctr == 0x39800000);
    return 0;
}
