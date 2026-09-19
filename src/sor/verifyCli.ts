// CLI for `npm run sor:verify` — replay-verify the SOR hash chain in SQLite.

import { closePool, getPool } from "../db/pool.ts";
import { runSorVerify } from "./verify.ts";

const code = await runSorVerify(getPool());
await closePool();
process.exit(code);