#pragma once

#include "ppu_elf_loader.hpp"
#include "ppu_interpreter.hpp"

#include <cstdint>
#include <array>
#include <string>
#include <vector>

namespace rpcs3::web
{
    struct ppu_hle_context
    {
        struct memory_allocation
        {
            std::uint32_t address = 0;
            std::uint32_t size = 0;
        };
        struct open_file
        {
            std::uint32_t descriptor = 0;
            std::uint64_t position = 0;
            std::uint64_t size = 0;
        };
        struct display_buffer
        {
            std::uint32_t offset = 0;
            std::uint32_t pitch = 0;
            std::uint32_t width = 0;
            std::uint32_t height = 0;
        };
        struct gcm_vertex
        {
            float x = 0;
            float y = 0;
            float z = 0;
            float w = 1;
            std::array<std::uint8_t, 4> color{};
        };

        const ppu_elf_load_result* elf = nullptr;
        std::uint32_t calls = 0;
        std::uint32_t last_nid = 0;
        std::uint32_t next_object_id = 0x95000001;
        std::uint32_t syscalls = 0;
        std::uint32_t last_syscall = 0;
        std::uint32_t next_memory_address = 0x10000000;
        std::vector<memory_allocation> memory_allocations;
        std::string tty_output;
        std::string last_fs_path;
        std::uint32_t next_file_descriptor = 3;
        std::vector<open_file> open_files;
        bool gcm_initialized = false;
        std::uint32_t gcm_io_address = 0;
        std::uint32_t gcm_io_size = 0;
        std::uint32_t gcm_local_address = 0xc0000000;
        std::uint32_t gcm_local_size = 0x0f900000;
        std::uint32_t gcm_context_address = 0x60000000;
        std::uint32_t gcm_control_address = 0x60001040;
        std::uint32_t gcm_flip_status = 0;
        std::uint32_t gcm_flip_count = 0;
        std::uint32_t gcm_last_flip_id = 0;
        std::uint32_t gcm_command_cursor = 0;
        std::array<display_buffer, 8> gcm_display_buffers{};
        std::vector<std::uint32_t> gcm_command_words;
        std::uint32_t gcm_clear_color = 0;
        std::uint32_t gcm_primitive = 0;
        std::uint32_t gcm_frame_width = 0;
        std::uint32_t gcm_frame_height = 0;
        std::vector<gcm_vertex> gcm_vertices;
    };

    bool handle_minimal_ppu_hle(ppu_state& state, guest_memory& memory, std::uint32_t call_address, void* context);
    bool handle_minimal_ppu_syscall(ppu_state& state, guest_memory& memory, std::uint32_t syscall, void* context);
}
