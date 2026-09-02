#pragma once

#include <vector>
#include <map>
#include "Utilities/mutex.h"
#include "Emu/Cell/PPUThread.h"

#include "nt_p2p_port.h"

struct base_network_thread
{
	void add_ppu_to_awake(ppu_thread* ppu);
	void del_ppu_to_awake(ppu_thread* ppu);

	shared_mutex mutex_ppu_to_awake;
	std::vector<ppu_thread*> ppu_to_awake;
	shared_mutex mutex_thread_loop;

	void wake_threads();
};

struct network_thread : base_network_thread
{
	atomic_t<u32> num_polls = 0;

	static constexpr auto thread_name = "Network Thread";

	void operator()();
};

// A datagram a P2P socket sent to the console's own address on a port without a host
// datagram transport (browser builds); the P2P thread delivers it the way the host kernel
// loops back local traffic on a real socket.
struct p2p_loopback_datagram
{
	u16 port = 0;
	::sockaddr_storage src{};
	std::vector<u8> data;
};

struct p2p_thread : base_network_thread
{
	shared_mutex list_p2p_ports_mutex;
	std::map<u16, nt_p2p_port> list_p2p_ports;
	atomic_t<u32> num_p2p_ports = 0;

	shared_mutex loopback_mutex;
	std::vector<p2p_loopback_datagram> loopback_queue;

	void queue_loopback(u16 port, const ::sockaddr_in& src, std::vector<u8> data);
	void deliver_loopback();

	static constexpr auto thread_name = "Network P2P Thread";

	p2p_thread();

	void create_p2p_port(u16 p2p_port);

	void bind_sce_np_port();
	void operator()();
};

using network_context = named_thread<network_thread>;
using p2p_context = named_thread<p2p_thread>;
