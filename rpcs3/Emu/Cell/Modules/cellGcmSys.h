#pragma once

#include "Emu/RSX/GCM.h"
#include "Emu/Memory/vm_ptr.h"

enum CellGcmError : u32
{
	CELL_GCM_ERROR_FAILURE           = 0x802100ff,
	CELL_GCM_ERROR_NO_IO_PAGE_TABLE  = 0x80210001,
	CELL_GCM_ERROR_INVALID_ENUM      = 0x80210002,
	CELL_GCM_ERROR_INVALID_VALUE     = 0x80210003,
	CELL_GCM_ERROR_INVALID_ALIGNMENT = 0x80210004,
	CELL_GCM_ERROR_ADDRESS_OVERWRAP  = 0x80210005,
};

struct CellGcmOffsetTable
{
	ENABLE_BITWISE_SERIALIZATION;

	vm::bptr<u16> ioAddress;
	vm::bptr<u16> eaAddress;
};

struct gcm_config
{
	u32 zculls_addr = 0;
	vm::ptr<CellGcmDisplayInfo> gcm_buffers = vm::null;
	u32 tiles_addr = 0;
	u32 ctxt_addr = 0;

	CellGcmConfig current_config{};
	CellGcmContextData current_context{};
	gcmInfo gcm_info{};

	CellGcmOffsetTable offsetTable{};
	u16 IoMapTable[0xC00]{};
	shared_mutex gcmio_mutex;

	u64 system_mode = 0;
	u32 local_size = 0;
	u32 local_addr = 0;

	atomic_t<u32> reserved_size = 0;
	u32 default_cmd_buffer_begin = 0;
	u32 default_cmd_buffer_frag_count = 0;

	SAVESTATE_INIT_POS(46);

	gcm_config() = default;
	gcm_config(utils::serial& ar)
	{
		save(ar);
	}

	void save(utils::serial& ar)
	{
		ar(zculls_addr, gcm_buffers, tiles_addr, ctxt_addr, current_config, current_context, gcm_info, offsetTable, IoMapTable, system_mode, local_size, local_addr, reserved_size, default_cmd_buffer_begin, default_cmd_buffer_frag_count);
	}
};

void InitOffsetTable();
