#include <gtest/gtest.h>
#include "Emu/Cell/SPUWebDispatch.h"
#include <vector>

TEST(SpuWebDispatch, RevalidatesLocalStoreAndRecoversAfterMutation)
{
	spu_web::verified_dispatch_cache<2> cache;
	const int programs[] = {10, 20, 30};
	int local_store = 30;
	std::vector<unsigned> attempted;
	const auto dispatch = [&]
	{
		attempted.clear();
		return cache.find(0, programs, 3, [&](unsigned i)
		{
			attempted.push_back(i);
			return programs[i] == local_store;
		});
	};
	EXPECT_EQ(dispatch(), 2u);
	EXPECT_EQ(attempted, (std::vector<unsigned>{0, 1, 2}));
	EXPECT_EQ(dispatch(), 2u);
	EXPECT_EQ(attempted, (std::vector<unsigned>{2}));
	local_store = 10;
	EXPECT_EQ(dispatch(), 0u);
	EXPECT_EQ(attempted, (std::vector<unsigned>{2, 0}));
	local_store = 40;
	EXPECT_EQ(dispatch(), 3u);
	EXPECT_EQ(attempted, (std::vector<unsigned>{0, 1, 2}));
	local_store = 20;
	EXPECT_EQ(dispatch(), 1u);
}

TEST(SpuWebDispatch, PublicationRestoresTierPriorityAndCollisionsCannotReuseIndices)
{
	spu_web::verified_dispatch_cache<1> cache;
	const int old_programs[] = {10, 20};
	const int optimized_programs[] = {20, 10, 20};
	EXPECT_EQ(cache.find(0, old_programs, 2, [&](unsigned i) { return old_programs[i] == 20; }), 1u);
	// Both candidates 0 and 2 are valid; publication must expose the new optimizing candidate 0.
	EXPECT_EQ(cache.find(0, optimized_programs, 3, [&](unsigned i) { return optimized_programs[i] == 20; }), 0u);
	std::vector<unsigned> attempted;
	EXPECT_EQ(cache.find(4, old_programs, 2, [&](unsigned i) { attempted.push_back(i); return i == 1; }), 1u);
	EXPECT_EQ(attempted, (std::vector<unsigned>{0, 1}));
	EXPECT_EQ(cache.find(8, nullptr, 0, [](unsigned) { ADD_FAILURE(); return true; }), 0u);
}

TEST(SpuWebDispatch, UnplacedCandidateDoesNotPreventAnotherVerifiedProgramRunning)
{
	spu_web::verified_dispatch_cache<> cache;
	const int programs[] = {1, 2};
	EXPECT_EQ(cache.find(0, programs, 2, [](unsigned i) { return i == 1; }), 1u);
	// A previously usable worker-local entry can fail; the full search remains available.
	EXPECT_EQ(cache.find(0, programs, 2, [](unsigned i) { return i == 0; }), 0u);
}

TEST(SpuWebDispatch, DisabledExperimentAlwaysSearchesInPublicationOrder)
{
	spu_web::verified_dispatch_cache<> cache;
	const int programs[] = {1, 2, 3};
	for (unsigned iteration = 0; iteration < 3; ++iteration)
	{
		std::vector<unsigned> attempted;
		EXPECT_EQ(cache.find(0, programs, 3, [&](unsigned i) { attempted.push_back(i); return i == 2; }, false), 2u);
		EXPECT_EQ(attempted, (std::vector<unsigned>{0, 1, 2}));
	}
}

TEST(SpuWebDispatch, DiagnosticsSeparateMissingPreferencesFromMutableCode)
{
	spu_web::verified_dispatch_cache<1, true> cache;
	const int first[] = {1, 2};
	const int other[] = {3, 4};
	EXPECT_EQ(cache.find(0, first, 2, [](unsigned i) { return i == 1; }), 1u);
	EXPECT_EQ(cache.find(0, first, 2, [](unsigned i) { return i == 1; }), 1u);
	EXPECT_EQ(cache.find(0, first, 2, [](unsigned i) { return i == 0; }), 0u);
	EXPECT_EQ(cache.find(4, other, 2, [](unsigned i) { return i == 0; }), 0u);
	EXPECT_EQ(cache.observations.cold, 1u);
	EXPECT_EQ(cache.observations.preferred_hits, 1u);
	EXPECT_EQ(cache.observations.preferred_rejections, 1u);
	EXPECT_EQ(cache.observations.generation_misses, 1u);
}

TEST(SpuWebDispatch, FoldedCacheSeparatesAlignedBlockStarts)
{
	spu_web::verified_dispatch_cache<256, true, true> cache;
	const int programs_a[] = {1, 2};
	const int programs_b[] = {3, 4};
	EXPECT_EQ(cache.find(0, programs_a, 2, [](unsigned i) { return i == 1; }), 1u);
	EXPECT_EQ(cache.find(0x400, programs_b, 2, [](unsigned i) { return i == 1; }), 1u);
	std::vector<unsigned> attempted;
	EXPECT_EQ(cache.find(0, programs_a, 2, [&](unsigned i) { attempted.push_back(i); return i == 1; }), 1u);
	EXPECT_EQ(attempted, (std::vector<unsigned>{1}));
	EXPECT_EQ(cache.observations.generation_misses, 0u);
	// Hashing only selects a preference; local-store mutation still gets verified.
	EXPECT_EQ(cache.find(0, programs_a, 2, [](unsigned i) { return i == 0; }), 0u);
	EXPECT_EQ(cache.observations.preferred_rejections, 1u);
}
