// SharedArrayBuffer threads cannot yield, so Emscripten's sched_yield() only drains the proxying
// queue: it reads the monotonic clock and hands it to _emscripten_yield(), which passes it to the
// itimer check on the main runtime thread and ignores it everywhere else. That clock read is a call
// out of the module, and RPCS3's spin loops — the RSX FIFO's empty case above all — yield on every
// iteration. This definition keeps the main runtime thread's behaviour exactly and skips the
// discarded read on every other thread; it displaces musl's sched_yield.o, which defines nothing
// else.
#include <sched.h>

#include <emscripten.h>
#include <emscripten/threading.h>

extern "C"
{
	bool _emscripten_yield(double now);

	int sched_yield()
	{
		_emscripten_yield(emscripten_is_main_runtime_thread() ? emscripten_get_now() : 0.0);
		return 0;
	}
}
