import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startFakeS3 } from "../tests/support/fake-s3.mjs";
import { okJson } from "./support/auto-read";
import { BASE_URL, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { listItems, sql } from "./support/drive";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

const BUCKET = "kite-e2e";
const LARGE_BYTES = 9 * 1024 * 1024;

const driveRow = (page: Page) => page.locator('[data-class="drive"]');

async function switchDrive(page: Page, storeName: string, { copy }: { copy: boolean }) {
	await chooseOption(driveRow(page).getByLabel("Store for Drive"), { label: storeName });
	await driveRow(page).getByRole("button", { name: "Switch" }).click();
	const dialog = page.getByRole("dialog", { name: `Store Drive in ${storeName}?` });
	await expect(dialog).toContainText("Preview deployments share this setting");
	await expect(dialog).toContainText("Providers may charge");
	const checkbox = dialog.getByRole("checkbox", { name: /Copy existing drive/ });
	await expect(checkbox).toBeChecked();
	if (!copy) await checkbox.uncheck();
	await dialog.getByRole("button", { name: "Switch" }).click();
	await expect(dialog).toHaveCount(0);
}

/** Later specs share the database: nothing may stay routed to a store that is about to stop. */
async function resetStorage(admin: APIRequestContext) {
	const left = await admin.get("/api/admin/storage").then((response) => response.json());
	if (left.routes?.some((route: { storeId: string }) => route.storeId !== "default") || left.stores?.length)
		sql(
			"DELETE FROM storage_routes; UPDATE drive_items SET store_id = 'default' WHERE store_id <> 'default'; DELETE FROM storage_migrations; DELETE FROM storage_stores;",
		);
}

async function waitForMigration(admin: APIRequestContext, id: string, done: (migration: MigrationState) => boolean) {
	let last: MigrationState | undefined;
	await expect
		.poll(
			async () => {
				last = (await okJson<{ migration: MigrationState }>(await admin.get(`/api/admin/storage/migrations/${id}`)))
					.migration;
				return done(last);
			},
			{ timeout: 90_000, intervals: [500, 1000, 2000] },
		)
		.toBe(true);
	return last!;
}

type MigrationState = { status: string; phase: string; objectsDone: number; errors: number };

test("Admin → Storage adds an S3 store, sends Drive there with direct transfers, and moves it back", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const fake = await startFakeS3({ buckets: [BUCKET] });
	const admin = await apiContext(STORAGE_STATE);
	const storeName = `E2E bucket ${uniqueToken("")}`;
	const fileName = `${uniqueToken("direct")}.bin`;
	try {
		await page.goto("/storage");
		await expect(page.getByRole("heading", { level: 1, name: "Storage" })).toBeVisible();
		const defaultRow = page.locator('[data-store="default"]');
		await expect(defaultRow).toContainText("Default: Cloudflare R2");
		await expect(defaultRow.getByRole("button", { name: "Enable direct uploads" })).toBeVisible();
		await expect(driveRow(page)).toContainText("Drive files");

		await page.getByRole("button", { name: "Add store" }).click();
		const add = page.getByRole("dialog", { name: "Add store" });
		await add.getByLabel("Name").fill(storeName);
		await chooseOption(add.getByLabel("Provider"), "minio");
		await add.getByLabel("Endpoint").fill(fake.url);
		await add.getByLabel("Bucket").fill(BUCKET);
		await add.getByLabel("Region").fill(fake.region);
		await add.getByLabel("Access key ID").fill(fake.accessKeyId);
		await add.getByLabel("Secret access key").fill(fake.secretAccessKey);
		await add.getByRole("button", { name: "Check and add" }).click();
		// The bucket has no CORS rule yet: the store is saved, and the browser checks say what to do.
		await expect(add.getByRole("alert")).toContainText("Browsers cannot upload to this store yet");
		await expect(add.locator('[data-step="write"]')).toHaveAttribute("data-status", "ok");
		await expect(add.locator('[data-step="cors_preflight"]')).toHaveAttribute("data-status", "failed");
		await add.getByRole("button", { name: "Apply CORS" }).click();
		await expect(add.locator('[data-step="cors_preflight"]')).toHaveAttribute("data-status", "ok");
		await expect(add.locator('[data-step="cors_upload"]')).toHaveAttribute("data-status", "ok");
		await add.getByRole("button", { name: "Done" }).click();
		await expect(add).toHaveCount(0);

		const storeRow = page.locator("[data-store]").filter({ hasText: storeName });
		await expect(storeRow).toContainText("Working");
		await expect(storeRow).toContainText(`MinIO, bucket ${BUCKET}`);
		await storeRow.getByRole("button", { name: "Test" }).click();
		await expect(storeRow.locator('[data-step="presign"]')).toHaveAttribute("data-status", "ok");

		const overview = await (await admin.get("/api/admin/storage")).json();
		expect(JSON.stringify(overview)).not.toContain(fake.secretAccessKey);
		expect(overview.stores[0].keyHint).toBe(fake.accessKeyId.slice(-4));

		await switchDrive(page, storeName, { copy: false });
		await expect(driveRow(page)).toContainText("Also reading from Cloudflare R2");

		// The explicit dev loopback exception still permits direct transfers, without Kite's cookies.
		await page.goto("/drive");
		const uploadSession = page.waitForResponse(
			(response) => response.url().endsWith("/api/drive/uploads") && response.request().method() === "POST",
		);
		await page.locator("input[data-drive-file-input]").setInputFiles({
			name: fileName,
			mimeType: "application/octet-stream",
			buffer: Buffer.alloc(LARGE_BYTES, 3),
		});
		expect((await (await uploadSession).json()).mode).toBe("direct");
		await expect(page.getByRole("region", { name: "Uploads" }).getByLabel("Uploaded")).toBeVisible({ timeout: 60_000 });
		const requests = fake.state.requests as unknown as {
			method: string;
			query: Record<string, string>;
			headers: Record<string, string>;
		}[];
		const parts = requests.filter((entry) => entry.method === "PUT" && entry.query.partNumber);
		expect(parts.length).toBe(1);
		expect(parts[0].headers.origin).toBe(BASE_URL);
		expect(parts[0].headers.cookie).toBeUndefined();
		const stored = [...fake.buckets.get(BUCKET)!.objects.values()];
		expect(stored.map((object) => object.bytes.length)).toEqual([LARGE_BYTES]);

		// A large download is a short signed redirect that forces an attachment.
		const item = (await listItems(admin)).find((entry) => entry.name === fileName)!;
		const download = await admin.get(`/api/drive/files/${item.id}/content?disposition=attachment`, {
			maxRedirects: 0,
		});
		expect(download.status()).toBe(302);
		expect(download.headers()["cache-control"]).toBe("no-store");
		const location = new URL(download.headers().location);
		expect(location.origin).toBe(fake.url);
		const signed = await fetch(location);
		expect(signed.status).toBe(200);
		expect(signed.headers.get("content-disposition")).toMatch(/^attachment/);
		expect((await signed.arrayBuffer()).byteLength).toBe(LARGE_BYTES);

		// Moving Drive back copies the file, and deleting the old copies empties the bucket.
		await page.goto("/storage");
		await switchDrive(page, "Cloudflare R2", { copy: true });
		const migration = page.locator("[data-migration]").filter({ hasText: `Drive: ${storeName} to Cloudflare R2` });
		await expect(migration.getByRole("status")).toHaveText("Copied", { timeout: 90_000 });
		await expect(migration).toContainText("1 of 1 objects");
		await migration.getByRole("button", { name: `Delete from ${storeName}` }).click();
		const confirm = page.getByRole("alertdialog", { name: `Delete drive from ${storeName}?` });
		await confirm.getByLabel(/to confirm/).fill(storeName);
		await confirm.getByRole("button", { name: "Delete old copies" }).click();
		await expect(migration.getByRole("status")).toHaveText("Old copies deleted", { timeout: 90_000 });
		expect(fake.buckets.get(BUCKET)!.objects.size).toBe(0);

		const streamed = await admin.get(`/api/drive/files/${item.id}/content?disposition=attachment`, {
			maxRedirects: 0,
		});
		expect(streamed.status()).toBe(200);
		expect((await streamed.body()).length).toBe(LARGE_BYTES);

		await storeRow.getByRole("button", { name: "Delete" }).click();
		await page
			.getByRole("alertdialog", { name: `Delete ${storeName}?` })
			.getByRole("button", { name: "Delete store" })
			.click();
		await expect(storeRow).toHaveCount(0);
	} finally {
		await resetStorage(admin);
		await admin.dispose();
		await fake.close();
	}
});

