#include "ppu_hle.hpp"

#include <algorithm>
#include <bit>
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

        if (found->module == "cellSysutil")
        {
            if (found->nid == 0x887572d5) // cellVideoOutGetState
            {
                const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[5]);
                std::array<std::byte, 16> video_state{};
                video_state[0] = std::byte{0}; // enabled
                video_state[1] = std::byte{1}; // RGB
                video_state[8] = std::byte{2}; // 720p
                video_state[9] = std::byte{1}; // progressive
                video_state[11] = std::byte{2}; // 16:9
                video_state[15] = std::byte{1}; // 59.94 Hz, big-endian u16
                if (!memory.write(output, video_state)) return false;
                state.gpr[3] = 0;
            }
            else if (found->nid == 0xe558748d) // cellVideoOutGetResolution
            {
                const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[4]);
                if (!memory.store_be(output, static_cast<std::uint16_t>(1280)) ||
                    !memory.store_be(output + 2, static_cast<std::uint16_t>(720)))
                    return false;
                state.gpr[3] = 0;
            }
            else if (found->nid == 0x0bae8772 || found->nid == 0x9d98afa0 || found->nid == 0x189a74da)
            {
                state.gpr[3] = 0; // configure/register/check callback
            }
            else
            {
                return false;
            }
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }

        if (found->module == "sys_io")
        {
            if (found->nid == 0x1cf98800) // cellPadInit
            {
                const std::uint32_t requested = static_cast<std::uint32_t>(state.gpr[3]);
                if (requested == 0 || requested > 127)
                    state.gpr[3] = 0x80121102u;
                else
                {
                    context->pad_initialized = true;
                    context->pad_max_connect = requested;
                    state.gpr[3] = 0;
                }
            }
            else if (found->nid == 0xa703a51d) // cellPadGetInfo2
            {
                if (!context->pad_initialized) state.gpr[3] = 0x80121104u;
                else
                {
                    const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[3]);
                    std::array<std::byte, 124> info{};
                    if (!memory.write(output, info) || !memory.store_be(output, std::min(context->pad_max_connect, 7u)) ||
                        !memory.store_be(output + 4, 1u) || !memory.store_be(output + 12, 1u) ||
                        !memory.store_be(output + 68, 0x1fu) || !memory.store_be(output + 96, 0u))
                        return false;
                    state.gpr[3] = 0;
                }
            }
            else if (found->nid == 0x8b72cda1) // cellPadGetData
            {
                if (!context->pad_initialized) state.gpr[3] = 0x80121104u;
                else if (state.gpr[3] != 0) state.gpr[3] = 0x80121107u;
                else
                {
                    const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[4]);
                    std::array<std::byte, 132> data{};
                    if (!memory.write(output, data) || !memory.store_be(output, 8u) ||
                        !memory.store_be(output + 8, context->pad_digital1) || !memory.store_be(output + 10, context->pad_digital2) ||
                        !memory.store_be(output + 12, static_cast<std::uint16_t>(context->pad_right_x)) ||
                        !memory.store_be(output + 14, static_cast<std::uint16_t>(context->pad_right_y)) ||
                        !memory.store_be(output + 16, static_cast<std::uint16_t>(context->pad_left_x)) ||
                        !memory.store_be(output + 18, static_cast<std::uint16_t>(context->pad_left_y)))
                        return false;
                    state.gpr[3] = 0;
                }
            }
            else
            {
                return false;
            }
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }

        if (found->module == "cellGcmSys")
        {
            const auto complete = [&]()
            {
                state.pc = static_cast<std::uint32_t>(state.lr);
                ++context->calls;
                return true;
            };

            if (found->nid == 0x15bae46b) // _cellGcmInitBody(context**, cmdSize, ioSize, ioAddress)
            {
                const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[3]);
                const std::uint32_t command_size = static_cast<std::uint32_t>(state.gpr[4]);
                context->gcm_io_size = static_cast<std::uint32_t>(state.gpr[5]);
                context->gcm_io_address = static_cast<std::uint32_t>(state.gpr[6]);
                if (command_size < 32 * 1024 || context->gcm_io_size < command_size ||
                    !memory.has_range_access(context->gcm_io_address, context->gcm_io_size, page_access::read_write) ||
                    !memory.map(context->gcm_local_address, context->gcm_local_size, page_access::read_write) ||
                    !memory.map(context->gcm_context_address, 0x300000, page_access::read_write))
                    return false;

                const std::uint32_t begin = context->gcm_io_address + 4096;
                const std::uint32_t end = context->gcm_io_address + command_size - 4;
                if (!memory.store_be(context->gcm_context_address, begin) ||
                    !memory.store_be(context->gcm_context_address + 4, end) ||
                    !memory.store_be(context->gcm_context_address + 8, begin) ||
                    !memory.store_be(context->gcm_context_address + 12, 0u) ||
                    !memory.store_be(context->gcm_control_address, 0u) ||
                    !memory.store_be(context->gcm_control_address + 4, 0u) ||
                    !memory.store_be(context->gcm_control_address + 8, 0xffffffffu) ||
                    !memory.store_be(output, context->gcm_context_address))
                    return false;
                context->gcm_initialized = true;
                context->gcm_command_cursor = begin;
                state.gpr[3] = 0;
                return complete();
            }
            if (!context->gcm_initialized) return false;

            if (found->nid == 0xe315a0b2) // cellGcmGetConfiguration
            {
                const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[3]);
                if (!memory.store_be(output, context->gcm_local_address) ||
                    !memory.store_be(output + 4, context->gcm_io_address) ||
                    !memory.store_be(output + 8, context->gcm_local_size) ||
                    !memory.store_be(output + 12, context->gcm_io_size) ||
                    !memory.store_be(output + 16, 650000000u) || !memory.store_be(output + 20, 500000000u))
                    return false;
                return complete();
            }
            if (found->nid == 0x21ac3697) // cellGcmAddressToOffset
            {
                const std::uint32_t address = static_cast<std::uint32_t>(state.gpr[3]);
                const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[4]);
                std::uint32_t offset = 0;
                if (address - context->gcm_local_address < context->gcm_local_size)
                    offset = address - context->gcm_local_address;
                else if (address - context->gcm_io_address < context->gcm_io_size)
                    offset = address - context->gcm_io_address;
                else
                {
                    state.gpr[3] = 0x802100ffu;
                    return complete();
                }
                if (!memory.store_be(output, offset)) return false;
                state.gpr[3] = 0;
                return complete();
            }
            if (found->nid == 0xa547adde) // cellGcmGetControlRegister
            {
                state.gpr[3] = context->gcm_control_address;
                return complete();
            }
            if (found->nid == 0x5e2ee0f0) // cellGcmGetDefaultCommandWordSize
            {
                state.gpr[3] = 0x400;
                return complete();
            }
            if (found->nid == 0x8cdf8c70) // cellGcmGetDefaultSegmentWordSize
            {
                state.gpr[3] = 0x100;
                return complete();
            }
            if (found->nid == 0x055bd74d) // cellGcmGetTiledPitchSize
            {
                static constexpr std::array tiled_pitches{
                    0x00000000u, 0x00000200u, 0x00000300u, 0x00000400u, 0x00000500u, 0x00000600u,
                    0x00000700u, 0x00000800u, 0x00000a00u, 0x00000c00u, 0x00000d00u, 0x00000e00u,
                    0x00001000u, 0x00001400u, 0x00001800u, 0x00001a00u, 0x00001c00u, 0x00002000u,
                    0x00002800u, 0x00003000u, 0x00003400u, 0x00003800u, 0x00004000u, 0x00005000u,
                    0x00006000u, 0x00006800u, 0x00007000u, 0x00008000u, 0x0000a000u, 0x0000c000u,
                    0x0000d000u, 0x0000e000u, 0x00010000u};
                const std::uint32_t requested = static_cast<std::uint32_t>(state.gpr[3]);
                state.gpr[3] = 0;
                for (std::size_t index = 1; index < tiled_pitches.size(); ++index)
                {
                    if (requested <= tiled_pitches[index])
                    {
                        state.gpr[3] = tiled_pitches[index];
                        break;
                    }
                }
                return complete();
            }
            if (found->nid == 0xa53d12ae) // cellGcmSetDisplayBuffer
            {
                const std::uint32_t id = static_cast<std::uint32_t>(state.gpr[3]);
                if (id >= context->gcm_display_buffers.size())
                {
                    state.gpr[3] = 0x802100ffu;
                    return complete();
                }
                context->gcm_display_buffers[id] = {
                    static_cast<std::uint32_t>(state.gpr[4]), static_cast<std::uint32_t>(state.gpr[5]),
                    static_cast<std::uint32_t>(state.gpr[6]), static_cast<std::uint32_t>(state.gpr[7])};
                state.gpr[3] = 0;
                return complete();
            }
            if (found->nid == 0x72a577ce) // cellGcmGetFlipStatus
            {
                state.gpr[3] = context->gcm_flip_status;
                return complete();
            }
            if (found->nid == 0xb2e761d4) // cellGcmResetFlipStatus
            {
                context->gcm_flip_status = 1;
                return complete();
            }
            if (found->nid == 0x21397818 || found->nid == 0xdc09357e) // flip command / cellGcmSetFlip
            {
                const std::uint32_t guest_context = static_cast<std::uint32_t>(state.gpr[3]);
                std::uint32_t begin = 0;
                std::uint32_t current = 0;
                if (!memory.load_be(guest_context, begin) || !memory.load_be(guest_context + 8, current) ||
                    current < begin || current - begin > context->gcm_io_size || ((current - begin) & 3) != 0)
                    return false;
                const std::uint32_t capture_begin = context->gcm_command_cursor >= begin && context->gcm_command_cursor <= current
                    ? context->gcm_command_cursor : begin;
                context->gcm_command_words.resize((current - capture_begin) / 4);
                for (std::size_t index = 0; index < context->gcm_command_words.size(); ++index)
                {
                    if (!memory.load_be(capture_begin + static_cast<std::uint32_t>(index * 4), context->gcm_command_words[index])) return false;
                }

                std::array<std::uint32_t, 16> vertex_formats{};
                std::array<std::uint32_t, 16> vertex_offsets{};
                std::array<std::array<float, 4>, 468> transform_constants{};
                std::array<bool, 468> transform_constant_valid{};
                std::uint32_t transform_constant_load = 0;
                context->gcm_vertices.clear();
                context->gcm_draws.clear();
                for (std::size_t cursor = 0; cursor < context->gcm_command_words.size();)
                {
                    const std::uint32_t header = context->gcm_command_words[cursor++];
                    const std::uint32_t count = (header >> 18) & 0x7ff;
                    const bool non_incrementing = (header & 0x40000000u) != 0;
                    std::uint32_t method = (header & 0x3ffffu) & ~3u;
                    if (count == 0 || count > context->gcm_command_words.size() - cursor) continue;
                    for (std::uint32_t argument = 0; argument < count; ++argument)
                    {
                        const std::uint32_t value = context->gcm_command_words[cursor++];
                        if (method == 0x1d90) context->gcm_clear_color = value;
                        else if (method == 0x1808 && value != 0) context->gcm_primitive = value;
                        else if (method == 0x0a00)
                        {
                            context->gcm_frame_width = value >> 16;
                        }
                        else if (method == 0x0a04)
                        {
                            context->gcm_frame_height = value >> 16;
                        }
                        else if (method >= 0x1740 && method < 0x1780)
                        {
                            vertex_formats[(method - 0x1740) / 4] = value;
                        }
                        else if (method >= 0x1680 && method < 0x16c0)
                        {
                            vertex_offsets[(method - 0x1680) / 4] = value;
                        }
                        else if (method == 0x1efc)
                        {
                            transform_constant_load = value;
                        }
                        else if (method >= 0x1f00 && method < 0x1f80)
                        {
                            const std::uint32_t component = (method - 0x1f00) / 4;
                            const std::uint32_t constant = transform_constant_load + component / 4;
                            if (constant < transform_constants.size())
                            {
                                transform_constants[constant][component % 4] = std::bit_cast<float>(value);
                                transform_constant_valid[constant] = true;
                            }
                        }
                        else if (method == 0x1814)
                        {
                            const std::uint32_t first = value & 0x00ffffffu;
                            const std::uint32_t vertex_count = (value >> 24) + 1;
                            const auto decode_address = [&](std::uint32_t encoded)
                            {
                                return (encoded & 0x80000000u ? context->gcm_io_address : context->gcm_local_address) + (encoded & 0x7fffffffu);
                            };
                            std::size_t position_attribute = vertex_formats.size();
                            std::size_t color_attribute = vertex_formats.size();
                            for (std::size_t attribute = 0; attribute < vertex_formats.size(); ++attribute)
                            {
                                if (position_attribute == vertex_formats.size() && (vertex_formats[attribute] & 7) == 2 &&
                                    ((vertex_formats[attribute] >> 4) & 0xf) >= 2)
                                    position_attribute = attribute;
                                if (color_attribute == vertex_formats.size() && (vertex_formats[attribute] & 7) == 4 &&
                                    ((vertex_formats[attribute] >> 4) & 0xf) == 4)
                                    color_attribute = attribute;
                            }
                            if (position_attribute == vertex_formats.size() || color_attribute == vertex_formats.size()) continue;
                            const std::uint32_t position_format = vertex_formats[position_attribute];
                            const std::uint32_t color_format = vertex_formats[color_attribute];
                            const std::uint32_t position_stride = (position_format >> 8) & 0xff;
                            const std::uint32_t position_size = (position_format >> 4) & 0xf;
                            const std::uint32_t color_stride = (color_format >> 8) & 0xff;
                            const std::uint32_t color_size = (color_format >> 4) & 0xf;
                            if ((position_format & 7) != 2 || position_stride == 0 || position_size < 2 || position_size > 4 ||
                                (color_format & 7) != 4 || color_stride == 0 || color_size != 4 || vertex_count > 65536)
                                continue;
                            const std::uint32_t position_base = decode_address(vertex_offsets[position_attribute]);
                            const std::uint32_t color_base = decode_address(vertex_offsets[color_attribute]);
                            ppu_hle_context::gcm_draw draw{.primitive = context->gcm_primitive};
                            const bool simple_dp4_program = std::ranges::all_of(
                                transform_constant_valid.begin() + 256, transform_constant_valid.begin() + 260,
                                [](bool valid) { return valid; });
                            for (std::uint32_t vertex_index = 0; vertex_index < vertex_count; ++vertex_index)
                            {
                                ppu_hle_context::gcm_vertex vertex;
                                float* components[] = {&vertex.x, &vertex.y, &vertex.z, &vertex.w};
                                for (std::uint32_t component = 0; component < position_size; ++component)
                                {
                                    std::uint32_t bits = 0;
                                    if (!memory.load_be(position_base + (first + vertex_index) * position_stride + component * 4, bits)) return false;
                                    *components[component] = std::bit_cast<float>(bits);
                                }
                                std::array<std::byte, 4> color{};
                                if (!memory.read(color_base + (first + vertex_index) * color_stride, color)) return false;
                                for (std::size_t color_index = 0; color_index < color.size(); ++color_index)
                                    vertex.color[color_index] = std::to_integer<std::uint8_t>(color[color_index]);
                                if (simple_dp4_program)
                                {
                                    const std::array input{vertex.x, vertex.y, vertex.z, vertex.w};
                                    std::array<float, 4> output{};
                                    for (std::size_t row = 0; row < output.size(); ++row)
                                    {
                                        for (std::size_t column = 0; column < input.size(); ++column)
                                            output[row] += input[column] * transform_constants[256 + row][column];
                                    }
                                    vertex.x = output[0];
                                    vertex.y = output[1];
                                    vertex.z = output[2];
                                    vertex.w = output[3];
                                }
                                context->gcm_vertices.push_back(vertex);
                                draw.vertices.push_back(vertex);
                            }
                            context->gcm_draws.push_back(std::move(draw));
                        }
                        if (!non_incrementing) method += 4;
                    }
                }
                context->gcm_last_flip_id = static_cast<std::uint32_t>(state.gpr[4]);
                const auto& display = context->gcm_display_buffers[context->gcm_last_flip_id & 7];
                if (display.width != 0) context->gcm_frame_width = display.width;
                if (display.height != 0) context->gcm_frame_height = display.height;
                context->gcm_flip_status = 0;
                ++context->gcm_flip_count;
                if (!memory.store_be(context->gcm_control_address, current - context->gcm_io_address) ||
                    !memory.store_be(context->gcm_control_address + 4, current - context->gcm_io_address) ||
                    !memory.store_be(guest_context + 8, begin))
                    return false;
                // The browser renderer consumes the captured FIFO synchronously. Reclaim the
                // command segment at this flip boundary instead of invoking the SDK's native
                // RSX-ring callback, whose function descriptor is not available in HLE mode.
                context->gcm_command_cursor = begin;
                state.gpr[3] = 0;
                return complete();
            }
            if (found->nid == 0x3a33c1fd || found->nid == 0x4ae8d215 || found->nid == 0x9ba451e4 ||
                found->nid == 0xcaabd992 || found->nid == 0x983fb9aa || found->nid == 0xdf6476bd)
            {
                state.gpr[3] = 0;
                return complete();
            }
        }

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
            const std::uint32_t path = static_cast<std::uint32_t>(state.gpr[3]);
            context->last_fs_path.clear();
            for (std::uint32_t index = 0; index < 4096; ++index)
            {
                std::byte value{};
                if (!memory.read(path + index, std::span{&value, 1})) return false;
                if (value == std::byte{}) break;
                context->last_fs_path.push_back(static_cast<char>(std::to_integer<std::uint8_t>(value)));
            }
            const std::uint32_t descriptor = context->next_file_descriptor++;
            if (!memory.store_be(static_cast<std::uint32_t>(state.gpr[5]), descriptor)) return false;
            context->open_files.push_back({.descriptor = descriptor});
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sys_fs" && found->nid == 0x2cb51f0d) // cellFsClose
        {
            const std::uint32_t descriptor = static_cast<std::uint32_t>(state.gpr[3]);
            const auto file = std::ranges::find_if(context->open_files, [descriptor](const auto& item)
            {
                return item.descriptor == descriptor;
            });
            if (file != context->open_files.end()) context->open_files.erase(file);
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sys_fs" && found->nid == 0xecdcf2ab) // cellFsWrite
        {
            const std::uint32_t descriptor = static_cast<std::uint32_t>(state.gpr[3]);
            const std::uint64_t length = state.gpr[5];
            const auto file = std::ranges::find_if(context->open_files, [descriptor](const auto& item)
            {
                return item.descriptor == descriptor;
            });
            if (file != context->open_files.end())
            {
                file->position += length;
                file->size = std::max(file->size, file->position);
            }
            if (!memory.store_be(static_cast<std::uint32_t>(state.gpr[6]), length)) return false;
            state.gpr[3] = 0;
            state.pc = static_cast<std::uint32_t>(state.lr);
            ++context->calls;
            return true;
        }
        if (found->module == "sys_fs" && found->nid == 0xa397d042) // cellFsLseek
        {
            const std::uint32_t descriptor = static_cast<std::uint32_t>(state.gpr[3]);
            const std::int64_t offset = static_cast<std::int64_t>(state.gpr[4]);
            const std::uint32_t whence = static_cast<std::uint32_t>(state.gpr[5]);
            const auto file = std::ranges::find_if(context->open_files, [descriptor](const auto& item)
            {
                return item.descriptor == descriptor;
            });
            if (file == context->open_files.end()) return false;
            const std::int64_t origin = whence == 0 ? 0 : whence == 1 ? static_cast<std::int64_t>(file->position) : static_cast<std::int64_t>(file->size);
            if (whence > 2 || offset < -origin) return false;
            file->position = static_cast<std::uint64_t>(origin + offset);
            if (!memory.store_be(static_cast<std::uint32_t>(state.gpr[6]), file->position)) return false;
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
        if (syscall == 348) // sys_memory_allocate(size, flags, alloc_addr)
        {
            const std::uint64_t requested_size = state.gpr[3];
            const std::uint64_t flags = state.gpr[4];
            const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[5]);
            const std::uint32_t alignment = flags == 0x200 ? 0x10000 : (flags == 0 || flags == 0x400 ? 0x100000 : 0);
            if (alignment == 0 || requested_size == 0 || requested_size > 0xffffffffu || requested_size % alignment != 0)
            {
                state.gpr[3] = 0x80010002u; // CELL_EINVAL/CELL_EALIGN is sufficient for this prototype boundary.
                ++context->syscalls;
                return true;
            }

            const std::uint32_t size = static_cast<std::uint32_t>(requested_size);
            const std::uint64_t aligned = (static_cast<std::uint64_t>(context->next_memory_address) + alignment - 1) & ~(static_cast<std::uint64_t>(alignment) - 1);
            if (aligned > 0xffffffffu || size > guest_memory::address_space_size - aligned ||
                !memory.map(static_cast<std::uint32_t>(aligned), size, page_access::read_write) ||
                !memory.store_be(output, static_cast<std::uint32_t>(aligned)))
                return false;

            context->memory_allocations.push_back({static_cast<std::uint32_t>(aligned), size});
            context->next_memory_address = static_cast<std::uint32_t>(aligned + size);
            state.gpr[3] = 0;
            ++context->syscalls;
            return true;
        }
        if (syscall == 349) // sys_memory_free
        {
            const std::uint32_t address = static_cast<std::uint32_t>(state.gpr[3]);
            const auto allocation = std::ranges::find_if(context->memory_allocations, [address](const auto& item)
            {
                return item.address == address;
            });
            if (allocation == context->memory_allocations.end())
            {
                state.gpr[3] = 0x80010002u;
            }
            else
            {
                if (!memory.unmap(allocation->address, allocation->size)) return false;
                context->memory_allocations.erase(allocation);
                state.gpr[3] = 0;
            }
            ++context->syscalls;
            return true;
        }
        if (syscall == 352) // sys_memory_get_user_memory_size
        {
            const std::uint32_t output = static_cast<std::uint32_t>(state.gpr[3]);
            if (!memory.store_be(output, 256u * 1024 * 1024) || !memory.store_be(output + 4, 224u * 1024 * 1024)) return false;
            state.gpr[3] = 0;
            ++context->syscalls;
            return true;
        }
        if (syscall == 403) // sys_tty_write(channel, buffer, length, written)
        {
            const std::uint32_t buffer = static_cast<std::uint32_t>(state.gpr[4]);
            const std::uint32_t length = static_cast<std::uint32_t>(state.gpr[5]);
            const std::uint32_t written = static_cast<std::uint32_t>(state.gpr[6]);
            if (length > 1024 * 1024) return false;
            std::vector<std::byte> bytes(length);
            if (!memory.read(buffer, bytes) || (written != 0 && !memory.store_be(written, length))) return false;
            context->tty_output.reserve(context->tty_output.size() + length);
            for (const std::byte byte : bytes) context->tty_output.push_back(static_cast<char>(std::to_integer<std::uint8_t>(byte)));
            state.gpr[3] = 0;
            ++context->syscalls;
            return true;
        }
        return false;
    }
}
