#include <stdint.h>

struct thread
{
	uint32_t pc, pad;
	uint64_t failures;
	uint32_t state, mode, executions;
};

void chain_program_a(uint32_t thread, uint32_t ls, uint64_t unused)
{
	struct thread* t = (void*)(uintptr_t)thread;
	++t->executions;
	if (t->mode != 2) t->pc = 0x2000;
	if (t->mode == 3) t->state = 1;
	if (t->mode == 4) *(uint32_t*)(uintptr_t)ls = 1;
}

void chain_program_b(uint32_t thread, uint32_t ls, uint64_t unused)
{
	struct thread* t = (void*)(uintptr_t)thread;
	if (t->mode == 1 || *(uint32_t*)(uintptr_t)ls)
	{
		++t->failures;
		return;
	}
	++t->executions;
	t->pc = 0x1000;
}
