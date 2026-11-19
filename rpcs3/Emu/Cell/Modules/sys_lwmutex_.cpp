#include "stdafx.h"
#include "Emu/System.h"
#include "Emu/system_config.h"
#include "Emu/Cell/PPUModule.h"
#include "Emu/Cell/timers.hpp"
#include "Emu/Cell/lv2/sys_lwmutex.h"
#include "Emu/Cell/lv2/sys_mutex.h"
#include "sysPrxForUser.h"

#include "util/asm.hpp"

LOG_CHANNEL(sysPrxForUser);

#ifdef RPCS3_WEB
extern void ppu_web_dump_current_state(const char* reason);

namespace
{
	std::mutex s_lwmutex_guest_mutex;

	u32 lwmutex_vars_offset()
	{
		static const u32 value = ::offset32(&sys_lwmutex_t::vars);
		return value;
	}

	u32 lwmutex_read_u32(vm::ptr<sys_lwmutex_t> lwmutex, u32 offset)
	{
		be_t<u32> value{};
		if (!vm::web_copy_range(lwmutex.addr() + offset, &value, sizeof(value), false))
		{
			ppu_web_dump_current_state("invalid lwmutex read");
			fmt::throw_exception("Invalid lwmutex read (lwmutex=*0x%x, offset=0x%x)", lwmutex, offset);
		}

		return +value;
	}

	void lwmutex_write_u32(vm::ptr<sys_lwmutex_t> lwmutex, u32 offset, u32 value)
	{
		be_t<u32> guest_value = value;
		if (!vm::web_copy_range(lwmutex.addr() + offset, &guest_value, sizeof(guest_value), true))
		{
			ppu_web_dump_current_state("invalid lwmutex write");
			fmt::throw_exception("Invalid lwmutex write (lwmutex=*0x%x, offset=0x%x)", lwmutex, offset);
		}
	}
}
#endif

u32 lwmutex_owner_load(vm::ptr<sys_lwmutex_t> lwmutex)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	return lwmutex_read_u32(lwmutex, lwmutex_vars_offset());
#else
	return lwmutex->vars.owner.load();
#endif
}

u32 lwmutex_owner_compare_and_swap(vm::ptr<sys_lwmutex_t> lwmutex, u32 expected, u32 desired)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	const u32 old = lwmutex_read_u32(lwmutex, lwmutex_vars_offset());
	if (old == expected)
	{
		lwmutex_write_u32(lwmutex, lwmutex_vars_offset(), desired);
	}
	return old;
#else
	return +lwmutex->vars.owner.compare_and_swap(expected, desired);
#endif
}

bool lwmutex_owner_compare_and_swap_test(vm::ptr<sys_lwmutex_t> lwmutex, u32 expected, u32 desired)
{
	return lwmutex_owner_compare_and_swap(lwmutex, expected, desired) == expected;
}

u32 lwmutex_owner_exchange(vm::ptr<sys_lwmutex_t> lwmutex, u32 value)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	const u32 old = lwmutex_read_u32(lwmutex, lwmutex_vars_offset());
	lwmutex_write_u32(lwmutex, lwmutex_vars_offset(), value);
	return old;
#else
	return +lwmutex->vars.owner.exchange(value);
#endif
}

void lwmutex_owner_release(vm::ptr<sys_lwmutex_t> lwmutex, u32 value)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	lwmutex_write_u32(lwmutex, lwmutex_vars_offset(), value);
#else
	lwmutex->vars.owner.release(value);
#endif
}

u32 lwmutex_get_attribute(vm::ptr<sys_lwmutex_t> lwmutex)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	return lwmutex_read_u32(lwmutex, ::offset32(&sys_lwmutex_t::attribute));
#else
	return +lwmutex->attribute;
#endif
}

void lwmutex_set_attribute(vm::ptr<sys_lwmutex_t> lwmutex, u32 value)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	lwmutex_write_u32(lwmutex, ::offset32(&sys_lwmutex_t::attribute), value);
#else
	lwmutex->attribute = value;
#endif
}

