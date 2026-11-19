#include "stdafx.h"
#include "Emu/system_config.h"
#include "Emu/Cell/PPUModule.h"
#include "Emu/Cell/lv2/sys_lwmutex.h"
#include "Emu/Cell/lv2/sys_lwcond.h"
#include "Emu/Cell/lv2/sys_cond.h"
#include "sysPrxForUser.h"

LOG_CHANNEL(sysPrxForUser);

error_code sys_lwcond_create(ppu_thread& ppu, vm::ptr<sys_lwcond_t> lwcond, vm::ptr<sys_lwmutex_t> lwmutex, vm::ptr<sys_lwcond_attribute_t> attr)
{
	sysPrxForUser.trace("sys_lwcond_create(lwcond=*0x%x, lwmutex=*0x%x, attr=*0x%x)", lwcond, lwmutex, attr);

	vm::var<u32> out_id;
	vm::var<sys_cond_attribute_t> attrs;
	attrs->pshared  = SYS_SYNC_NOT_PROCESS_SHARED;
	attrs->name_u64 = attr->name_u64;

	if (auto res = g_cfg.core.hle_lwmutex ? sys_cond_create(ppu, out_id, lwmutex_get_sleep_queue(lwmutex), attrs) : _sys_lwcond_create(ppu, out_id, lwmutex_get_sleep_queue(lwmutex), lwcond, std::bit_cast<be_t<u64>>(attr->name_u64)))
	{
		return res;
	}

	lwcond->lwmutex      = lwmutex;
	lwcond->lwcond_queue = *out_id;
	return CELL_OK;
}

error_code sys_lwcond_destroy(ppu_thread& ppu, vm::ptr<sys_lwcond_t> lwcond)
{
	sysPrxForUser.trace("sys_lwcond_destroy(lwcond=*0x%x)", lwcond);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_cond_destroy(ppu, lwcond->lwcond_queue);
	}

	if (error_code res = _sys_lwcond_destroy(ppu, lwcond->lwcond_queue))
	{
		return res;
	}

	lwcond->lwcond_queue = lwmutex_dead;
	return CELL_OK;
}

error_code sys_lwcond_signal(ppu_thread& ppu, vm::ptr<sys_lwcond_t> lwcond)
{
	sysPrxForUser.trace("sys_lwcond_signal(lwcond=*0x%x)", lwcond);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_cond_signal(ppu, lwcond->lwcond_queue);
	}

	const vm::ptr<sys_lwmutex_t> lwmutex = lwcond->lwmutex;

	if ((lwmutex_get_attribute(lwmutex) & SYS_SYNC_ATTR_PROTOCOL_MASK) == SYS_SYNC_RETRY)
	{
		return _sys_lwcond_signal(ppu, lwcond->lwcond_queue, 0, u32{umax}, 2);
	}

	if (lwmutex_owner_load(lwmutex) == ppu.id)
	{
		// if owns the mutex
		lwmutex_add_waiter(lwmutex, 1);

		// call the syscall
		if (error_code res = _sys_lwcond_signal(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), u32{umax}, 1))
		{
			static_cast<void>(ppu.test_stopped());

			lwmutex_add_waiter(lwmutex, -1);

			if (res + 0u != CELL_EPERM)
			{
				return res;
			}
		}

		return CELL_OK;
	}

	if (error_code res = sys_lwmutex_trylock(ppu, lwmutex))
	{
		// if locking failed

		if (res + 0u != CELL_EBUSY)
		{
			return CELL_ESRCH;
		}

		// call the syscall
		return _sys_lwcond_signal(ppu, lwcond->lwcond_queue, 0, u32{umax}, 2);
	}

	// if locking succeeded
	lwmutex_reserve_owner(lwmutex);

	// call the syscall
	if (error_code res = _sys_lwcond_signal(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), u32{umax}, 3))
	{
		static_cast<void>(ppu.test_stopped());

		lwmutex_restore_owner(lwmutex, ppu.id);

		// unlock the lightweight mutex
		sys_lwmutex_unlock(ppu, lwmutex);

		if (res + 0u != CELL_ENOENT)
		{
			return res;
		}
	}

	return CELL_OK;
}

