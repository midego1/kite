import { readFileSync } from "node:fs";

/** The release the app under test embeds (scripts/build-version.mjs). */
export const RELEASE_VERSION = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3200);
export const BASE_URL = `http://localhost:${E2E_PORT}`;
/** The fake abuse.ch (e2e/support/fake-abuse-ch.ts); the dev server sends both abuse.ch APIs here. */
export const FAKE_ABUSE_CH_PORT = Number(process.env.E2E_FAKE_ABUSE_CH_PORT ?? E2E_PORT + 97);
/** The fake Cloudflare API for the automatic R2 setup (tests/support/fake-cloudflare-r2.mjs). */
export const FAKE_CLOUDFLARE_PORT = Number(process.env.E2E_FAKE_CLOUDFLARE_PORT ?? E2E_PORT + 96);
/** The fake S3 that stands in for `<account>.r2.cloudflarestorage.com` in the same setup. */
export const FAKE_R2_S3_PORT = Number(process.env.E2E_FAKE_R2_S3_PORT ?? E2E_PORT + 95);
export const E2E_PERSIST_DIR = ".wrangler/e2e-state";
export const E2E_VITE_CACHE_DIR = ".wrangler/e2e-vite-cache";
/** The e2e server's KITE_TELEMETRY_URL: https on the loopback discard port, where nothing answers. */
export const E2E_TELEMETRY_URL = "https://127.0.0.1:9/v1/heartbeat";
export const STORAGE_STATE = "test-results/.auth/admin.json";

export const ADMIN = { email: "admin@example.com", password: "demo-password-change-me", name: "Demo User" };
export const SUPPORT_ADDRESS = "support@example.com";
export const DOMAIN = "example.com";

/**
 * The e2e server's APP_ENCRYPTION_KEY: invented, e2e only. Storage credentials are only ever saved encrypted, and the
 * send-as spec recovers a mailed verification code from its stored HMAC with it (e2e/support/send-as.ts).
 */
export const E2E_APP_ENCRYPTION_KEY = "e2e-only-invented-encryption-key-not-a-secret-0123456789";

/** Matches the "Kite was updated" check, which names the tab's own build in its query string. */
export const VERSION_ROUTE = (url: URL) => url.pathname === "/api/version";