u32 lwmutex_get_recursive_count(vm::ptr<sys_lwmutex_t> lwmutex)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	return lwmutex_read_u32(lwmutex, ::offset32(&sys_lwmutex_t::recursive_count));
#else
	return +lwmutex->recursive_count;
#endif
}

void lwmutex_set_recursive_count(vm::ptr<sys_lwmutex_t> lwmutex, u32 value)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	lwmutex_write_u32(lwmutex, ::offset32(&sys_lwmutex_t::recursive_count), value);
#else
	lwmutex->recursive_count = value;
#endif
}

u32 lwmutex_get_sleep_queue(vm::ptr<sys_lwmutex_t> lwmutex)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	return lwmutex_read_u32(lwmutex, ::offset32(&sys_lwmutex_t::sleep_queue));
#else
	return +lwmutex->sleep_queue;
#endif
}

void lwmutex_set_sleep_queue(vm::ptr<sys_lwmutex_t> lwmutex, u32 value)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	lwmutex_write_u32(lwmutex, ::offset32(&sys_lwmutex_t::sleep_queue), value);
#else
	lwmutex->sleep_queue = value;
#endif
}

void lwmutex_set_free(vm::ptr<sys_lwmutex_t> lwmutex)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	lwmutex_write_u32(lwmutex, lwmutex_vars_offset(), lwmutex_free);
	lwmutex_write_u32(lwmutex, lwmutex_vars_offset() + sizeof(u32), 0);
#else
	lwmutex->lock_var.store({ lwmutex_free, 0 });
#endif
}

void lwmutex_add_waiter(vm::ptr<sys_lwmutex_t> lwmutex, s32 value)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	const u32 offset = lwmutex_vars_offset() + sizeof(u32);
	const u32 waiter = lwmutex_read_u32(lwmutex, offset);
	lwmutex_write_u32(lwmutex, offset, waiter + static_cast<u32>(value));
#else
	lwmutex->all_info += value;
#endif
}

void lwmutex_reserve_owner(vm::ptr<sys_lwmutex_t> lwmutex)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	const u32 waiter_offset = lwmutex_vars_offset() + sizeof(u32);
	const u32 waiter = lwmutex_read_u32(lwmutex, waiter_offset);
	lwmutex_write_u32(lwmutex, waiter_offset, waiter + 1);
	lwmutex_write_u32(lwmutex, lwmutex_vars_offset(), lwmutex_reserved);
#else
	lwmutex->lock_var.atomic_op([](sys_lwmutex_t::sync_var_t& var)
	{
		var.waiter++;
		var.owner = lwmutex_reserved;
	});
#endif
}

void lwmutex_restore_owner(vm::ptr<sys_lwmutex_t> lwmutex, u32 owner)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	const u32 waiter_offset = lwmutex_vars_offset() + sizeof(u32);
	const u32 waiter = lwmutex_read_u32(lwmutex, waiter_offset);
	lwmutex_write_u32(lwmutex, waiter_offset, waiter - 1);
	lwmutex_write_u32(lwmutex, lwmutex_vars_offset(), owner);
#else
	lwmutex->lock_var.atomic_op([owner](sys_lwmutex_t::sync_var_t& var)
	{
		var.waiter--;
		var.owner = owner;
	});
#endif
}

bool lwmutex_release_if_unwaited(vm::ptr<sys_lwmutex_t> lwmutex, u32 owner)
{
#ifdef RPCS3_WEB
	std::lock_guard lock(s_lwmutex_guest_mutex);
	const u32 waiter = lwmutex_read_u32(lwmutex, lwmutex_vars_offset() + sizeof(u32));
	if (waiter == 0 && lwmutex_read_u32(lwmutex, lwmutex_vars_offset()) == owner)
	{
		lwmutex_write_u32(lwmutex, lwmutex_vars_offset(), lwmutex_free);
		return true;
	}
	return false;
#else
	return lwmutex->lock_var.compare_and_swap_test({ owner, 0 }, { lwmutex_free, 0 });
#endif
}

