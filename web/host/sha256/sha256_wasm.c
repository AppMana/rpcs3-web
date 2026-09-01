// Freestanding SHA-256 (FIPS 180-4) for the browser library import worker.
// The state lives at a fixed exported address so JavaScript can snapshot and
// restore it between download chunks (resumable hashing) without an ABI for
// serialization. Built by web/scripts/build-sha256-wasm.sh into a ~1.5 KB
// module embedded as base64 in web/public/library-import-core.mjs.

typedef unsigned int u32;
typedef unsigned long long u64;
typedef unsigned char u8;

#define INPUT_CAPACITY (1u << 20)

struct sha256_state {
	u32 h[8];
	u64 length;      // bytes hashed so far, excluding the pending block
	u32 block_len;   // pending bytes in block
	u8 block[64];
};

static struct sha256_state state;
static u8 input[INPUT_CAPACITY];
static u8 digest_out[32];

static const u32 K[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void compress(const u8* p)
{
	u32 w[64];
	for (int i = 0; i < 16; i++)
		w[i] = ((u32)p[i * 4] << 24) | ((u32)p[i * 4 + 1] << 16) | ((u32)p[i * 4 + 2] << 8) | (u32)p[i * 4 + 3];
	for (int i = 16; i < 64; i++)
	{
		u32 s0 = ROTR(w[i - 15], 7) ^ ROTR(w[i - 15], 18) ^ (w[i - 15] >> 3);
		u32 s1 = ROTR(w[i - 2], 17) ^ ROTR(w[i - 2], 19) ^ (w[i - 2] >> 10);
		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}
	u32 a = state.h[0], b = state.h[1], c = state.h[2], d = state.h[3];
	u32 e = state.h[4], f = state.h[5], g = state.h[6], h = state.h[7];
	for (int i = 0; i < 64; i++)
	{
		u32 t1 = h + (ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
		u32 t2 = (ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
		h = g; g = f; f = e; e = d + t1;
		d = c; c = b; b = a; a = t1 + t2;
	}
	state.h[0] += a; state.h[1] += b; state.h[2] += c; state.h[3] += d;
	state.h[4] += e; state.h[5] += f; state.h[6] += g; state.h[7] += h;
}

__attribute__((export_name("sha256_init"))) void sha256_init(void)
{
	static const u32 initial[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
	for (int i = 0; i < 8; i++) state.h[i] = initial[i];
	state.length = 0;
	state.block_len = 0;
}

__attribute__((export_name("sha256_state"))) struct sha256_state* sha256_state_ptr(void) { return &state; }
__attribute__((export_name("sha256_input"))) u8* sha256_input_ptr(void) { return input; }
__attribute__((export_name("sha256_input_capacity"))) u32 sha256_input_capacity(void) { return INPUT_CAPACITY; }
__attribute__((export_name("sha256_digest_out"))) u8* sha256_digest_out_ptr(void) { return digest_out; }

// Hashes `len` bytes from the input buffer.
__attribute__((export_name("sha256_update"))) void sha256_update(u32 len)
{
	const u8* p = input;
	if (state.block_len)
	{
		u32 take = 64 - state.block_len;
		if (take > len) take = len;
		for (u32 i = 0; i < take; i++) state.block[state.block_len + i] = p[i];
		state.block_len += take;
		p += take;
		len -= take;
		if (state.block_len < 64) return;
		compress(state.block);
		state.length += 64;
		state.block_len = 0;
	}
	while (len >= 64)
	{
		compress(p);
		state.length += 64;
		p += 64;
		len -= 64;
	}
	for (u32 i = 0; i < len; i++) state.block[i] = p[i];
	state.block_len = len;
}

// Finalizes into digest_out; the state is consumed.
__attribute__((export_name("sha256_final"))) void sha256_final(void)
{
	u64 bits = (state.length + state.block_len) * 8;
	u8 pad[128];
	u32 pad_len = (state.block_len < 56) ? (56 - state.block_len) : (120 - state.block_len);
	pad[0] = 0x80;
	for (u32 i = 1; i < pad_len; i++) pad[i] = 0;
	for (int i = 0; i < 8; i++) pad[pad_len + i] = (u8)(bits >> (56 - 8 * i));
	u32 total = pad_len + 8;
	// Feed through the block path without touching the input buffer.
	const u8* p = pad;
	while (total)
	{
		u32 take = 64 - state.block_len;
		if (take > total) take = total;
		for (u32 i = 0; i < take; i++) state.block[state.block_len + i] = p[i];
		state.block_len += take;
		p += take;
		total -= take;
		if (state.block_len == 64)
		{
			compress(state.block);
			state.block_len = 0;
		}
	}
	for (int i = 0; i < 8; i++)
	{
		digest_out[i * 4] = (u8)(state.h[i] >> 24);
		digest_out[i * 4 + 1] = (u8)(state.h[i] >> 16);
		digest_out[i * 4 + 2] = (u8)(state.h[i] >> 8);
		digest_out[i * 4 + 3] = (u8)state.h[i];
	}
}
