// Keep ANGLE and Chromium's Vulkan device shared. Without VulkanFromANGLE this host renders
// correctly but WebGPU canvas -> ImageBitmap -> 2D readback returns transparent pixels.
// probe-canvas-readback.mjs independently checks snapshots against GPU-buffer readback.
export function hardwareChromeArgs(mode = process.env.RPCS3_CHROME_GPU || "shared-vulkan") {
  const backends = {
    "shared-vulkan": ["--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE", "--use-angle=vulkan"],
    "legacy-vulkan": ["--enable-features=Vulkan", "--use-angle=vulkan"],
    "vulkan-gl": ["--enable-features=Vulkan", "--use-angle=gl"],
  };
  if (!backends[mode]) throw new Error(`unknown Chrome GPU configuration: ${mode}`);
  return ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--ignore-gpu-blocklist", ...backends[mode]];
}
