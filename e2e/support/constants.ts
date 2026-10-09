import { readFileSync } from "node:fs";

/** The release the app under test embeds (scripts/build-version.mjs). */
export const RELEASE_VERSION = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3200);
export const BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_PERSIST_DIR = ".wrangler/e2e-state";
export const E2E_VITE_CACHE_DIR = ".wrangler/e2e-vite-cache";
export const STORAGE_STATE = "test-results/.auth/admin.json";

export const ADMIN = { email: "admin@example.com", password: "demo-password-change-me", name: "Demo User" };
export const SUPPORT_ADDRESS = "support@example.com";
export const DOMAIN = "example.com";
