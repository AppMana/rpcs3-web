#include "ppu_hle.hpp"

#include <algorithm>
#include <cstddef>
#include <vector>

namespace rpcs3::web
{
    bool handle_minimal_ppu_hle(ppu_state& state, guest_memory& memory, std::uint32_t call_address, void* opaque)
    {
        auto* context = static_cast<ppu_hle_context*>(opaque);
        if (!context || !context->elf) return false;
        const auto found = std::ranges::find_if(context->elf->imports, [call_address](const ppu_import_stub& item)
        {
            return item.call_address == call_address;
        });
        if (found == context->elf->imports.end()) return false;
        context->last_nid = found->nid;

        // sys_initialize_tls(thread_id, tls_addr, tls_filesz, tls_memsz)
        // This is the first import invoked by RPCS3's ppu_thread.elf fixture.
        if (found->module == "sysPrxForUser" && found->nid == 0x744680a2)
        {
            constexpr std::uint32_t allocation = 0x40000000;
            constexpr std::uint32_t allocation_size = 0x40000;
            if (!memory.map(allocation, allocation_size, page_access::read_write)) return false;

            const std::uint32_t source = static_cast<std::uint32_t>(state.gpr[4]);
            const std::uint32_t file_size = static_cast<std::uint32_t>(state.gpr[5]);
            const std::uint32_t memory_size = static_cast<std::uint32_t>(state.gpr[6]);
            if (file_size > memory_size || memory_size + 0x30 > allocation_size) return false;
            if (file_size != 0)
            {
                std::vector<std::byte> initial(file_size);
                if (!memory.read(source, initial) || !memory.write(allocation + 0x30, initial)) return false;
            }

            state.gpr[13] = allocation + 0x7060;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        // sys_lwmutex_create(lwmutex, attr). This initializes the userspace
        // control block and allocates a deterministic placeholder queue id.
        if (found->module == "sysPrxForUser" && found->nid == 0x2f85c0ef)
        {
            const std::uint32_t lwmutex = static_cast<std::uint32_t>(state.gpr[3]);
            const std::uint32_t attributes = static_cast<std::uint32_t>(state.gpr[4]);
            std::uint32_t protocol = 0;
            std::uint32_t recursive = 0;
            if (!memory.load_be(attributes, protocol) || !memory.load_be(attributes + 4, recursive)) return false;
            if ((protocol != 1 && protocol != 2 && protocol != 4) || (recursive != 0x10 && recursive != 0x20)) return false;
            if (!memory.store_be(lwmutex, 0xffffffffu) || !memory.store_be(lwmutex + 4, 0u) ||
                !memory.store_be(lwmutex + 8, protocol | recursive) || !memory.store_be(lwmutex + 12, 0u) ||
                !memory.store_be(lwmutex + 16, context->next_object_id++) || !memory.store_be(lwmutex + 20, 0u))
                return false;
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sysPrxForUser" && found->nid == 0x8461e528) // sys_time_get_system_time
        {
            state.gpr[3] = 1'000'000;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sysPrxForUser" && (found->nid == 0x1573dc3f || found->nid == 0x1bc200f4))
        {
            const std::uint32_t lwmutex = static_cast<std::uint32_t>(state.gpr[3]);
            std::uint32_t recursive_count = 0;
            if (!memory.load_be(lwmutex + 12, recursive_count)) return false;
            if (found->nid == 0x1573dc3f) // sys_lwmutex_lock
            {
                if (!memory.store_be(lwmutex, 1u) || !memory.store_be(lwmutex + 12, recursive_count + 1)) return false;
            }
            else // sys_lwmutex_unlock
            {
                const std::uint32_t next_count = recursive_count == 0 ? 0 : recursive_count - 1;
                if (!memory.store_be(lwmutex, next_count == 0 ? 0xffffffffu : 1u) || !memory.store_be(lwmutex + 12, next_count)) return false;
            }
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sysPrxForUser" && found->nid == 0x350d454e) // sys_ppu_thread_get_id
        {
            if (!memory.store_be(static_cast<std::uint32_t>(state.gpr[3]), std::uint64_t{1})) return false;
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sysPrxForUser" && (found->nid == 0x2c847572 || found->nid == 0x96328741)) // process exitspawn hooks
        {
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sys_fs" && found->nid == 0x718bf5f8) // cellFsOpen
        {
            state.gpr[3] = 0x80010006u; // CELL_ENOENT: no browser VFS mounted yet
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sys_fs" && found->nid == 0x2cb51f0d) // cellFsClose
        {
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sys_fs" && found->nid == 0xecdcf2ab) // cellFsWrite
        {
            if (!memory.store_be(static_cast<std::uint32_t>(state.gpr[6]), state.gpr[5])) return false;
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        return false;
    }

    bool handle_minimal_ppu_syscall(ppu_state& state, guest_memory& memory, std::uint32_t syscall, void* opaque)
    {
        auto* context = static_cast<ppu_hle_context*>(opaque);
        if (!context) return false;
        context->last_syscall = syscall;
        if (syscall == 352) // sys_memory_get_user_memory_size
        {
            const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[3]);
            if (!memory.store_be(output, 256u * 1024 * 1024) || !memory.store_be(output + 4, 224u * 1024 * 1024)) return false;
            state.gpr[3] = 0;
            ++context->syscalls;
            return true;
        }
        return false;
    }
}
