import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The README screenshots, taken against the same isolated, seeded e2e server, so only demo data appears.
export default defineConfig({
	...base,
	testDir: "./scripts/screenshots",
	testMatch: /.*\.capture\.ts$/,
	outputDir: "test-results/screenshots",
	retries: 0,
	// Headless Chromium on Linux hints fonts by default, which snaps Manrope's advances at small sizes and
	// collapses word spaces ("Kitedesign"); browsers on people's machines do not. Without hinting the shots
	// match what Chrome on macOS shows. The capture also waits for document.fonts.ready before each shot.
	use: { ...base.use, launchOptions: { args: ["--font-render-hinting=none"] } },
	reporter: [["list"]],
});
