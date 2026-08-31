export type CheckState = "passed" | "failed" | "unsupported";

export type CheckResult = {
  state: CheckState;
  detail: string;
};

export type GpuLimits = {
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
  maxTextureDimension2D?: number;
  maxComputeWorkgroupStorageSize?: number;
  maxComputeInvocationsPerWorkgroup?: number;
};

export type WorkerProbeResult = {
  worker: CheckResult;
  dynamicWasm: CheckResult;
  sharedWasmMemory: CheckResult;
  opfs: CheckResult;
  webGpu: CheckResult;
  offscreenWebGpu: CheckResult;
  guestHomebrew: CheckResult;
  guestFrame?: GuestFrameResult;
  gpuFeatures: string[];
  gpuLimits: GpuLimits;
  errors: string[];
};

export type GuestFrameResult = {
  fixture: string;
  instructions: number;
  hleCalls: number;
  flips: number;
  commandWords: number;
  vertices: number;
  primitive: number;
  width: number;
  height: number;
};

export type GameStatus = {
  state: "idle" | "loading" | "running" | "failed" | "stopped";
  detail?: string;
  flips?: number;
  instructions?: number;
  hleCalls?: number;
  commandWords?: number;
  draws?: number;
  vertices?: number;
  format?: string;
  adapter?: string;
  frameHash?: number;
  changedPixels?: number;
  clearPixels?: number;
  expectedSamples?: number;
  matchedSamples?: number;
  activeCenterX?: number;
  activeCenterY?: number;
};

export type CapabilityReport = {
  schemaVersion: 1;
  runId: string;
  capturedAt: string;
  userAgent: string;
  hardwareConcurrency: number;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webAssembly: boolean;
  memory64: boolean;
  mainThreadWebGpu: boolean;
  offscreenCanvas: boolean;
  worker: WorkerProbeResult;
  coreProbe?: CoreProbeResult;
};

export type CoreProbeResult = {
  loaded: boolean;
  abiVersion?: number;
  memoryTestMask?: number;
  mappedPages?: number;
  residentPages?: number;
  ppuTestMask?: number;
  ppuInstructions?: number;
  ppuResult?: number;
  ppuLoadedResult?: number;
  ppuSupportedOpcodes?: number;
  elfProbe?: ElfProbeResult;
  detail: string;
};

export type ElfProbeResult = {
  loaded: boolean;
  testMask?: number;
  segments?: number;
  entry?: number;
  instructions?: number;
  stopReason?: number;
  pc?: number;
  lastOpcode?: number;
  target?: number;
  hleCalls?: number;
  hleNid?: number;
  syscalls?: number;
  lastSyscall?: number;
  detail: string;
};

export type Rpcs3WebApi = {
  schemaVersion: 1;
  status: "idle" | "probing" | "passed" | "failed";
  capabilities: () => CapabilityReport | undefined;
  runSmokeTest: () => Promise<CapabilityReport>;
  exportEvidence: () => CapabilityReport | undefined;
  startTetris: () => Promise<GameStatus>;
  stopTetris: () => void;
  gameStatus: () => GameStatus;
};

declare global {
  interface Window {
    __rpcs3Web: Rpcs3WebApi;
    coi?: Record<string, unknown>;
  }
}
