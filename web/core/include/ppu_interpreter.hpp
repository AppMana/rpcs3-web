#pragma once

#include "guest_memory.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace rpcs3::web
{
    enum class ppu_stop_reason : std::uint8_t
    {
        running,
        syscall,
        unsupported_instruction,
        memory_fault,
        instruction_limit,
    };

    struct ppu_state
    {
        std::array<std::uint64_t, 32> gpr{};
        std::array<bool, 32> cr{};
        std::uint32_t pc = 0;
        std::uint64_t lr = 0;
        std::uint64_t ctr = 0;
        std::uint64_t instructions = 0;
        std::uint32_t last_opcode = 0;
        ppu_stop_reason stop_reason = ppu_stop_reason::running;
    };

    class ppu_interpreter
    {
    public:
        explicit ppu_interpreter(guest_memory& memory);

        [[nodiscard]] ppu_state& state();
        [[nodiscard]] const ppu_state& state() const;
        ppu_stop_reason step();
        ppu_stop_reason run(std::size_t instruction_limit);

        static constexpr std::uint32_t supported_instruction_count = 28;

    private:
        bool effective_address(std::uint32_t ra, std::int64_t displacement, std::uint32_t& address) const;
        void set_cr(std::uint32_t field, std::int64_t left, std::int64_t right);
        void set_cr_unsigned(std::uint32_t field, std::uint64_t left, std::uint64_t right);
        bool branch_condition(std::uint32_t bo, std::uint32_t bi);
        ppu_stop_reason stop(ppu_stop_reason reason);

        guest_memory& m_memory;
        ppu_state m_state;
    };

    struct ppu_smoke_result
    {
        ppu_stop_reason stop_reason = ppu_stop_reason::running;
        std::uint64_t instructions = 0;
        std::uint64_t result_register = 0;
        std::uint64_t loaded_register = 0;
        std::uint32_t stored_value = 0;
        std::uint32_t last_opcode = 0;
        std::uint32_t failure_mask = 0;
    };

    ppu_smoke_result run_ppu_smoke();
}