error_code sys_lwmutex_create(ppu_thread& ppu, vm::ptr<sys_lwmutex_t> lwmutex, vm::ptr<sys_lwmutex_attribute_t> attr)
{
	sysPrxForUser.trace("sys_lwmutex_create(lwmutex=*0x%x, attr=*0x%x)", lwmutex, attr);

	const u32 recursive = attr->recursive;

	if (recursive != SYS_SYNC_RECURSIVE && recursive != SYS_SYNC_NOT_RECURSIVE)
	{
		sysPrxForUser.error("sys_lwmutex_create(): invalid recursive attribute (0x%x)", recursive);
		return CELL_EINVAL;
	}

	const u32 protocol = attr->protocol;

	switch (protocol)
	{
	case SYS_SYNC_FIFO: break;
	case SYS_SYNC_RETRY: break;
	case SYS_SYNC_PRIORITY: break;
	default: sysPrxForUser.error("sys_lwmutex_create(): invalid protocol (0x%x)", protocol); return CELL_EINVAL;
	}

	vm::var<u32> out_id;
	vm::var<sys_mutex_attribute_t> attrs;
	attrs->protocol  = protocol == SYS_SYNC_FIFO ? SYS_SYNC_FIFO : SYS_SYNC_PRIORITY;
	attrs->recursive = attr->recursive;
	attrs->pshared   = SYS_SYNC_NOT_PROCESS_SHARED;
	attrs->adaptive  = SYS_SYNC_NOT_ADAPTIVE;
	attrs->ipc_key   = 0;
	attrs->flags     = 0;
	attrs->name_u64  = attr->name_u64;

	if (error_code res = g_cfg.core.hle_lwmutex ? sys_mutex_create(ppu, out_id, attrs) : _sys_lwmutex_create(ppu, out_id, protocol, lwmutex, 0x80000001, std::bit_cast<be_t<u64>>(attr->name_u64)))
	{
		return res;
	}

	lwmutex_set_free(lwmutex);
	lwmutex_set_attribute(lwmutex, attr->recursive | attr->protocol);
	lwmutex_set_recursive_count(lwmutex, 0);
	lwmutex_set_sleep_queue(lwmutex, *out_id);
	return CELL_OK;
}

error_code sys_lwmutex_destroy(ppu_thread& ppu, vm::ptr<sys_lwmutex_t> lwmutex)
{
	sysPrxForUser.trace("sys_lwmutex_destroy(lwmutex=*0x%x)", lwmutex);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_mutex_destroy(ppu, lwmutex_get_sleep_queue(lwmutex));
	}

	// check to prevent recursive locking in the next call
	if (lwmutex_owner_load(lwmutex) == ppu.id)
	{
		return CELL_EBUSY;
	}

	// attempt to lock the mutex
	if (error_code res = sys_lwmutex_trylock(ppu, lwmutex))
	{
		return res;
	}

	// call the syscall
	if (error_code res = _sys_lwmutex_destroy(ppu, lwmutex_get_sleep_queue(lwmutex)))
	{
		// unlock the mutex if failed
		sys_lwmutex_unlock(ppu, lwmutex);

		return res;
	}

	// deleting succeeded
	lwmutex_owner_release(lwmutex, lwmutex_dead);

	return CELL_OK;
}