error_code sys_lwcond_signal_all(ppu_thread& ppu, vm::ptr<sys_lwcond_t> lwcond)
{
	sysPrxForUser.trace("sys_lwcond_signal_all(lwcond=*0x%x)", lwcond);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_cond_signal_all(ppu, lwcond->lwcond_queue);
	}

	const vm::ptr<sys_lwmutex_t> lwmutex = lwcond->lwmutex;

	if ((lwmutex_get_attribute(lwmutex) & SYS_SYNC_ATTR_PROTOCOL_MASK) == SYS_SYNC_RETRY)
	{
		return _sys_lwcond_signal_all(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), 2);
	}

	if (lwmutex_owner_load(lwmutex) == ppu.id)
	{
		// if owns the mutex, call the syscall
		const error_code res = _sys_lwcond_signal_all(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), 1);

		if (res <= 0)
		{
			// return error or CELL_OK
			return res;
		}

		static_cast<void>(ppu.test_stopped());

		lwmutex_add_waiter(lwmutex, static_cast<s32>(res));
		return CELL_OK;
	}

	if (error_code res = sys_lwmutex_trylock(ppu, lwmutex))
	{
		// if locking failed

		if (res + 0u != CELL_EBUSY)
		{
			return CELL_ESRCH;
		}

		// call the syscall
		return _sys_lwcond_signal_all(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), 2);
	}

	// if locking succeeded, call the syscall
	error_code res = _sys_lwcond_signal_all(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), 1);

	static_cast<void>(ppu.test_stopped());

	if (res > 0)
	{
		lwmutex_add_waiter(lwmutex, static_cast<s32>(res));

		res = CELL_OK;
	}

	// unlock mutex
	sys_lwmutex_unlock(ppu, lwmutex);

	return res;
}

error_code sys_lwcond_signal_to(ppu_thread& ppu, vm::ptr<sys_lwcond_t> lwcond, u64 ppu_thread_id)
{
	sysPrxForUser.trace("sys_lwcond_signal_to(lwcond=*0x%x, ppu_thread_id=0x%llx)", lwcond, ppu_thread_id);

	if (g_cfg.core.hle_lwmutex)
	{
		if (ppu_thread_id == u32{umax})
		{
			return sys_cond_signal(ppu, lwcond->lwcond_queue);
		}

		return sys_cond_signal_to(ppu, lwcond->lwcond_queue, static_cast<u32>(ppu_thread_id));
	}

	const vm::ptr<sys_lwmutex_t> lwmutex = lwcond->lwmutex;

	if ((lwmutex_get_attribute(lwmutex) & SYS_SYNC_ATTR_PROTOCOL_MASK) == SYS_SYNC_RETRY)
	{
		return _sys_lwcond_signal(ppu, lwcond->lwcond_queue, 0, ppu_thread_id, 2);
	}

	if (lwmutex_owner_load(lwmutex) == ppu.id)
	{
		// if owns the mutex
		lwmutex_add_waiter(lwmutex, 1);

		// call the syscall
		if (error_code res = _sys_lwcond_signal(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), ppu_thread_id, 1))
		{
			static_cast<void>(ppu.test_stopped());

			lwmutex_add_waiter(lwmutex, -1);

			return res;
		}

		return CELL_OK;
	}

	if (error_code res = sys_lwmutex_trylock(ppu, lwmutex))
	{
		// if locking failed

		if (res + 0u != CELL_EBUSY)
		{
			return CELL_ESRCH;
		}

		// call the syscall
		return _sys_lwcond_signal(ppu, lwcond->lwcond_queue, 0, ppu_thread_id, 2);
	}

	// if locking succeeded
	lwmutex_reserve_owner(lwmutex);

	// call the syscall
	if (error_code res = _sys_lwcond_signal(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), ppu_thread_id, 3))
	{
		static_cast<void>(ppu.test_stopped());

		lwmutex_restore_owner(lwmutex, ppu.id);

		// unlock the lightweight mutex
		sys_lwmutex_unlock(ppu, lwmutex);

		return res;
	}

	return CELL_OK;
}

