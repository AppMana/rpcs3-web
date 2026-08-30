#pragma once

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <span>
#include <type_traits>
#include <vector>

namespace rpcs3::web
{
    enum class page_access : std::uint8_t
    {
        none = 0,
        read = 1,
        write = 2,
        execute = 4,
        read_write = 3,
        read_execute = 5,
    };

    constexpr page_access operator|(page_access left, page_access right)
    {
        return static_cast<page_access>(static_cast<std::uint8_t>(left) | static_cast<std::uint8_t>(right));
    }

    constexpr bool has_access(page_access value, page_access requested)
    {
        return (static_cast<std::uint8_t>(value) & static_cast<std::uint8_t>(requested)) == static_cast<std::uint8_t>(requested);
    }

    class guest_memory
    {
    public:
        static constexpr std::uint64_t address_space_size = 0x1'0000'0000ull;
        static constexpr std::uint32_t page_size = 4096;
        static constexpr std::uint32_t page_count = static_cast<std::uint32_t>(address_space_size / page_size);

        guest_memory();

        bool map(std::uint32_t address, std::uint64_t size, page_access access);
        bool map_alias(std::uint32_t destination, std::uint32_t source, std::uint64_t size, page_access access);
        bool unmap(std::uint32_t address, std::uint64_t size);
        bool protect(std::uint32_t address, std::uint64_t size, page_access access);

        bool read(std::uint32_t address, std::span<std::byte> output) const;
        bool write(std::uint32_t address, std::span<const std::byte> input);

        template <typename T>
        bool load_be(std::uint32_t address, T& output) const
        {
            static_assert(std::is_integral_v<T> && std::is_unsigned_v<T>);
            if (!read(address, std::as_writable_bytes(std::span{&output, 1}))) return false;
            if constexpr (std::endian::native == std::endian::little && sizeof(T) > 1) output = std::byteswap(output);
            return true;
        }

        template <typename T>
        bool store_be(std::uint32_t address, T value)
        {
            static_assert(std::is_integral_v<T> && std::is_unsigned_v<T>);
            if constexpr (std::endian::native == std::endian::little && sizeof(T) > 1) value = std::byteswap(value);
            return write(address, std::as_bytes(std::span{&value, 1}));
        }

        [[nodiscard]] std::size_t mapped_pages() const;
        [[nodiscard]] std::size_t resident_pages() const;

    private:
        static constexpr std::uint32_t no_slot = 0;
        using page_bytes = std::array<std::byte, page_size>;

        struct page_entry
        {
            std::uint32_t slot = no_slot;
            page_access access = page_access::none;
        };

        struct backing_slot
        {
            std::unique_ptr<page_bytes> data;
            std::uint32_t generation = 0;
        };

        [[nodiscard]] bool valid_range(std::uint32_t address, std::uint64_t size, bool require_aligned) const;
        [[nodiscard]] bool check_range(std::uint32_t address, std::size_t size, page_access access) const;
        page_bytes& make_resident(std::uint32_t slot);

        std::vector<page_entry> m_pages;
        std::deque<backing_slot> m_backing;
        std::size_t m_mapped_pages = 0;
        std::size_t m_resident_pages = 0;
    };
}