error_code sys_lwmutex_lock(ppu_thread& ppu, vm::ptr<sys_lwmutex_t> lwmutex, u64 timeout)
{
	sysPrxForUser.trace("sys_lwmutex_lock(lwmutex=*0x%x, timeout=0x%llx)", lwmutex, timeout);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_mutex_lock(ppu, lwmutex_get_sleep_queue(lwmutex), timeout);
	}

	auto& sstate = *ppu.optional_savestate_state;
	const bool aborted = sstate.try_read<bool>().second;

	if (aborted)
	{
		// Restore timeout (SYS_SYNC_RETRY mode)
		sstate(timeout);
	}

	const be_t<u32> tid(ppu.id);

	// try to lock lightweight mutex
	const u32 old_owner = lwmutex_owner_compare_and_swap(lwmutex, lwmutex_free, tid);

	if (old_owner == lwmutex_free)
	{
		// locking succeeded
		return CELL_OK;
	}

	if (old_owner == tid)
	{
		// recursive locking

		if ((lwmutex_get_attribute(lwmutex) & SYS_SYNC_RECURSIVE) == 0u)
		{
			// if not recursive
			return CELL_EDEADLK;
		}

		const u32 recursive_count = lwmutex_get_recursive_count(lwmutex);
		if (recursive_count == umax)
		{
			// if recursion limit reached
			return CELL_EKRESOURCE;
		}

		// recursive locking succeeded
		lwmutex_set_recursive_count(lwmutex, recursive_count + 1);
		atomic_fence_acq_rel();

		return CELL_OK;
	}

	if (old_owner == lwmutex_dead)
	{
		// invalid or deleted mutex
		return CELL_EINVAL;
	}

	for (u32 i = 0; i < 10; i++)
	{
		busy_wait();

		if (lwmutex_owner_load(lwmutex) == lwmutex_free)
		{
			if (lwmutex_owner_compare_and_swap_test(lwmutex, lwmutex_free, tid))
			{
				// locking succeeded
				return CELL_OK;
			}
		}
	}

	// atomically increment waiter value using 64 bit op
	if (!aborted)
	{
		lwmutex_add_waiter(lwmutex, 1);
	}

	if (lwmutex_owner_compare_and_swap_test(lwmutex, lwmutex_free, tid))
	{
		// locking succeeded
		lwmutex_add_waiter(lwmutex, -1);

		return CELL_OK;
	}

	// lock using the syscall
	const error_code res = _sys_lwmutex_lock(ppu, lwmutex_get_sleep_queue(lwmutex), timeout);

	static_cast<void>(ppu.test_stopped());

	if (ppu.state & cpu_flag::again)
	{
		sstate.pos = 0;
		sstate(true, timeout); // Aborted
		return {};
	}

	lwmutex_add_waiter(lwmutex, -1);

	if (res == CELL_OK)
	{
		// locking succeeded
		auto old = lwmutex_owner_exchange(lwmutex, tid);

		if (old != lwmutex_reserved)
		{
			fmt::throw_exception("Locking failed (lwmutex=*0x%x, owner=0x%x)", lwmutex, old);
		}

		return CELL_OK;
	}

	if (res + 0u == CELL_EBUSY && lwmutex_get_attribute(lwmutex) & SYS_SYNC_RETRY)
	{
		while (true)
		{
			for (u32 i = 0; i < 10; i++)
			{
				busy_wait();

				if (lwmutex_owner_load(lwmutex) == lwmutex_free)
				{
					if (lwmutex_owner_compare_and_swap_test(lwmutex, lwmutex_free, tid))
					{
						return CELL_OK;
					}
				}
			}

			lwmutex_add_waiter(lwmutex, 1);

			if (lwmutex_owner_compare_and_swap_test(lwmutex, lwmutex_free, tid))
			{
				lwmutex_add_waiter(lwmutex, -1);
				return CELL_OK;
			}

			const u64 time0 = timeout ? get_guest_system_time() : 0;

			const error_code res_ = _sys_lwmutex_lock(ppu, lwmutex_get_sleep_queue(lwmutex), timeout);

			static_cast<void>(ppu.test_stopped());

			if (ppu.state & cpu_flag::again)
			{
				sstate.pos = 0;
				sstate(true, timeout); // Aborted
				return {};
			}

			if (res_ == CELL_OK)
			{
				lwmutex_owner_release(lwmutex, tid);
			}
			else if (timeout && res_ + 0u != CELL_ETIMEDOUT)
			{
				const u64 time_diff = get_guest_system_time() - time0;

				if (timeout <= time_diff)
				{
					lwmutex_add_waiter(lwmutex, -1);
					return not_an_error(CELL_ETIMEDOUT);
				}

				timeout -= time_diff;
			}

			lwmutex_add_waiter(lwmutex, -1);

			if (res_ + 0u != CELL_EBUSY)
			{
				return res_;
			}
		}
	}

	return res;
}

