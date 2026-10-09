import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Bundles that import externalized packages must sit below the repo to resolve
 * node_modules, but not inside node_modules: Node's coverage skips that tree,
 * so the bundled src files would never reach the lcov report.
 */
export function makeBundleDirectory(prefix) {
	const parent = join(root, "test-results", "bundles");
	mkdirSync(parent, { recursive: true });
	return mkdtempSync(join(parent, prefix));
}
