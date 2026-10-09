import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The README screenshots, taken against the same isolated, seeded e2e server, so only demo data appears.
export default defineConfig({
	...base,
	testDir: "./scripts/screenshots",
	testMatch: /.*\.capture\.ts$/,
	outputDir: "test-results/screenshots",
	retries: 0,
	reporter: [["list"]],
});
