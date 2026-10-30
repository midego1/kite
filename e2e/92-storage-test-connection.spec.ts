import { expect, test, type Page } from "@playwright/test";
import { startFakeS3 } from "../tests/support/fake-s3.mjs";
import { BASE_URL, STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

const BUCKET = "kite-e2e-test-connection";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const stepOf = (page: Page, id: string) => page.getByRole("dialog").locator(`[data-step="${id}"]`);

test("Test connection checks a store without saving it, with a fix under each failure and the CORS rule to copy", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const fake = await startFakeS3({ buckets: [BUCKET] });
	const admin = await apiContext(STORAGE_STATE);
	const storeName = `E2E test ${uniqueToken("")}`;
	try {
		await page.goto("/storage");
		await page.getByRole("button", { name: "Add store" }).click();
		const dialog = page.getByRole("dialog", { name: "Add store" });
		await expect(dialog.getByRole("group", { name: "Where" })).toBeVisible();
		await expect(dialog.getByRole("group", { name: "Credentials" })).toBeVisible();
		await expect(dialog.getByRole("group", { name: "Direct uploads" })).toBeVisible();

		// Field-level validation runs before any request.
		const tests: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/api/admin/storage/test")) tests.push(request.postData() ?? "");
		});
		await dialog.getByRole("button", { name: "Test connection" }).click();
		await expect(dialog.getByText("Enter a name")).toBeVisible();
		await expect(dialog.getByText("Choose the bucket's region")).toBeVisible();
		await expect(dialog.getByLabel("Name")).toBeFocused();
		expect(tests).toHaveLength(0);

		await dialog.getByLabel("Name").fill(storeName);
		await chooseOption(dialog.getByLabel("Provider"), "minio");
		await dialog.getByLabel("Endpoint").fill(fake.url);
		await dialog.getByLabel("Bucket").fill(BUCKET);
		await dialog.getByLabel("Region").fill(fake.region);
		await dialog.getByLabel("Access key ID").fill(fake.accessKeyId);
		const secret = dialog.getByLabel("Secret access key");
		await secret.fill("not-the-right-secret");
		await expect(secret).toHaveAttribute("type", "password");
		await dialog.getByRole("button", { name: "Show secret" }).click();
		await expect(secret).toHaveAttribute("type", "text");
		await dialog.getByRole("button", { name: "Hide secret" }).click();
		await expect(secret).toHaveAttribute("type", "password");

		// A wrong secret fails on the credentials step, with the fix.
		await dialog.getByRole("button", { name: "Test connection" }).click();
		await expect(dialog.locator("[data-test-result]")).toHaveAttribute("data-test-result", "error");
		await expect(stepOf(page, "endpoint")).toHaveAttribute("data-status", "ok");
		await expect(stepOf(page, "credentials")).toHaveAttribute("data-status", "failed");
		await expect(stepOf(page, "credentials")).toContainText("Check the secret access key");
		await expect(stepOf(page, "write")).toHaveAttribute("data-status", "skipped");

		// The right one passes every store check; the bucket has no CORS rule, so the rule is offered to copy.
		await secret.fill(fake.secretAccessKey);
		await expect(dialog.locator("[data-step]")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Test connection" }).click();
		await expect(dialog.getByRole("status")).toContainText("browsers cannot upload directly yet");
		for (const id of ["endpoint", "credentials", "bucket", "write", "read", "list", "delete"])
			await expect(stepOf(page, id)).toHaveAttribute("data-status", "ok");
		await expect(stepOf(page, "cors_preflight")).toHaveAttribute("data-status", "failed");
		const rule = dialog.locator("[data-cors-rule]");
		await expect(rule).toContainText(`"${BASE_URL}"`);
		await rule.getByRole("button", { name: "Copy CORS rule" }).click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toContain(`"AllowedOrigins": [\n      "${BASE_URL}"`);

		// Nothing was saved, nothing was left in the bucket, and the answers carried no secret.
		expect(tests.every((body) => body.includes("not-the-right-secret") || body.includes(fake.secretAccessKey))).toBe(
			true,
		);
		const overview = await (await admin.get("/api/admin/storage")).json();
		expect(overview.stores.some((store: { name: string }) => store.name === storeName)).toBe(false);
		expect(fake.buckets.get(BUCKET)!.objects.size).toBe(0);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.locator("[data-store]").filter({ hasText: storeName })).toHaveCount(0);
	} finally {
		await admin.dispose();
		await fake.close();
	}
});

