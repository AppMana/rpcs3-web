import { existsSync } from "node:fs";

const NVIDIA_VULKAN_ICD = "/usr/share/vulkan/icd.d/nvidia_icd.json";
if (!process.env.VK_ICD_FILENAMES && existsSync(NVIDIA_VULKAN_ICD)) {
  process.env.VK_ICD_FILENAMES = NVIDIA_VULKAN_ICD;
}

export function hardwareChromeEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    ...(existsSync(NVIDIA_VULKAN_ICD) ? { VK_ICD_FILENAMES: baseEnv.VK_ICD_FILENAMES || NVIDIA_VULKAN_ICD } : {}),
  };
}

// Keep ANGLE and Chromium's Vulkan device shared. Without VulkanFromANGLE this host renders
// correctly but WebGPU canvas -> ImageBitmap -> 2D readback returns transparent pixels.
// probe-canvas-readback.mjs independently checks snapshots against GPU-buffer readback.
// In headless mode on Linux, --use-gl=angle and --disable-vulkan-surface bind ANGLE/Dawn
// directly to the physical Vulkan ICD without requiring an X11/Wayland display surface.
export function hardwareChromeArgs(mode = process.env.RPCS3_CHROME_GPU || "shared-vulkan", { headless = process.env.RPCS3_HEADED !== "1" } = {}) {
  const surfaceFlags = headless ? ["--disable-vulkan-surface"] : [];
  const backends = {
    "shared-vulkan": ["--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE", ...surfaceFlags],
    "headless-vulkan": ["--headless=new", "--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE", "--disable-vulkan-surface"],
    "legacy-vulkan": ["--use-gl=angle", "--enable-features=Vulkan", "--use-angle=vulkan", ...surfaceFlags],
    "vulkan-gl": ["--enable-features=Vulkan", "--use-angle=gl"],
  };
  if (!backends[mode]) throw new Error(`unknown Chrome GPU configuration: ${mode}`);
  return ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--ignore-gpu-blocklist", ...backends[mode]];
}
