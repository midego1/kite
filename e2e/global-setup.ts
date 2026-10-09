import { chromium, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ADMIN, BASE_URL, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn } from "./support/helpers";

// Visiting each area once lets Vite discover and pre-bundle its dependencies
// here; otherwise a late "optimized dependencies changed" reload lands mid-test.
const WARM_UP_ROUTES = [
	"/inbox",
	"/sent",
	"/drafts",
	"/trash",
	"/settings/inbox",
	"/accounts",
	"/mailboxes",
	"/backups",
	"/settings/api-keys",
	"/alerts",
];

export default async function globalSetup(config: FullConfig) {
	const anonymous = await apiContext();
	const seeded = await anonymous.post("/api/seed", { timeout: 180_000 });
	if (!seeded.ok()) throw new Error(`Seeding failed: ${seeded.status()} ${await seeded.text()}`);
	await anonymous.dispose();

	const admin = await apiSignIn(ADMIN.email, ADMIN.password);
	mkdirSync(dirname(STORAGE_STATE), { recursive: true });
	await admin.storageState({ path: STORAGE_STATE });
	await admin.dispose();

	const browser = await chromium.launch();
	const context = await browser.newContext({
		baseURL: config.projects[0]?.use.baseURL ?? BASE_URL,
		storageState: STORAGE_STATE,
	});
	const page = await context.newPage();
	for (const route of WARM_UP_ROUTES) {
		await page.goto(route, { timeout: 180_000 });
		await page.waitForLoadState("networkidle", { timeout: 180_000 });
	}
	await page.goto("/inbox");
	await page
		.getByRole("main")
		.getByText("Cannot access workspace", { exact: true })
		.first()
		.click({ timeout: 180_000 });
	await page.waitForURL(/\/msg_/, { timeout: 180_000 });
	await page.waitForLoadState("networkidle", { timeout: 180_000 });
	await page.getByRole("button", { name: "Compose" }).click();
	await page.getByRole("button", { name: "Close composer" }).waitFor({ timeout: 180_000 });
	await page.waitForLoadState("networkidle", { timeout: 180_000 });
	await browser.close();
}
