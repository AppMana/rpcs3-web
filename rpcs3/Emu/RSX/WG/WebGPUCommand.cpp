#include "WebGPUCommand.h"

#include <algorithm>
#include <cstring>
#include <limits>

namespace rsx::webgpu
{
	namespace
	{
		bool section_index(section_kind kind, std::size_t& result)
		{
			const auto index = static_cast<std::size_t>(kind);
			if (index >= static_cast<std::size_t>(section_kind::count))
			{
				return false;
			}
			result = index;
			return true;
		}

		bool align_up(std::size_t value, std::uint32_t alignment, std::size_t& result)
		{
			if (alignment == 0 || (alignment & (alignment - 1)) != 0)
			{
				return false;
			}
			if (value > std::numeric_limits<std::size_t>::max() - (alignment - 1))
			{
				return false;
			}
			result = (value + alignment - 1) & ~(static_cast<std::size_t>(alignment) - 1);
			return true;
		}
	}

	draw_packet_builder::draw_packet_builder(draw_packet_header header)
		: m_header(header)
		, m_bytes(sizeof(draw_packet_header))
	{
		m_header.magic = draw_packet_magic;
		m_header.abi = draw_packet_abi;
		m_header.byte_size = sizeof(draw_packet_header);
		m_header.sections = {};
	}

	bool draw_packet_builder::append(section_kind kind, std::span<const std::byte> data, std::uint32_t alignment)
	{
		std::size_t index = 0;
		if (m_finished || m_failed || !section_index(kind, index))
		{
			m_failed = true;
			return false;
		}

		auto& output = m_header.sections[index];
		if (output.size != 0 || output.offset != 0)
		{
			m_failed = true;
			return false;
		}
		if (data.empty())
		{
			return true;
		}

		std::size_t offset = 0;
		if (!align_up(m_bytes.size(), alignment, offset))
		{
			m_failed = true;
			return false;
		}
		if (offset > std::numeric_limits<std::uint32_t>::max() ||
			data.size() > std::numeric_limits<std::uint32_t>::max() - offset)
		{
			m_failed = true;
			return false;
		}

		m_bytes.resize(offset + data.size());
		std::memcpy(m_bytes.data() + offset, data.data(), data.size());
		output.offset = static_cast<std::uint32_t>(offset);
		output.size = static_cast<std::uint32_t>(data.size());
		return true;
	}

	std::vector<std::byte> draw_packet_builder::finish()
	{
		if (m_finished || m_failed)
		{
			m_failed = true;
			return {};
		}
		if (m_bytes.size() > std::numeric_limits<std::uint32_t>::max())
		{
			m_failed = true;
			return {};
		}

		m_finished = true;
		m_header.byte_size = static_cast<std::uint32_t>(m_bytes.size());
		std::memcpy(m_bytes.data(), &m_header, sizeof(m_header));
		return std::move(m_bytes);
	}

	draw_packet_view::draw_packet_view(std::span<const std::byte> bytes)
		: m_bytes(bytes)
	{
		if (bytes.size() < sizeof(draw_packet_header))
		{
			return;
		}

		const auto* candidate = reinterpret_cast<const draw_packet_header*>(bytes.data());
		if (candidate->magic != draw_packet_magic || candidate->abi != draw_packet_abi ||
			candidate->byte_size != bytes.size())
		{
			return;
		}

		for (const auto& section : candidate->sections)
		{
			if (section.size == 0)
			{
				if (section.offset != 0) return;
				continue;
			}
			if (section.offset < sizeof(draw_packet_header) || section.offset > bytes.size() ||
				section.size > bytes.size() - section.offset)
			{
				return;
			}
		}

		m_header = candidate;
	}

	bool draw_packet_view::valid() const
	{
		return m_header != nullptr;
	}

	const draw_packet_header* draw_packet_view::header() const
	{
		return m_header;
	}

	std::span<const std::byte> draw_packet_view::section(section_kind kind) const
	{
		if (!m_header) return {};
		std::size_t index = 0;
		if (!section_index(kind, index)) return {};
		const auto& value = m_header->sections[index];
		if (!value.size) return {};
		return m_bytes.subspan(value.offset, value.size);
	}
}
