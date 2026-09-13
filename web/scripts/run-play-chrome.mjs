// Compatibility entry point. The shared runner owns launch, profiling, capture, and shutdown.
// RPCS3_BOOT=/opfs/games/title.iso node scripts/run-play-chrome.mjs [seconds]
const seconds = Number(process.argv[2] || 120);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("seconds must be positive");
process.env.RPCS3_DURATION_MS ??= String(seconds * 1000);
process.env.RPCS3_PROFILE ??= "1";
process.argv = [process.argv[0], process.argv[1], process.env.RPCS3_BOOT || "fixtures/gs_gcm_tetris.elf",
  process.env.RPCS3_OUTPUT || "play-chrome-evidence"];
await import("./run-performance.mjs");
