#include <malloc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ppu-lv2.h>
#include <sys/atomic.h>
#include <sys/cond.h>
#include <sys/event_queue.h>
#include <sys/mutex.h>
#include <sys/sem.h>
#include <sys/spu.h>
#include <sys/thread.h>

#include "raw_spu_bin.h"
#include "spu_worker_bin.h"

#define EA(value) ((uint64_t)(void*)(value))

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

static sys_mutex_t thread_mutex;
static sys_cond_t thread_cond;
static sys_sem_t thread_sem;
static sys_event_port_t thread_port;
static volatile uint32_t thread_phase;
static atomic_t thread_atomic;
static volatile uint32_t thread_tls_result;
static __thread uint32_t dispatch_tls = 0x11223344u;
static uint64_t aggregate = 1469598103934665603ull;

static uint32_t hash32(const void* input, size_t size)
{
	const uint8_t* bytes = input;
	uint32_t hash = 2166136261u;
	for (size_t index = 0; index < size; index++)
	{
		hash ^= bytes[index];
		hash *= 16777619u;
	}
	return hash;
}

static void aggregate_value(uint64_t value)
{
	for (uint32_t index = 0; index < 8; index++)
	{
		aggregate ^= (value >> (index * 8)) & 0xff;
		aggregate *= 1099511628211ull;
	}
}

static int checkpoint(const char* name, uint64_t value, int valid)
{
	if (!valid)
	{
		printf("RPCS3-DISPATCH/1 FAIL %s %016llx\n", name, (unsigned long long)value);
		fflush(stdout);
		return 0;
	}
	aggregate_value(value);
	printf("RPCS3-DISPATCH/1 CHECK %s %016llx\n", name, (unsigned long long)value);
	fflush(stdout);
	return 1;
}

__attribute__((noinline)) static uint64_t ppu_mix(uint64_t left, uint64_t right)
{
	left = (left << 17) | (left >> 47);
	right = (right >> 11) | (right << 53);
	return (left ^ right) + 0x1020304050607080ull;
}

static void ppu_thread_entry(void* argument)
{
	const uint32_t token = (uint32_t)(uintptr_t)argument;
	dispatch_tls = token ^ 0xa55aa55au;
	sysMutexLock(thread_mutex, 0);
	thread_tls_result = dispatch_tls;
	thread_phase = 1;
	sysCondSignal(thread_cond);
	sysMutexUnlock(thread_mutex);
	sysSemWait(thread_sem, 0);
	sysAtomicInc(&thread_atomic);
	sysEventPortSend(thread_port, token, dispatch_tls, sysAtomicRead(&thread_atomic));
	sysThreadExit(0x600d0000ull | token);
}

