// Lists the origin-private storage of RPCS3's persistent Chrome profile and
// optionally reads one file out of it (the kit's inspect-opfs).
//
//   node scripts/inspect-opfs.mjs [prefix]
//   RPCS3_OPFS_READ=<storage-path>  RPCS3_OPFS_EXPORT=<host-file>
//   RPCS3_WEB_URL  RPCS3_CHROME_PROFILE  RPCS3_CHROME_PATH  RPCS3_HEADED=1
import { rpcs3ProfileArguments, runKitBin } from "./kit-bin.mjs";

const env = process.env;
runKitBin("@appmana-public/disc-images", "inspect-opfs", [
  ...process.argv.slice(2),
  ...(env.RPCS3_OPFS_READ ? ["--read", env.RPCS3_OPFS_READ] : []),
  ...(env.RPCS3_OPFS_EXPORT ? ["--export", env.RPCS3_OPFS_EXPORT] : []),
  ...rpcs3ProfileArguments(env),
]);