error_code sys_lwcond_wait(ppu_thread& ppu, vm::ptr<sys_lwcond_t> lwcond, u64 timeout)
{
	sysPrxForUser.trace("sys_lwcond_wait(lwcond=*0x%x, timeout=0x%llx)", lwcond, timeout);

	if (g_cfg.core.hle_lwmutex)
	{
		return sys_cond_wait(ppu, lwcond->lwcond_queue, timeout);
	}

	auto& sstate = *ppu.optional_savestate_state;
	const auto lwcond_ec = sstate.try_read<error_code>().second;

	const be_t<u32> tid(ppu.id);

	const vm::ptr<sys_lwmutex_t> lwmutex = lwcond->lwmutex;

	if (lwmutex_owner_load(lwmutex) != tid)
	{
		// if not owner of the mutex
		return CELL_EPERM;
	}

	// save old recursive value
	const be_t<u32> recursive_value = !lwcond_ec ? be_t<u32>(lwmutex_get_recursive_count(lwmutex)) : sstate.operator be_t<u32>();

	// set special value
	lwmutex_owner_release(lwmutex, lwmutex_reserved);
	lwmutex_set_recursive_count(lwmutex, 0);

	// call the syscall
	const error_code res = !lwcond_ec ? _sys_lwcond_queue_wait(ppu, lwcond->lwcond_queue, lwmutex_get_sleep_queue(lwmutex), timeout) : lwcond_ec;

	static_cast<void>(ppu.test_stopped());

	if (ppu.state & cpu_flag::again)
	{
		sstate.pos = 0;
		sstate(error_code{}, recursive_value); // Not aborted on mutex sleep
		return {};
	}

	if (res == CELL_OK || res + 0u == CELL_ESRCH)
	{
		if (res == CELL_OK)
		{
			lwmutex_add_waiter(lwmutex, -1);
		}

		// restore owner and recursive value
		const auto old = lwmutex_owner_exchange(lwmutex, tid);
		lwmutex_set_recursive_count(lwmutex, +recursive_value);

		if (old == lwmutex_free || old == lwmutex_dead)
		{
			fmt::throw_exception("Locking failed (lwmutex=*0x%x, owner=0x%x)", lwmutex, old);
		}

		return res;
	}

	if (res + 0u == CELL_EBUSY || res + 0u == CELL_ETIMEDOUT)
	{
		if (error_code res2 = sys_lwmutex_lock(ppu, lwmutex, 0))
		{
			return res2;
		}

		if (ppu.state & cpu_flag::again)
		{
			sstate.pos = 0;
			sstate(res, recursive_value);
			return {};
		}

		// if successfully locked, restore recursive value
		lwmutex_set_recursive_count(lwmutex, +recursive_value);

		if (res + 0u == CELL_EBUSY)
		{
			return CELL_OK;
		}

		return res;
	}

	if (res + 0u == CELL_EDEADLK)
	{
		// restore owner and recursive value
		const auto old = lwmutex_owner_exchange(lwmutex, tid);
		lwmutex_set_recursive_count(lwmutex, +recursive_value);

		if (old == lwmutex_free || old == lwmutex_dead)
		{
			fmt::throw_exception("Locking failed (lwmutex=*0x%x, owner=0x%x)", lwmutex, old);
		}

		return not_an_error(CELL_ETIMEDOUT);
	}

	fmt::throw_exception("Unexpected syscall result (lwcond=*0x%x, result=0x%x)", lwcond, +res);
}

void sysPrxForUser_sys_lwcond_init(ppu_static_module* _this)
{
	REG_FUNC(sysPrxForUser, sys_lwcond_create);
	REG_FUNC(sysPrxForUser, sys_lwcond_destroy);
	REG_FUNC(sysPrxForUser, sys_lwcond_signal);
	REG_FUNC(sysPrxForUser, sys_lwcond_signal_all);
	REG_FUNC(sysPrxForUser, sys_lwcond_signal_to);
	REG_FUNC(sysPrxForUser, sys_lwcond_wait);

	_this->add_init_func([](ppu_static_module*)
	{
		REINIT_FUNC(sys_lwcond_create).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwcond_destroy).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwcond_signal).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwcond_signal_all).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwcond_signal_to).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
		REINIT_FUNC(sys_lwcond_wait).flag(g_cfg.core.hle_lwmutex ? MFF_FORCED_HLE : MFF_PERFECT);
	});
}
