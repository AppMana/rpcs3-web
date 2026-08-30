#include "ppu_interpreter.hpp"

#include <bit>
#include <limits>

namespace rpcs3::web
{
    namespace
    {
        constexpr std::int64_t sign_extend(std::uint32_t value, unsigned bits)
        {
            const std::uint64_t sign = std::uint64_t{1} << (bits - 1);
            return static_cast<std::int64_t>((value ^ sign) - sign);
        }
    }

    ppu_interpreter::ppu_interpreter(guest_memory& memory)
        : m_memory(memory)
    {
    }

    ppu_state& ppu_interpreter::state()
    {
        return m_state;
    }

    const ppu_state& ppu_interpreter::state() const
    {
        return m_state;
    }

    ppu_stop_reason ppu_interpreter::stop(ppu_stop_reason reason)
    {
        m_state.stop_reason = reason;
        return reason;
    }

    bool ppu_interpreter::effective_address(std::uint32_t ra, std::int64_t displacement, std::uint32_t& address) const
    {
        const std::uint64_t base = ra == 0 ? 0 : m_state.gpr[ra];
        const std::uint64_t result = base + static_cast<std::uint64_t>(displacement);
        if (result > std::numeric_limits<std::uint32_t>::max()) return false;
        address = static_cast<std::uint32_t>(result);
        return true;
    }

    void ppu_interpreter::set_cr(std::uint32_t field, std::int64_t left, std::int64_t right)
    {
        const std::size_t first = field * 4;
        m_state.cr[first] = left < right;
        m_state.cr[first + 1] = left > right;
        m_state.cr[first + 2] = left == right;
        m_state.cr[first + 3] = false;
    }

    void ppu_interpreter::set_cr_unsigned(std::uint32_t field, std::uint64_t left, std::uint64_t right)
    {
        const std::size_t first = field * 4;
        m_state.cr[first] = left < right;
        m_state.cr[first + 1] = left > right;
        m_state.cr[first + 2] = left == right;
        m_state.cr[first + 3] = false;
    }

    bool ppu_interpreter::branch_condition(std::uint32_t bo, std::uint32_t bi)
    {
        const bool ignore_condition = (bo & 0x10) != 0;
        const bool condition_value = (bo & 0x08) != 0;
        const bool ignore_counter = (bo & 0x04) != 0;
        const bool counter_value = (bo & 0x02) != 0;
        if (!ignore_counter) --m_state.ctr;
        const bool counter_ok = ignore_counter || ((m_state.ctr != 0) != counter_value);
        const bool condition_ok = ignore_condition || m_state.cr[bi] == condition_value;
        return counter_ok && condition_ok;
    }

