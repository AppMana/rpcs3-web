#include "guest_memory.hpp"
#include "ppu_elf_loader.hpp"
#include "ppu_hle.hpp"
#include "ppu_interpreter.hpp"

#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace
{
    struct tracing_hle_context
    {
        rpcs3::web::ppu_hle_context inner;
        bool enabled = false;
    };

    bool handle_hle(rpcs3::web::ppu_state& state, rpcs3::web::guest_memory& memory, std::uint32_t call_address, void* opaque)
    {
        auto& context = *static_cast<tracing_hle_context*>(opaque);
        const rpcs3::web::ppu_import_stub* import = nullptr;
        for (const auto& item : context.inner.elf->imports)
        {
            if (item.call_address == call_address)
            {
                import = &item;
                break;
            }
        }
        if (context.enabled && import)
            std::cerr << "HLE pc=0x" << std::hex << call_address << ' ' << import->module << " nid=0x" << import->nid
                      << " r3=0x" << state.gpr[3] << " r4=0x" << state.gpr[4] << std::dec << '\n';
        const bool handled = rpcs3::web::handle_minimal_ppu_hle(state, memory, call_address, &context.inner);
        if (context.enabled)
            std::cerr << "  handled=" << handled << " result=0x" << std::hex << state.gpr[3] << std::dec << '\n';
        return handled;
    }

    bool handle_syscall(rpcs3::web::ppu_state& state, rpcs3::web::guest_memory& memory, std::uint32_t syscall, void* opaque)
    {
        auto& context = *static_cast<tracing_hle_context*>(opaque);
        if (context.enabled)
            std::cerr << "SYSCALL " << syscall << " r3=0x" << std::hex << state.gpr[3] << " r4=0x" << state.gpr[4] << std::dec << '\n';
        const bool handled = rpcs3::web::handle_minimal_ppu_syscall(state, memory, syscall, &context.inner);
        if (context.enabled)
            std::cerr << "  handled=" << handled << " result=0x" << std::hex << state.gpr[3] << std::dec << '\n';
        return handled;
    }

    std::vector<std::byte> read_image(const char* path)
    {
        std::ifstream stream(path, std::ios::binary);
        std::vector<char> input{std::istreambuf_iterator<char>{stream}, {}};
        std::vector<std::byte> output(input.size());
        for (std::size_t index = 0; index < input.size(); ++index)
            output[index] = static_cast<std::byte>(static_cast<unsigned char>(input[index]));
        return output;
    }
}

