// Compares a native RPCS3 frame with a browser frame (a PNG or a runtime
// result JSON carrying gpu.rgbaBase64): the kit's compare-frames, RGB RMSE
// with alpha reported separately and "close" pixels within 8 per channel.
//
//   node scripts/compare-native-webgpu-frame.mjs <native.png> <browser.png|browser-result.json> [--max-rmse <value>] [--min-close-pixels <fraction>]
import { runKitBin } from "./kit-bin.mjs";

runKitBin("@appmana-public/web-emulator-harness", "compare-frames", process.argv.slice(2));