test("presets build the endpoint: R2 from the account ID, Amazon S3 from the region", async ({ page }) => {
	const sent: Record<string, unknown>[] = [];
	await page.route("**/api/admin/storage/test", async (route) => {
		sent.push(route.request().postDataJSON());
		await route.fulfill({
			json: {
				report: {
					ok: true,
					cors: true,
					steps: [{ id: "endpoint", label: "Endpoint is reachable", status: "ok" }],
				},
			},
		});
	});
	await page.goto("/storage");

	// The direct-uploads dialog is a guided flow with the token link, and asks only for the account ID and keys.
	await page.locator('[data-store="default"]').getByRole("button", { name: "Enable direct uploads" }).click();
	const direct = page.getByRole("dialog", { name: "Enable direct uploads" });
	await expect(direct).toContainText("faster, and less load on the Worker");
	for (const step of ["Create an R2 API token", "Paste the keys and your account ID", "Test the connection", "Save"])
		await expect(direct.getByRole("group", { name: new RegExp(step) })).toBeVisible();
	await expect(direct.getByLabel("Endpoint")).toHaveCount(0);
	await expect(direct.getByLabel("Provider")).toHaveCount(0);
	await direct.getByLabel("Cloudflare account ID").fill(`https://${ACCOUNT}.r2.cloudflarestorage.com/kite-raw`);
	await direct.getByLabel("Access key ID").fill("fedcba9876543210fedcba987654321");
	await expect(direct.getByLabel("Cloudflare account ID")).toHaveValue(ACCOUNT);
	await expect(direct.locator("[data-endpoint-preview]")).toContainText(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
	await expect(direct.getByRole("link", { name: /Open R2 API tokens/ })).toHaveAttribute(
		"href",
		`https://dash.cloudflare.com/${ACCOUNT}/r2/api-tokens`,
	);
	// R2 keys have a fixed shape; a short one is caught under its field before any request.
	await direct.getByLabel("Secret access key").fill("too-short");
	await direct.getByRole("button", { name: "Test connection" }).click();
	await expect(direct.getByText("R2 access key IDs are 32 characters; this one has 31")).toBeVisible();
	await expect(
		direct.getByText(/R2 secret access keys use only digits|R2 secret access keys are 64 characters/),
	).toBeVisible();
	expect(sent).toHaveLength(0);
	await direct.getByLabel("Access key ID").fill("fedcba9876543210fedcba9876543210");
	await direct.getByLabel("Secret access key").fill("a".repeat(64));
	await direct.getByRole("button", { name: "Test connection" }).click();
	await expect(direct.getByRole("status")).toContainText("Connection works");
	expect(sent.at(-1)).toMatchObject({
		provider: "r2",
		endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
		region: "auto",
		addressing: "path",
		bucket: "kite-raw",
		sameAsBinding: true,
	});
	await direct.getByRole("button", { name: "Cancel" }).click();

	// Amazon S3 picks the endpoint from the region list.
	await page.getByRole("button", { name: "Add store" }).click();
	const add = page.getByRole("dialog", { name: "Add store" });
	await add.getByLabel("Name").fill("Preset check");
	await chooseOption(add.getByLabel("Region"), "eu-central-1");
	await add.getByLabel("Bucket").fill("kite-files");
	await expect(add.locator("[data-endpoint-preview]")).toContainText("https://s3.eu-central-1.amazonaws.com");
	await add.getByLabel("Access key ID").fill("AKIAEXAMPLE");
	await add.getByLabel("Secret access key").fill("aws-secret-value");
	await add.getByRole("button", { name: "Test connection" }).click();
	await expect(add.getByRole("status")).toContainText("Connection works");
	expect(sent.at(-1)).toMatchObject({
		provider: "aws",
		endpoint: "https://s3.eu-central-1.amazonaws.com",
		region: "eu-central-1",
		addressing: "virtual",
	});
	await add.getByRole("button", { name: "Cancel" }).click();
	const overview = await page.request.get("/api/admin/storage").then((response) => response.json());
	expect(overview.stores.some((store: { name: string }) => store.name === "Preset check")).toBe(false);
});