int main(int argc, char** argv)
{
    if (argc < 2 || argc > 3)
    {
        std::cerr << "usage: rpcs3_web_fixture_runner ELF [INSTRUCTION_LIMIT]\n";
        return 2;
    }

    std::size_t instruction_limit = 10'000'000;
    if (argc == 3)
    {
        const std::string value = argv[2];
        const auto parsed = std::from_chars(value.data(), value.data() + value.size(), instruction_limit);
        if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size() || instruction_limit == 0)
        {
            std::cerr << "invalid instruction limit\n";
            return 2;
        }
    }

    const auto image = read_image(argv[1]);
    if (image.empty())
    {
        std::cerr << "could not read ELF\n";
        return 2;
    }

    rpcs3::web::guest_memory memory;
    const auto elf = rpcs3::web::load_ppu_elf(image, memory);
    if (!elf)
    {
        std::cerr << "ELF load error " << static_cast<unsigned>(elf.error) << '\n';
        return 1;
    }

    constexpr std::uint32_t stack_base = 0xd0000000;
    constexpr std::uint32_t stack_size = 2 * 1024 * 1024;
    constexpr std::uint32_t launch_data = 0x50000000;
    if (!memory.map(stack_base, stack_size, rpcs3::web::page_access::read_write) ||
        !memory.map(launch_data, rpcs3::web::guest_memory::page_size, rpcs3::web::page_access::read_write))
    {
        std::cerr << "launch memory map failed\n";
        return 1;
    }

    rpcs3::web::ppu_interpreter interpreter(memory);
    auto& state = interpreter.state();
    state.pc = elf.entry;
    state.gpr[1] = static_cast<std::uint64_t>(stack_base) + stack_size;
    state.gpr[2] = elf.toc;
    state.gpr[4] = launch_data;
    state.gpr[5] = launch_data + 0x100;
    state.gpr[7] = 1;
    state.gpr[8] = elf.tls_address;
    state.gpr[9] = elf.tls_file_size;
    state.gpr[10] = elf.tls_memory_size;
    state.gpr[11] = elf.entry_descriptor;
    state.gpr[12] = elf.malloc_page_size;

    tracing_hle_context trace{{.elf = &elf}, std::getenv("RPCS3_WEB_TRACE") != nullptr};
    interpreter.set_hle_handler(&handle_hle, &trace);
    interpreter.set_syscall_handler(&handle_syscall, &trace);
    std::deque<std::pair<std::uint32_t, std::uint32_t>> recent;
    while (state.stop_reason == rpcs3::web::ppu_stop_reason::running && state.instructions < instruction_limit)
    {
        const std::uint32_t pc = state.pc;
        interpreter.step();
        recent.emplace_back(pc, state.last_opcode);
        if (recent.size() > 32) recent.pop_front();
    }
    auto& hle = trace.inner;
    if (trace.enabled && state.stop_reason != rpcs3::web::ppu_stop_reason::running)
    {
        std::cerr << "RECENT\n";
        for (const auto& [pc, opcode] : recent)
            std::cerr << "  0x" << std::hex << pc << ": 0x" << opcode << std::dec << '\n';
    }

    const rpcs3::web::ppu_import_stub* unresolved = nullptr;
    for (const auto& item : elf.imports)
    {
        if (item.call_address == state.pc)
        {
            unresolved = &item;
            break;
        }
    }

    std::cout << "fixture=" << argv[1]
              << " imports=" << elf.imports.size()
              << " instructions=" << state.instructions
              << " stop=" << static_cast<unsigned>(state.stop_reason)
              << " pc=0x" << std::hex << state.pc
              << " opcode=0x" << state.last_opcode
              << " target=0x" << state.ctr
              << " last_nid=0x" << hle.last_nid << std::dec
              << " hle_calls=" << hle.calls
              << " syscalls=" << hle.syscalls
              << " syscall_number=" << state.gpr[11]
              << " last_syscall=" << hle.last_syscall
              << " tty_bytes=" << hle.tty_output.size()
              << " fs_path=" << hle.last_fs_path
              << " gcm_initialized=" << hle.gcm_initialized
              << " gcm_words=" << hle.gcm_command_words.size()
              << " flips=" << hle.gcm_flip_count
              << " vertices=" << hle.gcm_vertices.size()
              << " rt=" << ((state.last_opcode >> 21) & 31)
              << " ra=" << ((state.last_opcode >> 16) & 31)
              << " rt_value=0x" << std::hex << state.gpr[(state.last_opcode >> 21) & 31]
              << " ra_value=0x" << state.gpr[(state.last_opcode >> 16) & 31] << std::dec;
    if (unresolved)
        std::cout << " unresolved_module=" << unresolved->module << " unresolved_nid=0x" << std::hex << unresolved->nid << std::dec;
    std::cout << '\n';
    if (std::getenv("RPCS3_WEB_GCM_DUMP"))
    {
        for (std::size_t index = 0; index < hle.gcm_vertices.size(); ++index)
        {
            const auto& vertex = hle.gcm_vertices[index];
            std::cout << "vertex[" << index << "]=" << vertex.x << ',' << vertex.y << ',' << vertex.z << ',' << vertex.w
                      << " color=" << static_cast<unsigned>(vertex.color[0]) << ',' << static_cast<unsigned>(vertex.color[1])
                      << ',' << static_cast<unsigned>(vertex.color[2]) << ',' << static_cast<unsigned>(vertex.color[3]) << '\n';
        }
        for (std::size_t index = 0; index < hle.gcm_command_words.size(); ++index)
            std::cout << "gcm[" << index << "]=0x" << std::hex << hle.gcm_command_words[index] << std::dec << '\n';
    }
    return 0;
}
