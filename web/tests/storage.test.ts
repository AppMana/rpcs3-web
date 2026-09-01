import { describe, expect, it } from "vitest";
// The browser runtime is intentionally plain ESM so it can be used directly by Safari.
// @ts-expect-error No declaration file is emitted for public runtime modules.
import { gameBootPath, normalizeRelativePath, opfsPath } from "../public/rpcs3-storage.mjs";

describe("RPCS3 OPFS paths", () => {
  it("normalizes imported directory paths without permitting traversal", () => {
    expect(normalizeRelativePath("./LittleBigPlanet\\PS3_GAME/USRDIR/EBOOT.BIN"))
      .toBe("LittleBigPlanet/PS3_GAME/USRDIR/EBOOT.BIN");
    expect(() => normalizeRelativePath("games/../../escape")).toThrow(/escapes/);
    expect(() => normalizeRelativePath("/absolute")).toThrow(/relative/);
  });

  it("selects bootable disc roots and ISOs", () => {
    expect(gameBootPath(["games/LBP/PS3_GAME/USRDIR/EBOOT.BIN"]))
      .toBe("/opfs/games/LBP");
    expect(gameBootPath(["games/LittleBigPlanet.iso"]))
      .toBe("/opfs/games/LittleBigPlanet.iso");
    expect(opfsPath("firmware/PS3UPDAT.PUP")).toBe("/opfs/firmware/PS3UPDAT.PUP");
  });
});
