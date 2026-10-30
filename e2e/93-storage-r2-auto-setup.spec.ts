import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
	corsRulesForFakeS3,
	FAKE_R2,
	FAKE_R2_SECRET,
	startFakeCloudflareR2,
} from "../tests/support/fake-cloudflare-r2.mjs";
import { startFakeS3 } from "../tests/support/fake-s3.mjs";
import { BASE_URL, FAKE_CLOUDFLARE_PORT, FAKE_R2_S3_PORT, STORAGE_STATE } from "./support/constants";
import { apiContext } from "./support/helpers";
import { chooseOption } from "./support/select";

const BUCKETS = ["kite-raw", "kite-media"];

type Fakes = Awaited<ReturnType<typeof startFakes>>;

/** The fake Cloudflare API and the fake R2 endpoint, on the ports the dev server's test origins name. */
async function startFakes() {
	const s3 = await startFakeS3({
		port: FAKE_R2_S3_PORT,
		buckets: BUCKETS,
		accessKeyId: FAKE_R2.tokenId,
		secretAccessKey: FAKE_R2_SECRET,
	});
	const cf = await startFakeCloudflareR2({
		port: FAKE_CLOUDFLARE_PORT,
		buckets: BUCKETS,
		onCreateBucket: (name: string) =>
			s3.buckets.set(name, { objects: new Map(), uploads: new Map(), cors: null, lifecycle: null }),
		onCors: (bucket: string, rules: unknown[]) => {
			const target = s3.buckets.get(bucket);
			if (target) target.cors = corsRulesForFakeS3(rules);
		},
	});
	return { s3, cf };
}

/** Every storage answer the page received, to prove none carries the token value or the derived secret. */
function recordStorageAnswers(page: Page): string[] {
	const answers: string[] = [];
	page.on("response", async (response) => {
		if (response.url().includes("/api/admin/storage")) answers.push(await response.text().catch(() => ""));
	});
	return answers;
}

/** Later specs share the database: no store, and the reminder back on. */
async function reset(admin: APIRequestContext) {
	const overview = await (await admin.get("/api/admin/storage")).json();
	for (const store of overview.stores ?? []) await admin.delete(`/api/admin/storage/stores/${store.id}`);
	await admin.post("/api/admin/storage/reminder", { data: { dismissed: false } });
}

async function withFakes(run: (fakes: Fakes, admin: APIRequestContext) => Promise<void>) {
	const fakes = await startFakes();
	const admin = await apiContext(STORAGE_STATE);
	try {
		await reset(admin);
		await run(fakes, admin);
	} finally {
		await reset(admin);
		await admin.dispose();
		await fakes.cf.close();
		await fakes.s3.close();
	}
}

test("Direct uploads are off until Set up automatically turns them on in one click", async ({ page }) => {
	test.setTimeout(90_000);
	await withFakes(async ({ cf }) => {
		const answers = recordStorageAnswers(page);
		await page.goto("/admin");
		await expect(
			page.getByRole("region", { name: "Needs attention" }).getByTestId("attention-direct-uploads"),
		).toContainText("Direct uploads are off: set up (2 min)");

		await page.goto("/storage");
		const reminder = page.locator("[data-direct-uploads-reminder]");
		await reminder.getByRole("button", { name: "Set up" }).click();
		const dialog = page.getByRole("dialog", { name: "Enable direct uploads" });
		const auto = dialog.getByRole("group", { name: "Set up automatically (recommended)" });
		await expect(auto).toContainText("Account API Tokens: Edit");
		await expect(auto).toContainText("remove it afterwards");
		await auto.getByRole("button", { name: "Set up automatically" }).click();
		await expect(auto.locator('[data-auto-setup="done"]')).toBeVisible({ timeout: 30_000 });
		await expect(auto.getByRole("status")).toContainText("Direct uploads are on");
		await expect(auto).toContainText("All 6 steps passed");
		await auto.getByRole("button", { name: "Done" }).click();
		await expect(dialog).toHaveCount(0);

		await expect(page.locator('[data-store="default"]')).toContainText("Browsers upload Drive files to it directly");
		await expect(reminder).toHaveCount(0);
		const [token] = cf.state.tokens as { policies: { resources: Record<string, string> }[] }[];
		expect(Object.keys(token.policies[0].resources)).toEqual([
			`com.cloudflare.edge.r2.bucket.${FAKE_R2.accountId}_default_kite-raw`,
		]);
		const cors = cf.state.cors.get("kite-raw") as { rules: { allowed: { origins: string[] } }[] };
		expect(cors.rules[0].allowed.origins).toContain(BASE_URL);
		for (const answer of answers) {
			expect(answer).not.toContain(FAKE_R2.tokenValue);
			expect(answer).not.toContain(FAKE_R2_SECRET);
		}
	});
});

