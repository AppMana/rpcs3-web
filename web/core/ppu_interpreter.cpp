#include "ppu_interpreter.hpp"

#include <bit>
#include <cmath>
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

        constexpr std::uint64_t rotate_mask(std::uint32_t begin, std::uint32_t end)
        {
            const std::uint64_t mask = ~std::uint64_t{0} << (~(end - begin) & 63);
            return (mask >> (begin & 63)) | (mask << ((64 - begin) & 63));
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

    void ppu_interpreter::set_hle_handler(hle_handler handler, void* context)
    {
        m_hle_handler = handler;
        m_hle_context = context;
    }

    void ppu_interpreter::set_syscall_handler(syscall_handler handler, void* context)
    {
        m_syscall_handler = handler;
        m_syscall_context = context;
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
        case 4: // VMX/AltiVec logical operations
        {
            const std::uint32_t selector = op & 0x7ff;
            if (selector != 0x404 && selector != 0x484 && selector != 0x4c4) break;
            for (std::size_t index = 0; index < 16; ++index)
            {
                const std::uint8_t left = std::to_integer<std::uint8_t>(m_state.vr[ra][index]);
                const std::uint8_t right = std::to_integer<std::uint8_t>(m_state.vr[rb][index]);
                const std::uint8_t value = selector == 0x404 ? left & right : selector == 0x484 ? left | right : left ^ right;
                m_state.vr[rt][index] = static_cast<std::byte>(value);
            }
            return ppu_stop_reason::running;
        }
        case 7: // mulli
            m_state.gpr[rt] = m_state.gpr[ra] * static_cast<std::uint64_t>(static_cast<std::int64_t>(immediate));
            return ppu_stop_reason::running;
        case 8: // subfic
            m_state.gpr[rt] = static_cast<std::uint64_t>(static_cast<std::int64_t>(immediate)) - m_state.gpr[ra];
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
            if (m_syscall_handler && m_syscall_handler(m_state, m_memory, static_cast<std::uint32_t>(m_state.gpr[11]), m_syscall_context))
                return ppu_stop_reason::running;
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
                        if (m_hle_handler && m_hle_handler(m_state, m_memory, current_pc, m_hle_context))
                            return ppu_stop_reason::running;
                        m_state.pc = current_pc;
                        return stop(ppu_stop_reason::hle_call);
                    }
                    m_state.pc = target;
                }
                return ppu_stop_reason::running;
            }
            if (((op >> 1) & 0x3ff) == 150) // isync
            {
                return ppu_stop_reason::running;
            }
            break;
        case 21: // rlwinm (also clrlwi/srwi aliases)
        {
            const std::uint32_t shift = (op >> 11) & 31;
            const std::uint32_t mask_begin = (op >> 6) & 31;
            const std::uint32_t mask_end = (op >> 1) & 31;
            const std::uint32_t rotated = std::rotl(static_cast<std::uint32_t>(m_state.gpr[rt]), static_cast<int>(shift));
            const std::uint64_t duplicated = (static_cast<std::uint64_t>(rotated) << 32) | rotated;
            m_state.gpr[ra] = duplicated & rotate_mask(32 + mask_begin, 32 + mask_end);
            if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
            return ppu_stop_reason::running;
        }
        case 23: // rlwnm
        {
            const std::uint32_t mask_begin = (op >> 6) & 31;
            const std::uint32_t mask_end = (op >> 1) & 31;
            const std::uint32_t rotated = std::rotl(static_cast<std::uint32_t>(m_state.gpr[rt]),
                static_cast<int>(m_state.gpr[rb] & 31));
            const std::uint64_t duplicated = (static_cast<std::uint64_t>(rotated) << 32) | rotated;
            m_state.gpr[ra] = duplicated & rotate_mask(32 + mask_begin, 32 + mask_end);
            if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
            return ppu_stop_reason::running;
        }
        case 24: // ori
            m_state.gpr[ra] = m_state.gpr[rt] | static_cast<std::uint16_t>(op);
            return ppu_stop_reason::running;
        case 25: // oris
            m_state.gpr[ra] = m_state.gpr[rt] | (static_cast<std::uint64_t>(static_cast<std::uint16_t>(op)) << 16);
            return ppu_stop_reason::running;
        case 26: // xori
            m_state.gpr[ra] = m_state.gpr[rt] ^ static_cast<std::uint16_t>(op);
            return ppu_stop_reason::running;
        case 27: // xoris
            m_state.gpr[ra] = m_state.gpr[rt] ^ (static_cast<std::uint64_t>(static_cast<std::uint16_t>(op)) << 16);
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
            if (selector <= 3) // rldicr / clrrdi
            {
                const std::uint32_t shift = (((op >> 1) & 1) << 5) | ((op >> 11) & 31);
                const std::uint32_t mask_end = (((op >> 5) & 1) << 5) | ((op >> 6) & 31);
                m_state.gpr[ra] = std::rotl(m_state.gpr[rt], static_cast<int>(shift)) &
                    (~std::uint64_t{0} << (mask_end ^ 63));
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            }
            if (selector <= 7) // rldic / rldimi
            {
                const std::uint32_t shift = (((op >> 1) & 1) << 5) | ((op >> 11) & 31);
                const std::uint32_t mask_begin = (((op >> 5) & 1) << 5) | ((op >> 6) & 31);
                const std::uint64_t mask = rotate_mask(mask_begin, shift ^ 63);
                const std::uint64_t rotated = std::rotl(m_state.gpr[rt], static_cast<int>(shift));
                if (selector <= 5) m_state.gpr[ra] = rotated & mask;
                else m_state.gpr[ra] = (m_state.gpr[ra] & ~mask) | (rotated & mask);
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
            case 28: // and
                m_state.gpr[ra] = m_state.gpr[rt] & m_state.gpr[rb];
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            case 60: // andc
                m_state.gpr[ra] = m_state.gpr[rt] & ~m_state.gpr[rb];
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            case 104: // neg
                m_state.gpr[rt] = 0 - m_state.gpr[ra];
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[rt]), 0);
                return ppu_stop_reason::running;
            case 124: // nor (also not alias)
                m_state.gpr[ra] = ~(m_state.gpr[rt] | m_state.gpr[rb]);
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            case 144: // mtcrf / mtocrf
            {
                const std::uint32_t mask = (op >> 12) & 0xff;
                for (std::uint32_t field = 0; field < 8; ++field)
                {
                    if ((mask & (0x80u >> field)) == 0) continue;
                    const std::uint32_t nibble = static_cast<std::uint32_t>(m_state.gpr[rt] >> ((field * 4) ^ 28)) & 0xf;
                    for (std::uint32_t bit = 0; bit < 4; ++bit)
                        m_state.cr[field * 4 + bit] = (nibble & (8u >> bit)) != 0;
                    if (((op >> 20) & 1) != 0) break;
                }
                return ppu_stop_reason::running;
            }
            case 151: // stwx
            {
                const std::uint64_t effective = (ra == 0 ? 0 : m_state.gpr[ra]) + m_state.gpr[rb];
                if (effective > std::numeric_limits<std::uint32_t>::max() ||
                    !m_memory.store_be(static_cast<std::uint32_t>(effective), static_cast<std::uint32_t>(m_state.gpr[rt])))
                    return stop(ppu_stop_reason::memory_fault);
                return ppu_stop_reason::running;
            }
            case 103: // lvx
            {
                const std::uint64_t effective = ((ra == 0 ? 0 : m_state.gpr[ra]) + m_state.gpr[rb]) & ~std::uint64_t{0xf};
                if (effective > std::numeric_limits<std::uint32_t>::max() ||
                    !m_memory.read(static_cast<std::uint32_t>(effective), m_state.vr[rt]))
                    return stop(ppu_stop_reason::memory_fault);
                return ppu_stop_reason::running;
            }
            case 231: // stvx
            {
                const std::uint64_t effective = ((ra == 0 ? 0 : m_state.gpr[ra]) + m_state.gpr[rb]) & ~std::uint64_t{0xf};
                if (effective > std::numeric_limits<std::uint32_t>::max() ||
                    !m_memory.write(static_cast<std::uint32_t>(effective), m_state.vr[rt]))
                    return stop(ppu_stop_reason::memory_fault);
                return ppu_stop_reason::running;
            }
            case 233: // mulld
                m_state.gpr[rt] = m_state.gpr[ra] * m_state.gpr[rb];
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[rt]), 0);
                return ppu_stop_reason::running;
            case 235: // mullw
                m_state.gpr[rt] = static_cast<std::uint64_t>(static_cast<std::int64_t>(static_cast<std::int32_t>(m_state.gpr[ra])) *
                    static_cast<std::int32_t>(m_state.gpr[rb]));
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[rt]), 0);
                return ppu_stop_reason::running;
            case 19: // mfcr
            {
                std::uint32_t packed = 0;
                for (std::uint32_t bit = 0; bit < m_state.cr.size(); ++bit)
                {
                    if (m_state.cr[bit]) packed |= std::uint32_t{1} << (31 - bit);
                }
                m_state.gpr[rt] = packed;
                return ppu_stop_reason::running;
            }
            case 23: // lwzx
            {
                const std::uint64_t effective = (ra == 0 ? 0 : m_state.gpr[ra]) + m_state.gpr[rb];
                std::uint32_t value = 0;
                if (effective > std::numeric_limits<std::uint32_t>::max() ||
                    !m_memory.load_be(static_cast<std::uint32_t>(effective), value))
                    return stop(ppu_stop_reason::memory_fault);
                m_state.gpr[rt] = value;
                return ppu_stop_reason::running;
            }
            case 40: // subf
                m_state.gpr[rt] = m_state.gpr[rb] - m_state.gpr[ra];
                return ppu_stop_reason::running;
            case 26: // cntlzw
                m_state.gpr[ra] = std::countl_zero(static_cast<std::uint32_t>(m_state.gpr[rt]));
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            case 58: // cntlzd
                m_state.gpr[ra] = std::countl_zero(m_state.gpr[rt]);
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            case 24: // slw
            {
                const std::uint32_t shift = static_cast<std::uint32_t>(m_state.gpr[rb]) & 0x3f;
                m_state.gpr[ra] = static_cast<std::uint32_t>(m_state.gpr[rt] << shift);
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            }
            case 27: // sld
            {
                const std::uint32_t shift = static_cast<std::uint32_t>(m_state.gpr[rb]) & 0x7f;
                m_state.gpr[ra] = (shift & 0x40) != 0 ? 0 : m_state.gpr[rt] << shift;
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            }
            case 266: // add
                m_state.gpr[rt] = m_state.gpr[ra] + m_state.gpr[rb];
                return ppu_stop_reason::running;
            case 278: // dcbt cache hint
                return ppu_stop_reason::running;
            case 316: // xor
                m_state.gpr[ra] = m_state.gpr[rt] ^ m_state.gpr[rb];
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
            case 459: // divwu
            {
                const std::uint32_t divisor = static_cast<std::uint32_t>(m_state.gpr[rb]);
                m_state.gpr[rt] = divisor == 0 ? 0 : static_cast<std::uint32_t>(m_state.gpr[ra]) / divisor;
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[rt]), 0);
                return ppu_stop_reason::running;
            }
            case 467: // mtspr
            {
                const std::uint32_t spr = ((op >> 16) & 31) | ((op >> 6) & 0x3e0);
                if (spr == 8) m_state.lr = m_state.gpr[rt];
                else if (spr == 9) m_state.ctr = m_state.gpr[rt];
                else break;
                return ppu_stop_reason::running;
            }
            case 536: // srw
            {
                const std::uint32_t shift = static_cast<std::uint32_t>(m_state.gpr[rb]) & 0x3f;
                m_state.gpr[ra] = (m_state.gpr[rt] & 0xffffffffu) >> shift;
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            }
            case 539: // srd
            {
                const std::uint32_t shift = static_cast<std::uint32_t>(m_state.gpr[rb]) & 0x7f;
                m_state.gpr[ra] = (shift & 0x40) != 0 ? 0 : m_state.gpr[rt] >> shift;
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            }
            case 598: // sync / lwsync
            case 854: // eieio
                return ppu_stop_reason::running;
            case 986: // extsw
                m_state.gpr[ra] = static_cast<std::uint64_t>(static_cast<std::int64_t>(static_cast<std::int32_t>(m_state.gpr[rt])));
                return ppu_stop_reason::running;
            case 922: // extsh
                m_state.gpr[ra] = static_cast<std::uint64_t>(static_cast<std::int64_t>(static_cast<std::int16_t>(m_state.gpr[rt])));
                return ppu_stop_reason::running;
            case 954: // extsb
                m_state.gpr[ra] = static_cast<std::uint64_t>(static_cast<std::int64_t>(static_cast<std::int8_t>(m_state.gpr[rt])));
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            case 824: // srawi
                m_state.gpr[ra] = static_cast<std::uint64_t>(static_cast<std::int64_t>(static_cast<std::int32_t>(m_state.gpr[rt])) >> rb);
                return ppu_stop_reason::running;
            case 826: // sradi, shift 0..31
            case 827: // sradi, shift 32..63
            {
                const std::uint32_t shift = (((op >> 1) & 1) << 5) | rb;
                m_state.gpr[ra] = static_cast<std::uint64_t>(static_cast<std::int64_t>(m_state.gpr[rt]) >> shift);
                if ((op & 1) != 0) set_cr(0, static_cast<std::int64_t>(m_state.gpr[ra]), 0);
                return ppu_stop_reason::running;
            }
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
        case 35: // lbzu
        {
            std::uint32_t address = 0;
            std::array<std::byte, 1> value{};
            if (ra == 0 || rt == ra || !effective_address(ra, immediate, address) || !m_memory.read(address, value))
                return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[rt] = std::to_integer<std::uint8_t>(value[0]);
            m_state.gpr[ra] = address;
            return ppu_stop_reason::running;
        }
        case 36: // stw
        {
            std::uint32_t address = 0;
            if (!effective_address(ra, immediate, address) || !m_memory.store_be(address, static_cast<std::uint32_t>(m_state.gpr[rt]))) return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 37: // stwu
        {
            std::uint32_t address = 0;
            if (ra == 0 || !effective_address(ra, immediate, address) ||
                !m_memory.store_be(address, static_cast<std::uint32_t>(m_state.gpr[rt])))
                return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[ra] = address;
            return ppu_stop_reason::running;
        }
        case 38: // stb
        {
            std::uint32_t address = 0;
            const std::array value{static_cast<std::byte>(m_state.gpr[rt] & 0xff)};
            if (!effective_address(ra, immediate, address) || !m_memory.write(address, value)) return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 39: // stbu
        {
            std::uint32_t address = 0;
            const std::array value{static_cast<std::byte>(m_state.gpr[rt] & 0xff)};
            if (ra == 0 || !effective_address(ra, immediate, address) || !m_memory.write(address, value))
                return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[ra] = address;
            return ppu_stop_reason::running;
        }
        case 40: // lhz
        {
            std::uint32_t address = 0;
            std::uint16_t value = 0;
            if (!effective_address(ra, immediate, address) || !m_memory.load_be(address, value)) return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[rt] = value;
            return ppu_stop_reason::running;
        }
        case 44: // sth
        {
            std::uint32_t address = 0;
            if (!effective_address(ra, immediate, address) ||
                !m_memory.store_be(address, static_cast<std::uint16_t>(m_state.gpr[rt])))
                return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 48: // lfs
        {
            std::uint32_t address = 0;
            std::uint32_t bits = 0;
            if (!effective_address(ra, immediate, address) || !m_memory.load_be(address, bits))
                return stop(ppu_stop_reason::memory_fault);
            const double value = static_cast<double>(std::bit_cast<float>(bits));
            m_state.fpr[rt] = std::bit_cast<std::uint64_t>(value);
            return ppu_stop_reason::running;
        }
        case 49: // lfsu
        {
            std::uint32_t address = 0;
            std::uint32_t bits = 0;
            if (ra == 0 || !effective_address(ra, immediate, address) || !m_memory.load_be(address, bits))
                return stop(ppu_stop_reason::memory_fault);
            const double value = static_cast<double>(std::bit_cast<float>(bits));
            m_state.fpr[rt] = std::bit_cast<std::uint64_t>(value);
            m_state.gpr[ra] = address;
            return ppu_stop_reason::running;
        }
        case 50: // lfd
        {
            std::uint32_t address = 0;
            if (!effective_address(ra, immediate, address) || !m_memory.load_be(address, m_state.fpr[rt]))
                return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 51: // lfdu
        {
            std::uint32_t address = 0;
            if (ra == 0 || !effective_address(ra, immediate, address) || !m_memory.load_be(address, m_state.fpr[rt]))
                return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[ra] = address;
            return ppu_stop_reason::running;
        }
        case 54: // stfd
        {
            std::uint32_t address = 0;
            if (!effective_address(ra, immediate, address) || !m_memory.store_be(address, m_state.fpr[rt]))
                return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 52: // stfs
        {
            std::uint32_t address = 0;
            const float value = static_cast<float>(std::bit_cast<double>(m_state.fpr[rt]));
            if (!effective_address(ra, immediate, address) ||
                !m_memory.store_be(address, std::bit_cast<std::uint32_t>(value)))
                return stop(ppu_stop_reason::memory_fault);
            return ppu_stop_reason::running;
        }
        case 53: // stfsu
        {
            std::uint32_t address = 0;
            const float value = static_cast<float>(std::bit_cast<double>(m_state.fpr[rt]));
            if (ra == 0 || !effective_address(ra, immediate, address) ||
                !m_memory.store_be(address, std::bit_cast<std::uint32_t>(value)))
                return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[ra] = address;
            return ppu_stop_reason::running;
        }
        case 55: // stfdu
        {
            std::uint32_t address = 0;
            if (ra == 0 || !effective_address(ra, immediate, address) || !m_memory.store_be(address, m_state.fpr[rt]))
                return stop(ppu_stop_reason::memory_fault);
            m_state.gpr[ra] = address;
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
        case 59: // floating-point single-precision arithmetic
        {
            const std::uint32_t xo = (op >> 1) & 31;
            const double a = std::bit_cast<double>(m_state.fpr[ra]);
            const double b = std::bit_cast<double>(m_state.fpr[rb]);
            const std::uint32_t frc = (op >> 6) & 31;
            const double c = std::bit_cast<double>(m_state.fpr[frc]);
            double result = 0;
            if (xo == 18) result = a / b;
            else if (xo == 20) result = a - b;
            else if (xo == 21) result = a + b;
            else if (xo == 22) result = std::sqrt(b);
            else if (xo == 25) result = a * c;
            else if (xo == 28) result = std::fma(a, c, -b);
            else if (xo == 29) result = std::fma(a, c, b);
            else if (xo == 30) result = -std::fma(a, c, -b);
            else if (xo == 31) result = -std::fma(a, c, b);
            else break;
            result = static_cast<double>(static_cast<float>(result));
            m_state.fpr[rt] = std::bit_cast<std::uint64_t>(result);
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
        case 63: // floating-point double-precision group
        {
            const std::uint32_t xo = (op >> 1) & 0x3ff;
            if (xo == 846) // fcfid
            {
                const double value = static_cast<double>(static_cast<std::int64_t>(m_state.fpr[rb]));
                m_state.fpr[rt] = std::bit_cast<std::uint64_t>(value);
                return ppu_stop_reason::running;
            }
            if (xo == 12) // frsp
            {
                const double value = static_cast<double>(static_cast<float>(std::bit_cast<double>(m_state.fpr[rb])));
                m_state.fpr[rt] = std::bit_cast<std::uint64_t>(value);
                return ppu_stop_reason::running;
            }
            if (xo == 40) // fneg
            {
                m_state.fpr[rt] = m_state.fpr[rb] ^ (std::uint64_t{1} << 63);
                return ppu_stop_reason::running;
            }
            if (xo == 72) // fmr
            {
                m_state.fpr[rt] = m_state.fpr[rb];
                return ppu_stop_reason::running;
            }
            if (xo == 136) // fnabs
            {
                m_state.fpr[rt] = m_state.fpr[rb] | (std::uint64_t{1} << 63);
                return ppu_stop_reason::running;
            }
            if (xo == 264) // fabs
            {
                m_state.fpr[rt] = m_state.fpr[rb] & ~(std::uint64_t{1} << 63);
                return ppu_stop_reason::running;
            }
            const std::uint32_t arithmetic = xo & 31;
            const double a = std::bit_cast<double>(m_state.fpr[ra]);
            const double b = std::bit_cast<double>(m_state.fpr[rb]);
            const std::uint32_t frc = (op >> 6) & 31;
            const double c = std::bit_cast<double>(m_state.fpr[frc]);
            double result = 0;
            if (arithmetic == 18) result = a / b;
            else if (arithmetic == 20) result = a - b;
            else if (arithmetic == 21) result = a + b;
            else if (arithmetic == 22) result = std::sqrt(b);
            else if (arithmetic == 25) result = a * c;
            else if (arithmetic == 28) result = std::fma(a, c, -b);
            else if (arithmetic == 29) result = std::fma(a, c, b);
            else if (arithmetic == 30) result = -std::fma(a, c, -b);
            else if (arithmetic == 31) result = -std::fma(a, c, b);
            else break;
            m_state.fpr[rt] = std::bit_cast<std::uint64_t>(result);
            return ppu_stop_reason::running;
            break;
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
