import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationBundle } from "./migration-bundle-utils.mjs";

const root = new URL("../", import.meta.url);
const migrations = readMigrationBundle(fileURLToPath(new URL("drizzle/migrations/", root)));

writeFileSync(new URL("src/lib/migrations/bundle.json", root), `${JSON.stringify({ migrations }, null, 2)}\n`);