test("a CF_TOKEN without the token permission is named, and the manual steps stay", async ({ page }) => {
	await withFakes(async ({ cf }, admin) => {
		cf.state.denied.add("createToken");
		await page.goto("/storage");
		await page.locator('[data-store="default"]').getByRole("button", { name: "Enable direct uploads" }).click();
		const dialog = page.getByRole("dialog", { name: "Enable direct uploads" });
		const auto = dialog.getByRole("group", { name: "Set up automatically (recommended)" });
		await auto.getByRole("button", { name: "Set up automatically" }).click();
		await expect(auto.getByRole("alert")).toContainText('"Account API Tokens: Edit"');
		await expect(auto.locator('[data-step="token"]')).toHaveAttribute("data-status", "failed");
		await expect(auto.locator('[data-step="checks"]')).toHaveAttribute("data-status", "skipped");
		await expect(auto).toContainText("Or follow the steps below");
		await expect(dialog.getByRole("group", { name: /Create an R2 API token/ })).toBeVisible();
		await dialog.getByRole("button", { name: "Cancel" }).click();
		const overview = await (await admin.get("/api/admin/storage")).json();
		expect(overview.stores).toEqual([]);
		await page.reload();
		await expect(page.locator("[data-direct-uploads-reminder]")).toContainText(
			'CF_TOKEN needs "Account API Tokens: Edit"',
		);
	});
});

test("Add store creates a new R2 bucket in one click, and a taken name offers the existing bucket", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await withFakes(async ({ cf }) => {
		await page.goto("/storage");
		await page.getByRole("button", { name: "Add store" }).click();
		const dialog = page.getByRole("dialog", { name: "Add store" });
		await chooseOption(dialog.getByLabel("Provider"), "r2");
		const oneClick = dialog.getByRole("group", { name: "Connect R2 in one click" });
		await expect(oneClick.getByLabel("New bucket name")).toHaveValue("kite-drive");
		await chooseOption(oneClick.getByLabel("For"), "backups");
		await expect(oneClick.getByLabel("New bucket name")).toHaveValue("kite-backups");
		await oneClick.getByLabel("New bucket name").fill("Kite_Backups");
		await expect(oneClick).toContainText("Use lowercase letters only");
		await expect(oneClick.getByRole("button", { name: "Create bucket and connect" })).toBeDisabled();
		await oneClick.getByLabel("New bucket name").fill("kite-backups");
		await chooseOption(oneClick.getByLabel("Location"), "weur");
		await oneClick.getByRole("button", { name: "Create bucket and connect" }).click();
		await expect(oneClick.locator('[data-auto-setup="done"]')).toBeVisible({ timeout: 30_000 });
		const created = (cf.state.requests as { operation: string; body: unknown }[]).find(
			(request) => request.operation === "createBucket",
		);
		expect(created?.body).toEqual({ name: "kite-backups", locationHint: "weur" });
		await oneClick.getByRole("button", { name: "Done" }).click();
		await expect(page.locator("[data-store]").filter({ hasText: "Cloudflare R2 kite-backups" })).toContainText(
			"Working",
		);

		await page.getByRole("button", { name: "Add store" }).click();
		await chooseOption(dialog.getByLabel("Provider"), "r2");
		await oneClick.getByLabel("New bucket name").fill("kite-media");
		await oneClick.getByRole("button", { name: "Create bucket and connect" }).click();
		await expect(oneClick.getByRole("alert")).toContainText("A bucket named kite-media already exists");
		await oneClick.getByRole("button", { name: "Use the existing kite-media" }).click();
		await expect(oneClick.locator('[data-auto-setup="done"]')).toBeVisible({ timeout: 30_000 });
		await oneClick.getByRole("radio", { name: "Use an existing bucket" }).click();
		const existing = oneClick.getByLabel("Existing bucket");
		await existing.click();
		await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["kite-raw", "kite-media", "kite-backups"]);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
	});
});

test("the reminder is an attention item on the Admin overview, and Dismiss hides it there and on Storage", async ({
	page,
}) => {
	await withFakes(async () => {
		await page.goto("/admin");
		const reminder = page.getByRole("region", { name: "Needs attention" }).getByTestId("attention-direct-uploads");
		await expect(reminder.getByRole("link", { name: "Set up" })).toHaveAttribute("href", "/storage?setup=direct");
		await reminder.getByRole("button", { name: "Dismiss" }).click();
		await expect(reminder).toHaveCount(0);
		await page.goto("/storage");
		await expect(page.getByRole("heading", { level: 1, name: "Storage" })).toBeVisible();
		await expect(page.locator("[data-direct-uploads-reminder]")).toHaveCount(0);
		await expect(
			page.locator('[data-store="default"]').getByRole("button", { name: "Enable direct uploads" }),
		).toBeVisible();
	});
});

test("a refused bucket lookup shows its reason instead of waiting forever", async ({ page }) => {
	await page.route("**/api/admin/storage/cloudflare", (route) =>
		route.fulfill({ status: 429, json: { error: "Too many bucket lookups; wait a minute and try again" } }),
	);
	await page.goto("/storage");
	await page.getByRole("button", { name: "Add store" }).click();
	const dialog = page.getByRole("dialog", { name: "Add store" });
	await chooseOption(dialog.getByLabel("Provider"), "r2");
	await expect(dialog.locator('[data-auto-setup="unavailable"]')).toContainText("Too many bucket lookups");
	await expect(dialog.getByText("Checking Cloudflare…")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await page.locator('[data-store="default"]').getByRole("button", { name: "Enable direct uploads" }).click();
	await expect(
		page.getByRole("dialog", { name: "Enable direct uploads" }).locator('[data-auto-setup="unavailable"]'),
	).toContainText("Too many bucket lookups");
});
