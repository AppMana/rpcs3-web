// Copies a host file or directory into the origin-private storage of RPCS3's
// persistent Chrome profile (the kit's import-host-opfs).
//
//   node scripts/import-host-opfs.mjs <host-file-or-directory> <opfs-relative-path>
//   RPCS3_WEB_URL  RPCS3_CHROME_PROFILE  RPCS3_CHROME_PATH  RPCS3_HEADED=1
import { rpcs3ProfileArguments, runKitBin } from "./kit-bin.mjs";

if (!process.argv[2] || !process.argv[3]) {
  process.stderr.write("usage: yarn storage:import-host <host-file-or-directory> <opfs-relative-path>\n");
  process.exit(2);
}
runKitBin("@appmana-public/disc-images", "import-host-opfs", [...process.argv.slice(2), ...rpcs3ProfileArguments()]);
