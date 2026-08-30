#include "ppu_interpreter.hpp"

#include <array>
#include <cstdint>
#include <span>

namespace rpcs3::web
{
    namespace
    {
        constexpr std::uint32_t d_form(std::uint32_t main, std::uint32_t rt, std::uint32_t ra, std::int16_t immediate)
        {
            return (main << 26) | (rt << 21) | (ra << 16) | static_cast<std::uint16_t>(immediate);
        }

        constexpr std::uint32_t cmpi(std::uint32_t ra, std::int16_t immediate)
        {
            return (11u << 26) | (1u << 21) | (ra << 16) | static_cast<std::uint16_t>(immediate);
        }

        constexpr std::uint32_t bc(std::uint32_t bo, std::uint32_t bi, std::int16_t displacement)
        {
            return (16u << 26) | (bo << 21) | (bi << 16) | (static_cast<std::uint16_t>(displacement) & 0xfffc);
        }
    }

    ppu_smoke_result run_ppu_smoke()
    {
        constexpr std::uint32_t code_address = 0x00010000;
        constexpr std::uint32_t data_address = 0x00020000;
        constexpr std::array program{
            d_form(14, 3, 0, 0),                              // li r3, 0
            d_form(14, 4, 0, 10),                             // li r4, 10
            d_form(15, 5, 0, 2),                              // lis r5, 2
            d_form(14, 3, 3, 7),                              // loop: addi r3, r3, 7
            d_form(14, 4, 4, -1),                             // addi r4, r4, -1
            cmpi(4, 0),                                       // cmpdi cr0, r4, 0
            bc(4, 2, -12),                                    // bne loop
            d_form(36, 3, 5, 0),                              // stw r3, 0(r5)
            d_form(32, 6, 5, 0),                              // lwz r6, 0(r5)
            (17u << 26) | 2u,                                 // sc
        };

        guest_memory memory;
        ppu_smoke_result result;
        if (!memory.map(code_address, guest_memory::page_size, page_access::read_write) ||
            !memory.map(data_address, guest_memory::page_size, page_access::read_write))
        {
            result.failure_mask = 1;
            return result;
        }

        std::uint32_t cursor = code_address;
        for (const std::uint32_t instruction : program)
        {
            if (!memory.store_be(cursor, instruction)) result.failure_mask |= 2;
            cursor += 4;
        }
        if (!memory.protect(code_address, guest_memory::page_size, page_access::read_execute)) result.failure_mask |= 4;

        ppu_interpreter interpreter(memory);
        interpreter.state().pc = code_address;
        result.stop_reason = interpreter.run(1000);
        result.instructions = interpreter.state().instructions;
        result.result_register = interpreter.state().gpr[3];
        result.loaded_register = interpreter.state().gpr[6];
        result.last_opcode = interpreter.state().last_opcode;
        if (!memory.load_be(data_address, result.stored_value)) result.failure_mask |= 8;
        if (result.stop_reason != ppu_stop_reason::syscall) result.failure_mask |= 16;
        if (result.instructions != 46) result.failure_mask |= 32;
        if (result.result_register != 70 || result.loaded_register != 70 || result.stored_value != 70) result.failure_mask |= 64;
        return result;
    }
}
