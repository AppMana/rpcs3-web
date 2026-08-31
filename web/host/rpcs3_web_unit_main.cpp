#include <gtest/gtest.h>

#include "Utilities/Thread.h"
#include "util/logs.hpp"

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>

namespace
{
	std::string json_escape(std::string_view text)
	{
		std::string result;
		result.reserve(text.size() + 16);

		for (const unsigned char ch : text)
		{
			switch (ch)
			{
			case '\\': result += "\\\\"; break;
			case '"': result += "\\\""; break;
			case '\b': result += "\\b"; break;
			case '\f': result += "\\f"; break;
			case '\n': result += "\\n"; break;
			case '\r': result += "\\r"; break;
			case '\t': result += "\\t"; break;
			default:
				if (ch < 0x20)
				{
					constexpr char hex[] = "0123456789abcdef";
					result += "\\u00";
					result += hex[ch >> 4];
					result += hex[ch & 0xf];
				}
				else
				{
					result += static_cast<char>(ch);
				}
			}
		}

		return result;
	}

	const char* status_of(const testing::TestResult& result)
	{
		if (result.Skipped()) return "skipped";
		if (result.Passed()) return "passed";
		return "failed";
	}

	std::string build_report()
	{
		const testing::UnitTest& unit = *testing::UnitTest::GetInstance();
		std::string json = "{\"schema\":1,\"target\":\"wasm32-emscripten\",\"total\":";
		json += std::to_string(unit.total_test_count());
		json += ",\"passed\":" + std::to_string(unit.successful_test_count());
		json += ",\"failed\":" + std::to_string(unit.failed_test_count());
		json += ",\"skipped\":" + std::to_string(unit.skipped_test_count());
		json += ",\"elapsedMs\":" + std::to_string(unit.elapsed_time());
		json += ",\"tests\":[";

		bool first_test = true;
		for (int suite_index = 0; suite_index < unit.total_test_suite_count(); ++suite_index)
		{
			const testing::TestSuite& suite = *unit.GetTestSuite(suite_index);
			for (int test_index = 0; test_index < suite.total_test_count(); ++test_index)
			{
				const testing::TestInfo& info = *suite.GetTestInfo(test_index);
				const testing::TestResult& result = *info.result();
				if (!first_test) json += ',';
				first_test = false;
				json += "{\"suite\":\"" + json_escape(suite.name());
				json += "\",\"name\":\"" + json_escape(info.name());
				json += "\",\"status\":\"" + std::string(status_of(result));
				json += "\",\"elapsedMs\":" + std::to_string(result.elapsed_time());
				json += ",\"failures\":[";

				bool first_failure = true;
				for (int part_index = 0; part_index < result.total_part_count(); ++part_index)
				{
					const testing::TestPartResult& part = result.GetTestPartResult(part_index);
					if (!part.failed()) continue;
					if (!first_failure) json += ',';
					first_failure = false;
					json += "{\"file\":\"" + json_escape(part.file_name() ? part.file_name() : "");
					json += "\",\"line\":" + std::to_string(part.line_number());
					json += ",\"message\":\"" + json_escape(part.message());
					json += "\"}";
				}

				json += "]}";
			}
		}

		json += "]}";
		return json;
	}
}

// StrFmt's assertion helpers terminate through RPCS3's thread controller. The
// low-dependency browser unit binary does not pull in the emulator scheduler,
// so preserve the failure contract without linking the entire runtime.
[[noreturn]] void thread_ctrl::emergency_exit(std::string_view reason)
{
	std::fwrite(reason.data(), 1, reason.size(), stderr);
	std::fputc('\n', stderr);
	std::abort();
}

namespace utils
{
	u64 _get_main_tid()
	{
		return 0;
	}
}

atomic_t<bool> g_headless{false};

logs::registerer::registerer(logs::channel&)
{
}

void logs::message::broadcast(const char*, const fmt_type_info*, ...) const
{
}

int main(int argc, char** argv)
{
	testing::InitGoogleTest(&argc, argv);
	GTEST_FLAG_SET(brief, true);
	const int exit_code = RUN_ALL_TESTS();
	std::cout << "RPCS3_WEB_UNIT_REPORT=" << build_report() << std::endl;
	return exit_code;
}
