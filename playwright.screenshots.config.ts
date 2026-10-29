import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The README screenshots, taken against the same isolated, seeded e2e server, so only demo data appears.
export default defineConfig({
	...base,
	testDir: "./scripts/screenshots",
	testMatch: /.*\.capture\.ts$/,
	outputDir: "test-results/screenshots",
	// A shot taken while the app's session check failed (slow machine) is refused, and the test starts over.
	retries: 3,
	webServer:
		base.webServer && !Array.isArray(base.webServer) ? { ...base.webServer, timeout: 900_000 } : base.webServer,
	// A capture waits for the app instead of asserting on its speed, so a busy machine only makes it slower.
	timeout: 600_000,
	expect: { timeout: 120_000 },
	// Headless Chromium on Linux hints fonts by default, which snaps Manrope's advances at small sizes and
	// collapses word spaces ("Kitedesign"); browsers on people's machines do not. Without hinting the shots
	// match what Chrome on macOS shows. The capture also waits for document.fonts.ready before each shot.
	use: {
		...base.use,
		actionTimeout: 120_000,
		navigationTimeout: 240_000,
		launchOptions: { args: ["--font-render-hinting=none"] },
	},
	reporter: [["list"]],
});
