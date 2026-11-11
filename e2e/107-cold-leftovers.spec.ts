import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { startFakeS3 } from "../tests/support/fake-s3.mjs";
import { okJson } from "./support/auto-read";
import { E2E_PERSIST_DIR, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { sql } from "./support/drive";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Admin → Storage, cold storage leftovers (docs/operations.md, "The leftover cleanup"): a copy a cold storage move
// left on a second store is offered when deleting that store, removed by Delete leftovers once its live copy reads
// back, and the store can then go; the automatic cleanup's settings are saved from the Leftover copies card.

const DAY_SECONDS = 24 * 60 * 60;

function rawKeyOf(messageId: string): string {
	const output = execFileSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"DB",
			"--local",
			"--persist-to",
			E2E_PERSIST_DIR,
			"--json",
			"--command",
			`SELECT raw_r2_key AS key FROM messages WHERE id = '${messageId}'`,
		],
		{ env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	).toString();
	const [result] = JSON.parse(output) as { results: { key: string }[] }[];
	return result.results[0].key;
}

/**
 * The cleanup stays off for an hour after any restore (as it must: a restore rewrites the rows that reference
 * objects), and another spec of this slice may have just run one. This spec is about the action itself, so it
 * forgets that finished restore's record first.
 */
function forgetFinishedRestore() {
	try {
		execFileSync(
			"npx",
			[
				"wrangler",
				"r2",
				"object",
				"delete",
				"kite-raw/system/backup-restore.json",
				"--local",
				"--persist-to",
				E2E_PERSIST_DIR,
			],
			{ env: { ...process.env, CI: "1" }, stdio: "pipe" },
		);
	} catch {
		// No restore ran in this slice.
	}
}

test("a store holding only leftovers offers Delete leftovers, which removes the copy and lets the store go", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const bucket = "kite-e2e-leftovers";
	const fake = await startFakeS3({ buckets: [bucket] });
	const admin = await apiContext(STORAGE_STATE);
	const storeName = `E2E leftovers ${uniqueToken("")}`;
	let storeId: string | undefined;
	try {
		const subject = uniqueToken("Leftover copy ");
		const message = await deliverInbound(admin, {
			from: "sender@example.net",
			to: SUPPORT_ADDRESS,
			subject,
			text: "This message keeps its copy in the default store.",
		});
		const key = rawKeyOf(message.id);
		const original = await admin.get(`/api/messages/${message.id}/original`);
		expect(original.status()).toBe(200);
		const bytes = Buffer.from(await original.body());

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
		storeId = store.id;
		// What a cold move leaves behind once the object is read from elsewhere again (a storage migration copied
		// it back into the default store, say): the old copy on the second store, tracked as a leftover for 30 days.
		fake.buckets.get(bucket)!.objects.set(key, {
			bytes,
			meta: { custom: {} },
			etag: "e2e-leftover",
			lastModified: new Date(),
		});
		const now = Math.floor(Date.now() / 1000);
		sql(
			`INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at, first_orphaned_at)
			 VALUES ('sco_e2e_${storeId}', '${storeId}', '${key}', 'mail', ${now - 60 * DAY_SECONDS}, ${now - 30 * DAY_SECONDS}, ${now - 30 * DAY_SECONDS})`,
		);
		forgetFinishedRestore();

		await page.goto("/storage");
		const row = page.locator(`[data-store="${storeId}"]`);
		await expect(row.getByText("1 leftover copy from cold storage moves.")).toBeVisible();

		// Deleting the store is refused while the leftover is on it, and the answer points at the cleanup.
		await row.getByRole("button", { name: "Delete", exact: true }).click();
		await page
			.getByRole("alertdialog", { name: `Delete ${storeName}?` })
			.getByRole("button", { name: "Delete store" })
			.click();
		await expect(row.getByRole("alert")).toContainText("delete the leftovers first");
		await expect(row.getByRole("alert")).toContainText("Delete leftovers removes the ones that are safe to delete");

		await row.getByRole("button", { name: "Delete leftovers" }).click();
		const confirm = page.getByRole("alertdialog", { name: `Delete leftover copies on ${storeName}?` });
		await expect(confirm).toContainText("past the 7-day grace period");
		await confirm.getByRole("button", { name: "Delete leftovers" }).click();
		await expect(row.getByRole("status")).toHaveText(
			"Deleted 1 leftover copy. No leftover copies are left on this store.",
		);
		await expect(row.getByText("1 leftover copy from cold storage moves.")).toBeHidden();
		expect(fake.buckets.get(bucket)!.objects.has(key)).toBe(false);

		// The message still opens from its live copy.
		const after = await admin.get(`/api/messages/${message.id}/original`);
		expect(after.status()).toBe(200);
		expect(await after.text()).toContain(subject);

		// The Leftover copies card shows the run, and its settings save.
		const card = page.locator("section", { has: page.getByRole("heading", { name: "Leftover copies" }) });
		await expect(card).toContainText("Deleted 1 leftover copy.");
		await card.getByLabel("Grace period (days)").fill("10");
		await card.getByRole("checkbox", { name: "Delete leftovers automatically" }).click();
		await card.getByRole("button", { name: "Save" }).click();
		await expect(card.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
		await page.reload();
		await expect(card.getByLabel("Grace period (days)")).toHaveValue("10");
		await expect(card.getByRole("checkbox", { name: "Delete leftovers automatically" })).toBeChecked();

		// With the leftover gone, the store can be deleted.
		await row.getByRole("button", { name: "Delete", exact: true }).click();
		await page
			.getByRole("alertdialog", { name: `Delete ${storeName}?` })
			.getByRole("button", { name: "Delete store" })
			.click();
		await expect(row).toBeHidden();
		storeId = undefined;
	} finally {
		await admin
			.put("/api/admin/storage/leftovers", { data: { automatic: false, graceDays: 7 } })
			.catch(() => undefined);
		if (storeId) {
			sql(`DELETE FROM storage_cold_orphans WHERE store_id = '${storeId}'`);
			await admin.delete(`/api/admin/storage/stores/${storeId}`).catch(() => undefined);
		}
		await admin.dispose();
		await fake.close();
	}
});
