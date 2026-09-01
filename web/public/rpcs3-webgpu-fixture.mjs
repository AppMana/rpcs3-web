import { decodeDrawPacket } from "./rpcs3-webgpu-packet.mjs";

const Magic = Uint8Array.of(0x52, 0x50, 0x43, 0x53, 0x33, 0x57, 0x47, 0x46);
const Version = 1;

export function encodePacketFixture(packetBuffers) {
  if (!Array.isArray(packetBuffers) || packetBuffers.length === 0) throw new TypeError("a packet frame is required");
  const packets = packetBuffers.map((packet) => packet instanceof Uint8Array ? packet : new Uint8Array(packet));
  const headerSize = 16 + packets.length * 4;
  const size = packets.reduce((sum, packet) => sum + packet.byteLength, headerSize);
  const fixture = new Uint8Array(size);
  fixture.set(Magic);
  const view = new DataView(fixture.buffer);
  view.setUint32(8, Version, true);
  view.setUint32(12, packets.length, true);
  let offset = headerSize;
  for (let index = 0; index < packets.length; index += 1) {
    view.setUint32(16 + index * 4, packets[index].byteLength, true);
    fixture.set(packets[index], offset);
    offset += packets[index].byteLength;
  }
  return fixture;
}

export function decodePacketFixtureBytes(fixture) {
  const bytes = fixture instanceof Uint8Array ? fixture : new Uint8Array(fixture);
  if (bytes.byteLength < 20 || !Magic.every((value, index) => bytes[index] === value)) {
    throw new Error("invalid RPCS3 WebGPU packet fixture");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== Version) throw new Error("unsupported RPCS3 WebGPU packet fixture version");
  const count = view.getUint32(12, true);
  const headerSize = 16 + count * 4;
  if (!count || headerSize > bytes.byteLength) throw new Error("invalid RPCS3 WebGPU packet fixture table");
  const packets = [];
  let offset = headerSize;
  for (let index = 0; index < count; index += 1) {
    const size = view.getUint32(16 + index * 4, true);
    if (!size || offset + size > bytes.byteLength) throw new Error(`invalid RPCS3 WebGPU fixture packet ${index}`);
    packets.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset !== bytes.byteLength) throw new Error("RPCS3 WebGPU packet fixture has trailing bytes");
  return packets;
}

export async function loadPacketFixture(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`packet fixture fetch failed with HTTP ${response.status}`);
  const payload = new Uint8Array(await response.arrayBuffer());
  let bytes = payload;
  if (!Magic.every((value, index) => payload[index] === value)) {
    const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return decodePacketFixtureBytes(bytes).map(decodeDrawPacket);
}
