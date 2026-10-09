import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_PERSIST_DIR, E2E_PORT, E2E_VITE_CACHE_DIR, STORAGE_STATE } from "./e2e/support/constants";

export default defineConfig({
	testDir: "./e2e",
	outputDir: "test-results/playwright",
	testMatch: /.*\.spec\.ts$/,
	// Every spec shares one D1 database, so run them one at a time.
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	forbidOnly: !!process.env.CI,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	// The JSON file sits outside outputDir, which Playwright empties at the start of a run.
	reporter: process.env.CI
		? [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/playwright-results.json" }]]
		: [["list"]],
	globalSetup: "./e2e/global-setup.ts",
	use: {
		baseURL: BASE_URL,
		storageState: STORAGE_STATE,
		viewport: { width: 1400, height: 900 },
		timezoneId: "UTC",
		locale: "en-US",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		actionTimeout: 15_000,
		navigationTimeout: 60_000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } } }],
	webServer: {
		command: `node e2e/prepare-state.mjs && npx vite dev --port ${E2E_PORT} --strictPort`,
		url: `${BASE_URL}/login`,
		env: {
			KITE_PERSIST_DIR: E2E_PERSIST_DIR,
			KITE_VITE_CACHE_DIR: E2E_VITE_CACHE_DIR,
			// Lets specs point the alert webhook at an in-spec http receiver on 127.0.0.1.
			ALERT_WEBHOOK_ALLOW_INSECURE: "1",
		},
		// A reused server keeps whatever state earlier runs left behind; opt in only while iterating.
		reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
		timeout: 240_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
