#include <stdint.h>
#include <spu_intrinsics.h>
#include <spu_mfcio.h>
#include <sys/spu_atomic.h>
#include <sys/spu_thread.h>

enum { dma_tag = 1 };

typedef struct __attribute__((aligned(128))) worker_args
{
	uint64_t data_ea;
	uint64_t atomic_ea;
	uint64_t result_ea;
	uint32_t rank;
	uint32_t reserved[25];
} worker_args;

typedef struct __attribute__((aligned(128))) worker_result
{
	uint32_t done;
	uint32_t checksum;
	uint32_t signal;
	uint32_t atomic_value;
	uint32_t reserved[28];
} worker_result;

static void wait_dma(void)
{
	mfc_write_tag_mask(1u << dma_tag);
	spu_mfcstat(MFC_TAG_UPDATE_ALL);
}

static uint32_t hash_bytes(const uint8_t* bytes, uint32_t size)
{
	uint32_t hash = 2166136261u;
	for (uint32_t index = 0; index < size; index++)
	{
		hash ^= bytes[index];
		hash *= 16777619u;
	}
	return hash;
}

int main(uint64_t args_ea, uint64_t unused1, uint64_t unused2, uint64_t unused3)
{
	(void)unused1;
	(void)unused2;
	(void)unused3;
	worker_args args __attribute__((aligned(128)));
	worker_result result __attribute__((aligned(128))) = {0};
	uint8_t data[128] __attribute__((aligned(128)));
	uint32_t reservation[32] __attribute__((aligned(128)));

	mfc_get(&args, args_ea, sizeof(args), dma_tag, 0, 0);
	wait_dma();
	const uint32_t signal = spu_read_signal1();
	mfc_get(data, args.data_ea, sizeof(data), dma_tag, 0, 0);
	wait_dma();

	vec_uint4 value = *(vec_uint4*)data;
	value = spu_add(value, spu_splats(args.rank + signal));
	*(vec_uint4*)data = value;
	mfc_put(data, args.data_ea, sizeof(data), dma_tag, 0, 0);
	wait_dma();

	result.atomic_value = spu_atomic_incr32(reservation, args.atomic_ea);
	result.checksum = hash_bytes(data, sizeof(data));
	result.signal = signal;
	result.done = 1;
	mfc_put(&result, args.result_ea, sizeof(result), dma_tag, 0, 0);
	wait_dma();

	spu_thread_exit(0);
	return 0;
}
