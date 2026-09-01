import fs from "node:fs";
import { PNG } from "pngjs";

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("usage: node scripts/compare-native-webgpu-frame.mjs <native.png> <browser.png|browser-result.json> [--max-rmse <value>] [--min-close-pixels <fraction>]\n");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();
const nativePath = args.shift();
const browserPath = args.shift();
let maxRmse;
let minClosePixels;
while (args.length) {
  const option = args.shift();
  const value = Number(args.shift());
  if (!Number.isFinite(value)) usage(`missing numeric value for ${option}`);
  if (option === "--max-rmse") maxRmse = value;
  else if (option === "--min-close-pixels") minClosePixels = value;
  else usage(`unknown option ${option}`);
}

const native = PNG.sync.read(fs.readFileSync(nativePath));
const browser = browserPath.toLowerCase().endsWith(".png")
  ? PNG.sync.read(fs.readFileSync(browserPath))
  : (() => {
      const browserDocument = JSON.parse(fs.readFileSync(browserPath, "utf8"));
      const result = browserDocument.gpu ?? browserDocument;
      if (!result.rgbaBase64) usage("browser result does not contain gpu.rgbaBase64; run with captureRgba: true");
      return {
        ...result,
        data: Buffer.from(result.rgbaBase64, "base64"),
      };
    })();
if (native.width !== browser.width || native.height !== browser.height) {
  usage(`frame dimensions differ: native=${native.width}x${native.height}, browser=${browser.width}x${browser.height}`);
}

const web = browser.data;
const expectedBytes = native.width * native.height * 4;
if (web.length !== expectedBytes) usage(`browser RGBA has ${web.length} bytes; expected ${expectedBytes}`);

let squaredError = 0;
let absoluteError = 0;
let maxChannelError = 0;
let closePixels = 0;
let exactPixels = 0;
const channelAbsoluteError = [0, 0, 0, 0];
const histogram = Array(256).fill(0);
for (let offset = 0; offset < expectedBytes; offset += 4) {
  let pixelMaxError = 0;
  for (let channel = 0; channel < 4; channel += 1) {
    const error = Math.abs(native.data[offset + channel] - web[offset + channel]);
    channelAbsoluteError[channel] += error;
    // RPCS3's desktop screenshot/compositor forces alpha to 255, while the raw
    // WebGPU render target preserves the RSX clear alpha. Compare displayed RGB
    // and report alpha separately instead of treating that representation
    // difference as a visible rendering error.
    if (channel < 3) {
      absoluteError += error;
      squaredError += error * error;
      maxChannelError = Math.max(maxChannelError, error);
      pixelMaxError = Math.max(pixelMaxError, error);
    }
  }
  histogram[pixelMaxError] += 1;
  exactPixels += pixelMaxError === 0 ? 1 : 0;
  closePixels += pixelMaxError <= 8 ? 1 : 0;
}

const pixels = native.width * native.height;
const channels = pixels * 3;
const rmse = Math.sqrt(squaredError / channels);
const mae = absoluteError / channels;
const percentile = (fraction) => {
  const target = Math.ceil(pixels * fraction);
  let count = 0;
  for (let error = 0; error < histogram.length; error += 1) {
    count += histogram[error];
    if (count >= target) return error;
  }
  return 255;
};
const report = {
  dimensions: { width: native.width, height: native.height },
  browserFrameHash: browser.frameHash,
  rmse,
  mae,
  psnr: rmse === 0 ? null : 20 * Math.log10(255 / rmse),
  maxChannelError,
  meanAbsoluteErrorByChannel: Object.fromEntries(["r", "g", "b", "a"].map((name, channel) => [name, channelAbsoluteError[channel] / pixels])),
  exactPixelFraction: exactPixels / pixels,
  closePixelFraction: closePixels / pixels,
  pixelMaxErrorPercentiles: { p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), p99: percentile(0.99) },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if ((maxRmse !== undefined && rmse > maxRmse) || (minClosePixels !== undefined && closePixels / pixels < minClosePixels)) {
  process.exitCode = 1;
}