    ppu_stop_reason ppu_interpreter::step()
    {
        if (m_state.stop_reason != ppu_stop_reason::running) return m_state.stop_reason;
        if ((m_state.pc & 3) != 0) return stop(ppu_stop_reason::memory_fault);

        std::uint32_t op = 0;
        if (!m_memory.has_range_access(m_state.pc, sizeof(op), page_access::execute) || !m_memory.load_be(m_state.pc, op))
            return stop(ppu_stop_reason::memory_fault);
        m_state.last_opcode = op;
        ++m_state.instructions;

        const std::uint32_t main = op >> 26;
        const std::uint32_t rt = (op >> 21) & 31;
        const std::uint32_t ra = (op >> 16) & 31;
        const std::uint32_t rb = (op >> 11) & 31;
        const auto immediate = static_cast<std::int16_t>(op);
        const std::uint32_t current_pc = m_state.pc;
        m_state.pc += 4;

        switch (main)
        {
        case 7: // mulli
            m_state.gpr[rt] = m_state.gpr[ra] * static_cast<std::uint64_t>(static_cast<std::int64_t>(immediate));
            return ppu_stop_reason::running;
        case 10: // cmpli
        {
            const std::uint32_t field = (op >> 23) & 7;
            const bool is_64_bit = ((op >> 21) & 1) != 0;
            const std::uint64_t left = is_64_bit ? m_state.gpr[ra] : static_cast<std::uint32_t>(m_state.gpr[ra]);
            set_cr_unsigned(field, left, static_cast<std::uint16_t>(op));
            return ppu_stop_reason::running;
        }
        case 11: // cmpi
        {
            const std::uint32_t field = (op >> 23) & 7;
            const bool is_64_bit = ((op >> 21) & 1) != 0;
            const std::int64_t left = is_64_bit ? static_cast<std::int64_t>(m_state.gpr[ra]) : static_cast<std::int32_t>(m_state.gpr[ra]);
            set_cr(field, left, immediate);
            return ppu_stop_reason::running;
        }
        case 14: // addi
            m_state.gpr[rt] = (ra == 0 ? 0 : m_state.gpr[ra]) + static_cast<std::uint64_t>(static_cast<std::int64_t>(immediate));
            return ppu_stop_reason::running;
        case 15: // addis
            m_state.gpr[rt] = (ra == 0 ? 0 : m_state.gpr[ra]) + static_cast<std::uint64_t>(static_cast<std::int64_t>(immediate) * 65536);
            return ppu_stop_reason::running;
        case 16: // bc
        {
            const std::uint32_t bo = rt;
            const std::uint32_t bi = ra;
            const std::int64_t displacement = sign_extend(op & 0xfffcu, 16);
            if ((op & 1) != 0) m_state.lr = m_state.pc;
            if (branch_condition(bo, bi)) m_state.pc = (op & 2) != 0 ? static_cast<std::uint32_t>(displacement) : current_pc + static_cast<std::uint32_t>(displacement);
            return ppu_stop_reason::running;
        }
        case 17: // sc
            return stop(ppu_stop_reason::syscall);
        case 18: // b
        {
            const std::int64_t displacement = sign_extend(op & 0x03fffffcu, 26);
            if ((op & 1) != 0) m_state.lr = m_state.pc;
            m_state.pc = (op & 2) != 0 ? static_cast<std::uint32_t>(displacement) : current_pc + static_cast<std::uint32_t>(displacement);
            return ppu_stop_reason::running;
        }
        case 19:
            if (((op >> 1) & 0x3ff) == 16) // bclr
            {
                const std::uint64_t target = m_state.lr;
                if ((op & 1) != 0) m_state.lr = m_state.pc;
                if (branch_condition(rt, ra)) m_state.pc = static_cast<std::uint32_t>(target) & ~3u;
                return ppu_stop_reason::running;
            }
            if (((op >> 1) & 0x3ff) == 528) // bcctr
            {
                const std::uint32_t target = static_cast<std::uint32_t>(m_state.ctr) & ~3u;
                if ((op & 1) != 0) m_state.lr = m_state.pc;
                if (branch_condition(rt, ra))
                {
                    if (!m_memory.has_range_access(target, sizeof(std::uint32_t), page_access::execute))
                    {
                        m_state.pc = current_pc;
                        return stop(ppu_stop_reason::hle_call);
                    }
                    m_state.pc = target;
                }
                return ppu_stop_reason::running;
            }
            break;
        case 24: // ori
            m_state.gpr[ra] = m_state.gpr[rt] | static_cast<std::uint16_t>(op);
            return ppu_stop_reason::running;
        case 25: // oris
            m_state.gpr[ra] = m_state.gpr[rt] | (static_cast<std::uint64_t>(static_cast<std::uint16_t>(op)) << 16);
            return ppu_stop_reason::running;
        case 26: // xori
            m_state.gpr[ra] = m_state.gpr[rt] ^ static_cast<std::uint16_t>(op);
            return ppu_stop_reason::running;
        case 28: // andi.
            m_state.gpr[ra] = m_state.gpr[rt] & static_cast<std::uint16_t>(op);
            set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
            return ppu_stop_reason::running;
        case 29: // andis.
            m_state.gpr[ra] = m_state.gpr[rt] & (static_cast<std::uint64_t>(static_cast<std::uint16_t>(op)) << 16);
            set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
            return ppu_stop_reason::running;
        case 30: // rotate-left-doubleword immediate family
        {
            const std::uint32_t selector = (op >> 1) & 15;
            if (selector <= 1) // rldicl / clrldi
            {
                const std::uint32_t shift = (((op >> 1) & 1) << 5) | ((op >> 11) & 31);
                const std::uint32_t mask_begin = (((op >> 5) & 1) << 5) | ((op >> 6) & 31);
                m_state.gpr[ra] = std::rotl(m_state.gpr[rt], static_cast<int>(shift)) & (~std::uint64_t{0} >> mask_begin);
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            }
            break;
        }
        case 31:
        {
            const std::uint32_t xo = (op >> 1) & 0x3ff;
            switch (xo)
            {
            case 0: // cmp
            {
                const std::uint32_t field = (op >> 23) & 7;
                const bool is_64_bit = ((op >> 21) & 1) != 0;
                const std::int64_t left = is_64_bit ? static_cast<std::int64_t>(m_state.gpr[ra]) : static_cast<std::int32_t>(m_state.gpr[ra]);
                const std::int64_t right = is_64_bit ? static_cast<std::int64_t>(m_state.gpr[rb]) : static_cast<std::int32_t>(m_state.gpr[rb]);
                set_cr(field, left, right);
                return ppu_stop_reason::running;
            }
            case 32: // cmpl
            {
                const std::uint32_t field = (op >> 23) & 7;
                const bool is_64_bit = ((op >> 21) & 1) != 0;
                const std::uint64_t left = is_64_bit ? m_state.gpr[ra] : static_cast<std::uint32_t>(m_state.gpr[ra]);
                const std::uint64_t right = is_64_bit ? m_state.gpr[rb] : static_cast<std::uint32_t>(m_state.gpr[rb]);
                set_cr_unsigned(field, left, right);
                return ppu_stop_reason::running;
            }
            case 40: // subf
                m_state.gpr[rt] = m_state.gpr[rb] - m_state.gpr[ra];
                return ppu_stop_reason::running;
            case 266: // add
                m_state.gpr[rt] = m_state.gpr[ra] + m_state.gpr[rb];
                return ppu_stop_reason::running;
            case 339: // mfspr
            {
                const std::uint32_t spr = ((op >> 16) & 31) | ((op >> 6) & 0x3e0);
                if (spr == 8) m_state.gpr[rt] = m_state.lr;
                else if (spr == 9) m_state.gpr[rt] = m_state.ctr;
                else break;
                return ppu_stop_reason::running;
            }
            case 444: // or
                m_state.gpr[ra] = m_state.gpr[rt] | m_state.gpr[rb];
                return ppu_stop_reason::running;
            case 467: // mtspr
            {
                const std::uint32_t spr = ((op >> 16) & 31) | ((op >> 6) & 0x3e0);
                if (spr == 8) m_state.lr = m_state.gpr[rt];
                else if (spr == 9) m_state.ctr = m_state.gpr[rt];
                else break;
                return ppu_stop_reason::running;
            }
            case 986: // extsw
                m_state.gpr[ra] = static_cast<std::uint64_t>(static_cast<std::int64_t>(static_cast<std::int32_t>(m_state.gpr[rt])));
                return ppu_stop_reason::running;
            default:
                break;
            }
            break;
        }
        case 32: // lwz
        {
            std::uint32_t address = 0;
            std::uint32_t value = 0;
            if (!effective_address(ra, immediate, address) || !m_memory.load_be(address, value)) return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[rt] = value;
            return ppu_stop_reason::running;
        }
        case 34: // lbz
        {
            std::uint32_t address = 0;
            std::array<std::byte, 1> value{};
            if (!effective_address(ra, immediate, address) || !m_memory.read(address, value)) return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[rt] = std::to_integer<std::uint8_t>(value[0]);
            return ppu_stop_reason::running;
        }
        case 36: // stw
        {
            std::uint32_t address = 0;
            if (!effective_address(ra, immediate, address) || !m_memory.store_be(address, static_cast<std::uint32_t>(m_state.gpr[rt]))) return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 38: // stb
        {
            std::uint32_t address = 0;
            const std::array value{static_cast<std::byte>(m_state.gpr[rt] & 0xff)};
            if (!effective_address(ra, immediate, address) || !m_memory.write(address, value)) return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 58: // ld, ldu, lwa
        {
            std::uint32_t address = 0;
            const std::int64_t displacement = static_cast<std::int16_t>(op & 0xfffcu);
            if (!effective_address(ra, displacement, address)) return stop(ppu_stop_reason::memory_fault);
            if ((op & 3) == 2)
            {
                std::uint32_t value = 0;
                if (!m_memory.load_be(address, value)) return stop(ppu_stop_reason::memory_fault);
                m_state.gpr[rt] = static_cast<std::uint64_t>(static_cast<std::int64_t>(static_cast<std::int32_t>(value)));
            }
            else
            {
                std::uint64_t value = 0;
                if (!m_memory.load_be(address, value)) return stop(ppu_stop_reason::memory_fault);
                m_state.gpr[rt] = value;
                if ((op & 3) == 1) m_state.gpr[ra] = address;
            }
            return ppu_stop_reason::running;
        }
        case 62: // std, stdu
        {
            if ((op & 3) > 1) break;
            std::uint32_t address = 0;
            const std::int64_t displacement = static_cast<std::int16_t>(op & 0xfffcu);
            if (!effective_address(ra, displacement, address) || !m_memory.store_be(address, m_state.gpr[rt])) return stop(ppu_stop_reason::memory_fault);
            if ((op & 3) == 1) m_state.gpr[ra] = address;
            return ppu_stop_reason::running;
        }
        default:
            break;
        }

        return stop(ppu_stop_reason::unsupported_instruction);
    }

    ppu_stop_reason ppu_interpreter::run(std::size_t instruction_limit)
    {
        while (m_state.stop_reason == ppu_stop_reason::running && m_state.instructions < instruction_limit) step();
        if (m_state.stop_reason == ppu_stop_reason::running) stop(ppu_stop_reason::instruction_limit);
        return m_state.stop_reason;
    }
}