static int run_ppu(void)
{
	uint64_t (*volatile indirect)(uint64_t, uint64_t) = ppu_mix;
	const uint64_t mixed = indirect(0x0123456789abcdefull, 0xfedcba9876543210ull);
	atomic_t main_atomic = {0};
	sysAtomicInc(&main_atomic);
	if (!checkpoint("ppu-control", mixed,
		mixed == 0xd8f0f90119313940ull && sysAtomicRead(&main_atomic) == 1)) return 0;

	uint8_t* allocation = memalign(4096, 12288);
	if (!allocation) return checkpoint("ppu-memory", 0, 0);
	uint8_t* edge = allocation + 4096 - 256;
	uint8_t* copy = allocation + 8192 - 256;
	for (uint32_t index = 0; index < 512; index++) edge[index] = (uint8_t)(index * 37 + 11);
	memcpy(copy, edge, 512);
	const uint32_t memory_hash = hash32(copy, 512);
	const int memory_ok = memcmp(copy, edge, 512) == 0 && memory_hash == 0x86a2b1c5u;
	free(allocation);
	if (!checkpoint("ppu-page-edge", memory_hash, memory_ok)) return 0;

	sys_mutex_attr_t mutex_attr;
	sys_cond_attr_t cond_attr;
	sys_sem_attr_t sem_attr = {SYS_SEM_ATTR_PROTOCOL, SYS_SEM_ATTR_PSHARED, 0, 0, 0, "dspsem"};
	sys_event_queue_attr_t queue_attr = {SYS_EVENT_QUEUE_FIFO, SYS_EVENT_QUEUE_PPU, "dspqueue"};
	sys_event_queue_t queue;
	sys_ppu_thread_t thread;
	sys_event_t event;
	uint64_t thread_result = 0;
	sysMutexAttrInitialize(mutex_attr);
	sysCondAttrInitialize(cond_attr);
	thread_phase = 0;
	thread_atomic.counter = 0;
	thread_tls_result = 0;

	int result = sysMutexCreate(&thread_mutex, &mutex_attr);
	result |= sysCondCreate(&thread_cond, thread_mutex, &cond_attr);
	result |= sysSemCreate(&thread_sem, &sem_attr, 0, 1);
	result |= sysEventQueueCreate(&queue, &queue_attr, SYS_EVENT_QUEUE_KEY_LOCAL, 4);
	result |= sysEventPortCreate(&thread_port, SYS_EVENT_PORT_LOCAL, SYS_EVENT_PORT_NO_NAME);
	result |= sysEventPortConnectLocal(thread_port, queue);
	result |= sysMutexLock(thread_mutex, 0);
	result |= sysThreadCreate(&thread, ppu_thread_entry, (void*)0x1357, 1000, 0x4000, THREAD_JOINABLE, "dispatch-ppu");
	while (!result && thread_phase == 0) result = sysCondWait(thread_cond, 0);
	result |= sysMutexUnlock(thread_mutex);
	result |= sysSemPost(thread_sem, 1);
	result |= sysEventQueueReceive(queue, &event, 0);
	result |= sysThreadJoin(thread, &thread_result);

	const uint32_t expected_tls = 0x1357u ^ 0xa55aa55au;
	const uint64_t scheduler_hash = ((uint64_t)thread_tls_result << 32) |
		((uint64_t)sysAtomicRead(&thread_atomic) << 24) |
		((event.data_1 & 0xffff) << 8) | (thread_result & 0xff);
	const int scheduler_ok = !result && thread_phase == 1 && thread_tls_result == expected_tls &&
		sysAtomicRead(&thread_atomic) == 1 && event.data_1 == 0x1357 && event.data_2 == expected_tls &&
		event.data_3 == 1 && thread_result == 0x600d1357ull && dispatch_tls == 0x11223344u;

	sysEventPortDisconnect(thread_port);
	sysEventPortDestroy(thread_port);
	sysEventQueueDestroy(queue, 0);
	sysSemDestroy(thread_sem);
	sysCondDestroy(thread_cond);
	sysMutexDestroy(thread_mutex);
	return checkpoint("ppu-scheduler", scheduler_hash, scheduler_ok);
}

