// Browser WebAudio (AudioContext + AudioWorklet) zero-copy bridge for RPCS3's
// shared-memory emu::host::SharedAudioRing (rpcs3/Emu/Host/HostPlatform.h).
// Reads interleaved float32 PCM directly from WebAssembly.Memory (SharedArrayBuffer)
// inside the AudioWorklet rendering thread with zero main-thread copies.

const WORKLET_PROCESSOR_SOURCE = `
class Rpcs3SharedRingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.memoryBuffer = opts.memoryBuffer || null;
    this.ringByteOffset = opts.ringByteOffset >>> 0;
    this.samplesByteOffset = (this.ringByteOffset + 32) >>> 0;
    this.header = this.memoryBuffer ? new Int32Array(this.memoryBuffer, this.ringByteOffset, 8) : null;
    this.samples = this.memoryBuffer ? new Float32Array(this.memoryBuffer, this.samplesByteOffset) : null;
    if (this.header) {
      Atomics.store(this.header, 4, 1); // consumer_attached = 1
    }
    this.port.onmessage = (ev) => {
      if (ev.data && ev.data.memoryBuffer) {
        this.memoryBuffer = ev.data.memoryBuffer;
        this.header = new Int32Array(this.memoryBuffer, this.ringByteOffset, 8);
        this.samples = new Float32Array(this.memoryBuffer, this.samplesByteOffset);
        Atomics.store(this.header, 4, 1);
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const frames = out[0].length;
    if (!this.header || !this.samples || Atomics.load(this.header, 3) === 0) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }

    const srcChannels = Math.max(1, Atomics.load(this.header, 1) >>> 0);
    const cap = Atomics.load(this.header, 2) >>> 0;
    const mask = cap - 1;
    const w = Atomics.load(this.header, 5) >>> 0;
    const r = Atomics.load(this.header, 6) >>> 0;
    const avail = Math.min((w - r) >>> 0, cap);
    const count = Math.min(frames, avail);

    for (let i = 0; i < count; i++) {
      const base = ((r + i) & mask) * srcChannels;
      for (let c = 0; c < out.length; c++) {
        out[c][i] = c < srcChannels ? this.samples[base + c] : 0;
      }
    }
    if (count < frames) {
      for (let c = 0; c < out.length; c++) out[c].fill(0, count);
      Atomics.add(this.header, 7, 1);
    }
    Atomics.store(this.header, 6, (r + count) >>> 0);
    return true;
  }
}
registerProcessor("rpcs3-shared-ring-processor", Rpcs3SharedRingProcessor);
`;

export async function attachWebAudioOutput({ module, memory }) {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== "function" || typeof module?._rpcs3_web_audio_ring_address !== "function") {
    return null;
  }
  const ringByteOffset = module._rpcs3_web_audio_ring_address() >>> 0;
  if (!ringByteOffset) return null;

  const sharedMemory = memory ?? module.wasmMemory;
  const ctx = new AudioCtx({ sampleRate: 48000, latencyHint: "interactive" });
  const blob = new Blob([WORKLET_PROCESSOR_SOURCE], { type: "application/javascript" });
  const workletUrl = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const node = new AudioWorkletNode(ctx, "rpcs3-shared-ring-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      memoryBuffer: sharedMemory.buffer,
      ringByteOffset,
    },
  });
  node.connect(ctx.destination);

  return {
    context: ctx,
    node,
    resume: () => (ctx.state === "suspended" ? ctx.resume() : Promise.resolve()),
    close: () => {
      node.disconnect();
      return ctx.close();
    },
  };
}
