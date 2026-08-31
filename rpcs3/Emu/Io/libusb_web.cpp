#include <libusb.h>

#include <cstdlib>

// Browser builds retain RPCS3's emulated USB devices, but physical host USB
// pass-through is not available in Mobile Safari. This adapter models an
// initialized libusb host with an empty device list and reports unsupported
// for operations that require a physical device. It never reports a transfer
// or device operation as successful.

extern "C"
{
	int LIBUSB_CALL libusb_init(libusb_context** ctx)
	{
		if (ctx) *ctx = nullptr;
		return LIBUSB_SUCCESS;
	}

	int LIBUSB_CALL libusb_init_context(libusb_context** ctx, const libusb_init_option[], int)
	{
		return libusb_init(ctx);
	}

	void LIBUSB_CALL libusb_exit(libusb_context*)
	{
	}

	int LIBUSB_CALL libusb_has_capability(uint32_t)
	{
		return 0;
	}

	const char* LIBUSB_CALL libusb_error_name(int error_code)
	{
		switch (error_code)
		{
		case LIBUSB_SUCCESS: return "LIBUSB_SUCCESS";
		case LIBUSB_ERROR_IO: return "LIBUSB_ERROR_IO";
		case LIBUSB_ERROR_INVALID_PARAM: return "LIBUSB_ERROR_INVALID_PARAM";
		case LIBUSB_ERROR_ACCESS: return "LIBUSB_ERROR_ACCESS";
		case LIBUSB_ERROR_NO_DEVICE: return "LIBUSB_ERROR_NO_DEVICE";
		case LIBUSB_ERROR_NOT_FOUND: return "LIBUSB_ERROR_NOT_FOUND";
		case LIBUSB_ERROR_BUSY: return "LIBUSB_ERROR_BUSY";
		case LIBUSB_ERROR_TIMEOUT: return "LIBUSB_ERROR_TIMEOUT";
		case LIBUSB_ERROR_OVERFLOW: return "LIBUSB_ERROR_OVERFLOW";
		case LIBUSB_ERROR_PIPE: return "LIBUSB_ERROR_PIPE";
		case LIBUSB_ERROR_INTERRUPTED: return "LIBUSB_ERROR_INTERRUPTED";
		case LIBUSB_ERROR_NO_MEM: return "LIBUSB_ERROR_NO_MEM";
		case LIBUSB_ERROR_NOT_SUPPORTED: return "LIBUSB_ERROR_NOT_SUPPORTED";
		default: return "LIBUSB_ERROR_OTHER";
		}
	}

	ssize_t LIBUSB_CALL libusb_get_device_list(libusb_context*, libusb_device*** list)
	{
		if (!list) return LIBUSB_ERROR_INVALID_PARAM;
		*list = static_cast<libusb_device**>(std::calloc(1, sizeof(libusb_device*)));
		return *list ? 0 : LIBUSB_ERROR_NO_MEM;
	}

	void LIBUSB_CALL libusb_free_device_list(libusb_device** list, int)
	{
		std::free(list);
	}

	libusb_device* LIBUSB_CALL libusb_ref_device(libusb_device* dev)
	{
		return dev;
	}

	void LIBUSB_CALL libusb_unref_device(libusb_device*)
	{
	}

	int LIBUSB_CALL libusb_get_device_descriptor(libusb_device*, libusb_device_descriptor*)
	{
		return LIBUSB_ERROR_NO_DEVICE;
	}

	uint8_t LIBUSB_CALL libusb_get_port_number(libusb_device*)
	{
		return 0;
	}

	uint8_t LIBUSB_CALL libusb_get_device_address(libusb_device*)
	{
		return 0;
	}

	int LIBUSB_CALL libusb_open(libusb_device*, libusb_device_handle** handle)
	{
		if (handle) *handle = nullptr;
		return LIBUSB_ERROR_NO_DEVICE;
	}

	void LIBUSB_CALL libusb_close(libusb_device_handle*)
	{
	}

	int LIBUSB_CALL libusb_get_configuration(libusb_device_handle*, int*)
	{
		return LIBUSB_ERROR_NO_DEVICE;
	}

	int LIBUSB_CALL libusb_set_configuration(libusb_device_handle*, int)
	{
		return LIBUSB_ERROR_NO_DEVICE;
	}

	int LIBUSB_CALL libusb_claim_interface(libusb_device_handle*, int)
	{
		return LIBUSB_ERROR_NO_DEVICE;
	}

	int LIBUSB_CALL libusb_release_interface(libusb_device_handle*, int)
	{
		return LIBUSB_ERROR_NO_DEVICE;
	}

	int LIBUSB_CALL libusb_set_auto_detach_kernel_driver(libusb_device_handle*, int)
	{
		return LIBUSB_ERROR_NOT_SUPPORTED;
	}

	int LIBUSB_CALL libusb_control_transfer(libusb_device_handle*, uint8_t, uint8_t,
		uint16_t, uint16_t, unsigned char*, uint16_t, unsigned int)
	{
		return LIBUSB_ERROR_NO_DEVICE;
	}

	libusb_transfer* LIBUSB_CALL libusb_alloc_transfer(int iso_packets)
	{
		if (iso_packets < 0) return nullptr;
		const size_t bytes = sizeof(libusb_transfer) +
			static_cast<size_t>(iso_packets) * sizeof(libusb_iso_packet_descriptor);
		auto* transfer = static_cast<libusb_transfer*>(std::calloc(1, bytes));
		if (transfer) transfer->num_iso_packets = iso_packets;
		return transfer;
	}

	int LIBUSB_CALL libusb_submit_transfer(libusb_transfer* transfer)
	{
		if (transfer)
		{
			transfer->status = LIBUSB_TRANSFER_NO_DEVICE;
			transfer->actual_length = 0;
		}
		return LIBUSB_ERROR_NO_DEVICE;
	}

	void LIBUSB_CALL libusb_free_transfer(libusb_transfer* transfer)
	{
		std::free(transfer);
	}

	int LIBUSB_CALL libusb_handle_events_timeout_completed(libusb_context*, timeval*, int*)
	{
		return LIBUSB_SUCCESS;
	}

	int LIBUSB_CALL libusb_hotplug_register_callback(libusb_context*, int, int, int, int, int,
		libusb_hotplug_callback_fn, void*, libusb_hotplug_callback_handle*)
	{
		return LIBUSB_ERROR_NOT_SUPPORTED;
	}

	void LIBUSB_CALL libusb_hotplug_deregister_callback(libusb_context*, libusb_hotplug_callback_handle)
	{
	}
}
