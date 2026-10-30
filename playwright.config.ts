import { defineConfig, devices } from "@playwright/test";
import {
	BASE_URL,
	E2E_PERSIST_DIR,
	E2E_PORT,
	E2E_TELEMETRY_URL,
	E2E_VITE_CACHE_DIR,
	FAKE_ABUSE_CH_PORT,
	FAKE_CLOUDFLARE_PORT,
	FAKE_R2_S3_PORT,
	STORAGE_STATE,
} from "./e2e/support/constants";

export default defineConfig({
	testDir: "./e2e",
	outputDir: "test-results/playwright",
	testMatch: /.*\.spec\.ts$/,
	// Every spec shares one D1 database, so run them one at a time. CI still
	// splits the suite (scripts/quality/e2e-shard.mjs): each shard has its own
	// server and database, and a file is one unit unless it opts into
	// `mode: "parallel"`.
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
			// Lets specs point the agent provider at the fake model on 127.0.0.1 (e2e/support/fake-model.ts).
			AI_ALLOW_INSECURE_LOOPBACK: "1",
			// Summaries time out after 5 s instead of 60 s, so e2e/59-thread-summaries.spec.ts can show the timeout message.
			AI_TEST_TIMEOUT_MS: "5000",
			// Lets the remote image proxy fetch the in-spec image server on 127.0.0.1 (e2e/42-remote-images.spec.ts).
			REMOTE_IMAGES_ALLOW_LOOPBACK: "1",
			// Lets specs add the fake S3 store on http://localhost (e2e/48-storage-s3.spec.ts).
			STORAGE_ALLOW_INSECURE_ENDPOINT: "1",
			// Lets specs import from the fake IMAP server on 127.0.0.1 in plain text (tests/support/fake-imap.mjs).
			EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: "1",
			// Sends both abuse.ch APIs to the fake on 127.0.0.1 (e2e/support/fake-abuse-ch.ts); nothing reaches abuse.ch.
			ABUSE_CH_TEST_ORIGIN: `http://127.0.0.1:${FAKE_ABUSE_CH_PORT}`,
			// Sends the automatic R2 setup's Cloudflare API calls and its S3 endpoint to fakes the storage spec starts
			// (e2e/93-storage-r2-auto-setup.spec.ts); nothing reaches Cloudflare.
			CLOUDFLARE_API_TEST_ORIGIN: `http://127.0.0.1:${FAKE_CLOUDFLARE_PORT}`,
			R2_S3_TEST_ENDPOINT: `http://localhost:${FAKE_R2_S3_PORT}`,
			// Lets specs inject a database size with X-Kite-Test-Database-Size (e2e/60-database-size.spec.ts).
			DATABASE_SIZE_TEST_HEADER: "1",
			// A usable https address (so the usage statistics notice can be tested) where nothing listens: no e2e run
			// can post statistics to the real collector, and no spec runs the 02:00 cron anyway.
			KITE_TELEMETRY_URL: E2E_TELEMETRY_URL,
			// Storage credentials are only ever saved encrypted, so the storage spec needs a key; invented, e2e only.
			APP_ENCRYPTION_KEY: "e2e-only-invented-encryption-key-not-a-secret-0123456789",
		},
		// A reused server keeps whatever state earlier runs left behind; opt in only while iterating.
		reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
		timeout: 240_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
