#include <gtest/gtest.h>

#include "tools/recomp/FunctionRangeMerge.h"

#include <cstdint>
#include <map>
#include <vector>

namespace
{
	struct test_function
	{
		uint32_t addr = 0;
		uint32_t toc = 0;
		uint32_t size = 0;
		std::map<uint32_t, uint32_t> blocks;
	};

	struct test_merge_info
	{
		uint32_t addr = 0;
		uint32_t size = 0;
		uint32_t members = 0;
	};
}

TEST(FunctionRangeMerge, OverlappingEntriesKeepTheirOwnCompileUnits)
{
	std::vector<test_function> functions{
		{0x212298, 0x1000, 0x190, {{0x212298, 0x50}, {0x2122e8, 0x140}}},
		{0x2122e8, 0x1000, 0x140, {{0x2122e8, 0x10}, {0x2122f8, 0x130}}},
	};
	std::vector<test_merge_info> groups;

	EXPECT_EQ(ps3recomp::merge_overlapping_function_ranges(functions, &groups), 2u);
	ASSERT_EQ(functions.size(), 2u);
	EXPECT_EQ(functions[0].addr, 0x212298u);
	EXPECT_EQ(functions[0].size, 0x190u);
	EXPECT_EQ(functions[1].addr, 0x2122e8u);
	EXPECT_EQ(functions[1].size, 0x140u);
	EXPECT_NE(functions[0].blocks.find(0x212298), functions[0].blocks.end());
	EXPECT_NE(functions[0].blocks.find(0x2122e8), functions[0].blocks.end());
	EXPECT_EQ(functions[1].blocks.find(0x212298), functions[1].blocks.end());
	EXPECT_NE(functions[1].blocks.find(0x2122e8), functions[1].blocks.end());
	ASSERT_EQ(groups.size(), 1u);
	EXPECT_EQ(groups.front().addr, 0x212298u);
	EXPECT_EQ(groups.front().size, 0x190u);
	EXPECT_EQ(groups.front().members, 2u);
}

TEST(FunctionRangeMerge, MergesTransitiveOverlapAndLeavesAdjacentRangesAlone)
{
	std::vector<test_function> functions{
		{0x1000, 1, 0x20, {{0x1000, 0x20}}},
		{0x1010, 2, 0x20, {{0x1010, 0x20}}},
		{0x1020, 3, 0x20, {{0x1020, 0x20}}},
		{0x1040, 4, 0x20, {{0x1040, 0x20}}},
	};
	std::vector<test_merge_info> groups;

	EXPECT_EQ(ps3recomp::merge_overlapping_function_ranges(functions, &groups), 3u);
	ASSERT_EQ(functions.size(), 4u);
	EXPECT_EQ(functions[0].addr, 0x1000u);
	EXPECT_EQ(functions[0].size, 0x40u);
	EXPECT_EQ(functions[0].toc, 1u);
	EXPECT_EQ(functions[1].addr, 0x1010u);
	EXPECT_EQ(functions[1].size, 0x30u);
	EXPECT_EQ(functions[2].addr, 0x1020u);
	EXPECT_EQ(functions[2].size, 0x20u);
	EXPECT_EQ(functions[3].addr, 0x1040u);
	EXPECT_EQ(functions[3].size, 0x20u);
	ASSERT_EQ(groups.size(), 1u);
	EXPECT_EQ(groups.front().members, 3u);
}