error_code sys_lwmutex_trylock(ppu_thread& ppu, vm::ptr<sys_lwmutex_t> lwmutex)
{
	sysPrxForUser.trace("sys_lwmutex_trylock(lwmutex=*0x%x)", lwmutex);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_mutex_trylock(ppu, lwmutex_get_sleep_queue(lwmutex));
	}

	const be_t<u32> tid(ppu.id);

	// try to lock lightweight mutex
	const u32 old_owner = lwmutex_owner_compare_and_swap(lwmutex, lwmutex_free, tid);

	if (old_owner == lwmutex_free)
	{
		// locking succeeded
		return CELL_OK;
	}

	if (old_owner == tid)
	{
		// recursive locking

		if ((lwmutex_get_attribute(lwmutex) & SYS_SYNC_RECURSIVE) == 0u)
		{
			// if not recursive
			return CELL_EDEADLK;
		}

		const u32 recursive_count = lwmutex_get_recursive_count(lwmutex);
		if (recursive_count == umax)
		{
			// if recursion limit reached
			return CELL_EKRESOURCE;
		}

		// recursive locking succeeded
		lwmutex_set_recursive_count(lwmutex, recursive_count + 1);
		atomic_fence_acq_rel();

		return CELL_OK;
	}

	if (old_owner == lwmutex_dead)
	{
		// invalid or deleted mutex
		return CELL_EINVAL;
	}

	if (old_owner == lwmutex_reserved)
	{
		// should be locked by the syscall
		const error_code res = _sys_lwmutex_trylock(ppu, lwmutex_get_sleep_queue(lwmutex));

		if (res == CELL_OK)
		{
			// locking succeeded
			auto old = lwmutex_owner_exchange(lwmutex, tid);

			if (old != lwmutex_reserved)
			{
				fmt::throw_exception("Locking failed (lwmutex=*0x%x, owner=0x%x)", lwmutex, old);
			}
		}

		return res;
	}

	// locked by another thread
	return not_an_error(CELL_EBUSY);
}

error_code sys_lwmutex_unlock(ppu_thread& ppu, vm::ptr<sys_lwmutex_t> lwmutex)
{
	sysPrxForUser.trace("sys_lwmutex_unlock(lwmutex=*0x%x)", lwmutex);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_mutex_unlock(ppu, lwmutex_get_sleep_queue(lwmutex));
	}

	const be_t<u32> tid(ppu.id);

	// check owner
	if (lwmutex_owner_load(lwmutex) != tid)
	{
		return CELL_EPERM;
	}

	if (const u32 recursive_count = lwmutex_get_recursive_count(lwmutex))
	{
		// recursive unlocking succeeded
		lwmutex_set_recursive_count(lwmutex, recursive_count - 1);

		return CELL_OK;
	}

	// ensure that waiter is zero
	if (lwmutex_release_if_unwaited(lwmutex, tid))
	{
		// unlocking succeeded
		return CELL_OK;
	}

	if (lwmutex_get_attribute(lwmutex) & SYS_SYNC_RETRY)
	{
		lwmutex_owner_release(lwmutex, lwmutex_free);

		// Call the alternative syscall
		if (_sys_lwmutex_unlock2(ppu, lwmutex_get_sleep_queue(lwmutex)) + 0u == CELL_ESRCH)
		{
			return CELL_ESRCH;
		}

		return CELL_OK;
	}

	// set special value
	lwmutex_owner_release(lwmutex, lwmutex_reserved);

	// call the syscall
	if (_sys_lwmutex_unlock(ppu, lwmutex_get_sleep_queue(lwmutex)) + 0u == CELL_ESRCH)
	{
		return CELL_ESRCH;
	}

	return CELL_OK;
}

void sysPrxForUser_sys_lwmutex_init(ppu_static_module* _this)
{
	REG_FUNC(sysPrxForUser, sys_lwmutex_create);
	REG_FUNC(sysPrxForUser, sys_lwmutex_destroy);
	REG_FUNC(sysPrxForUser, sys_lwmutex_lock);
	REG_FUNC(sysPrxForUser, sys_lwmutex_trylock);
	REG_FUNC(sysPrxForUser, sys_lwmutex_unlock);

	_this->add_init_func([](ppu_static_module*)
	{
		REINIT_FUNC(sys_lwmutex_create).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwmutex_destroy).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwmutex_lock).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwmutex_trylock).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwmutex_unlock).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
	});
}