static int run_spu_group(void)
{
	enum { count = 2, span_size = 128 };
	sysSpuImage image;
	sysSpuThreadGroupAttribute group_attr = {10, "dsp-group", 0, {0}};
	sysSpuThreadAttribute thread_attr = {"dsp-spu", 8, SPU_THREAD_ATTR_NONE};
	sysSpuThreadArgument thread_args[count] = {{0}};
	worker_args* args = memalign(128, sizeof(worker_args) * count);
	worker_result* results = memalign(128, sizeof(worker_result) * count);
	uint8_t* pages = memalign(4096, 16384);
	uint32_t* atomic_counter = memalign(128, 128);
	uint32_t group;
	uint32_t threads[count];
	uint32_t cause = 0;
	uint32_t status = 0;
	int result = !args || !results || !pages || !atomic_counter;
	if (result) return checkpoint("spu-group", 0, 0);

	memset(args, 0, sizeof(worker_args) * count);
	memset(results, 0, sizeof(worker_result) * count);
	memset(pages, 0, 16384);
	memset(atomic_counter, 0, 128);
	uint8_t* spans[count] = {pages + 4096 - 64, pages + 12288 - 64};
	for (uint32_t rank = 0; rank < count; rank++)
	{
		for (uint32_t index = 0; index < span_size; index++) spans[rank][index] = (uint8_t)(index + rank * 29);
		args[rank].data_ea = EA(spans[rank]);
		args[rank].atomic_ea = EA(atomic_counter);
		args[rank].result_ea = EA(&results[rank]);
		args[rank].rank = rank;
		thread_args[rank].arg0 = EA(&args[rank]);
	}

	result |= sysSpuInitialize(2, 1);
	result |= sysSpuImageImport(&image, spu_worker_bin, 0);
	result |= sysSpuThreadGroupCreate(&group, count, 100, &group_attr);
	for (uint32_t rank = 0; rank < count; rank++)
	{
		result |= sysSpuThreadInitialize(&threads[rank], group, rank, &image, &thread_attr, &thread_args[rank]);
		result |= sysSpuThreadSetConfiguration(threads[rank], SPU_SIGNAL1_OVERWRITE | SPU_SIGNAL2_OVERWRITE);
	}
	result |= sysSpuThreadGroupStart(group);
	for (uint32_t rank = 0; rank < count; rank++) result |= sysSpuThreadWriteSignal(threads[rank], 0, 7 + rank);
	result |= sysSpuThreadGroupJoin(group, &cause, &status);

	uint64_t spu_hash = ((uint64_t)*atomic_counter << 56) | ((uint64_t)cause << 48) | ((uint64_t)status << 32);
	for (uint32_t rank = 0; rank < count; rank++)
	{
		uint32_t* words = (uint32_t*)spans[rank];
		const uint32_t delta = rank + 7 + rank;
		for (uint32_t index = 0; index < 4; index++)
		{
			const uint32_t initial = ((rank * 29 + index * 4) << 24) |
				((rank * 29 + index * 4 + 1) << 16) |
				((rank * 29 + index * 4 + 2) << 8) |
				(rank * 29 + index * 4 + 3);
			result |= words[index] != initial + delta;
		}
		result |= results[rank].done != 1 || results[rank].signal != 7 + rank;
		result |= results[rank].checksum != hash32(spans[rank], span_size);
		spu_hash ^= (uint64_t)results[rank].checksum << (rank * 16);
	}
	result |= *atomic_counter != count;

	sysSpuThreadGroupDestroy(group);
	sysSpuImageClose(&image);
	free(atomic_counter);
	free(pages);
	free(results);
	free(args);
	return checkpoint("spu-group", spu_hash, !result);
}

static int run_raw_spu(void)
{
	sysSpuImage image;
	uint32_t raw = 0;
	int result = sysSpuRawCreate(&raw, NULL);
	result |= sysSpuImageImport(&image, raw_spu_bin, SPU_IMAGE_PROTECT);
	result |= sysSpuRawImageLoad(raw, &image);
	sysSpuRawWriteProblemStorage(raw, SPU_RunCtrl, 1);
	while (!result && !(sysSpuRawReadProblemStorage(raw, SPU_MBox_Status) & 1)) {}
	const uint32_t mailbox = result ? 0 : sysSpuRawReadProblemStorage(raw, SPU_Out_MBox);
	result |= sysSpuRawDestroy(raw);
	result |= sysSpuImageClose(&image);
	return checkpoint("spu-raw-mailbox", mailbox, !result && mailbox == 0x1337baad);
}

int main(int argc, char** argv)
{
	printf("RPCS3-DISPATCH/1 BEGIN\n");
	fflush(stdout);
	if (!run_ppu() || !run_spu_group()) return 1;
	if (argc > 1 && strcmp(argv[1], "--raw-spu") == 0 && !run_raw_spu()) return 1;
	printf("RPCS3-DISPATCH/1 PASS %016llx\n", (unsigned long long)aggregate);
	fflush(stdout);
	return 0;
}