test("mail routed to an S3 store lands there, old messages still open, and a migration moves it back", async () => {
	test.setTimeout(180_000);
	const bucket = "kite-e2e-mail";
	const fake = await startFakeS3({ buckets: [bucket] });
	const admin = await apiContext(STORAGE_STATE);
	const storeName = `E2E mail ${uniqueToken("")}`;
	const objects = () => fake.buckets.get(bucket)!.objects;
	try {
		const old = await deliverInbound(admin, {
			from: "sender@example.net",
			to: SUPPORT_ADDRESS,
			subject: uniqueToken("Before the switch "),
			text: "Stored on the default store.",
		});
		const { store } = await okJson<{ store: { id: string } }>(
			await admin.post("/api/admin/storage/stores", {
				data: {
					name: storeName,
					provider: "minio",
					endpoint: fake.url,
					region: fake.region,
					bucket,
					addressing: "path",
					accessKeyId: fake.accessKeyId,
					secretAccessKey: fake.secretAccessKey,
				},
			}),
		);
		await okJson(await admin.put("/api/admin/storage/routes/mail", { data: { storeId: store.id, migrate: false } }));

		const fresh = await deliverInbound(admin, {
			from: "sender@example.net",
			to: SUPPORT_ADDRESS,
			subject: uniqueToken("After the switch "),
			text: "Stored on the S3 store.",
		});
		expect([...objects().keys()].some((key) => key.startsWith("inbound/"))).toBe(true);
		for (const message of [old, fresh]) {
			const original = await admin.get(`/api/messages/${message.id}/original`);
			expect(original.status()).toBe(200);
			expect(await original.text()).toContain(message.subject);
		}

		const { migrationId } = await okJson<{ migrationId: string }>(
			await admin.put("/api/admin/storage/routes/mail", { data: { storeId: "default", migrate: true } }),
		);
		const copied = await waitForMigration(admin, migrationId, (job) => job.status === "completed");
		expect(copied.errors).toBe(0);
		expect(copied.objectsDone).toBeGreaterThan(0);
		expect(objects().size).toBeGreaterThan(0);
		await okJson(
			await admin.post(`/api/admin/storage/migrations/${migrationId}`, {
				data: { action: "purge-source", confirm: storeName },
			}),
		);
		await waitForMigration(admin, migrationId, (job) => job.phase === "purged");
		expect(objects().size).toBe(0);
		const original = await admin.get(`/api/messages/${fresh.id}/original`);
		expect(await original.text()).toContain(fresh.subject);
		await okJson(await admin.delete(`/api/admin/storage/stores/${store.id}`));
	} finally {
		await resetStorage(admin);
		await admin.dispose();
		await fake.close();
	}
});

test("the storage API is for the primary admin only and never answers with a secret", async () => {
	const anonymous = await apiContext();
	try {
		expect((await anonymous.get("/api/admin/storage")).status()).toBe(401);
		expect((await anonymous.post("/api/admin/storage/stores", { data: {} })).status()).toBe(401);
	} finally {
		await anonymous.dispose();
	}
	const admin = await apiContext(STORAGE_STATE);
	try {
		const response = await admin.get("/api/admin/storage");
		expect(response.status()).toBe(200);
		expect(response.headers()["cache-control"]).toBe("no-store");
		const foreign = await admin.post("/api/admin/storage/stores", {
			data: { name: "x" },
			headers: { Origin: "https://attacker.example" },
		});
		expect(foreign.status()).toBe(403);
	} finally {
		await admin.dispose();
	}
});
