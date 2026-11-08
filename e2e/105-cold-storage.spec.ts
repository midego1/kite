import { expect, test } from "@playwright/test";
import { startFakeS3 } from "../tests/support/fake-s3.mjs";
import { attachmentsOf, download } from "./support/attachment-storage";
import { okJson } from "./support/auto-read";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { sql } from "./support/drive";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

// ROADMAP Milestone 7 item 3, docs/specs/drive-storage.md §10: an age rule moves an old message (and the
// attachment served from its raw bytes) to a second store, and reading it back, downloading it and finding it
// in search all keep working with no extra step.

const DAY_SECONDS = 24 * 60 * 60;

test("a mail cold storage rule moves an old message to a second store, and it still opens, downloads and searches", async ({
	page,
}) => {
	// CI runs this shard's two E2E slices side by side on one runner, and a cold storage sweep needs several
	// OUTBOUND_QUEUE round trips (one batch per source, plus more to notice empty sources and finish); under
	// that contention a batch has taken well over 90 seconds to land. The poll below only waits for the one
	// round trip that actually moves the message, not for the job's bookkeeping status to reach "completed".
	test.setTimeout(180_000);
	const bucket = "kite-e2e-cold";
	const fake = await startFakeS3({ buckets: [bucket] });
	const admin = await apiContext(STORAGE_STATE);
	const storeName = `E2E cold ${uniqueToken("")}`;
	let storeId: string | undefined;
	let oldId: string | undefined;
	try {
		const subject = uniqueToken("Cold storage candidate ");
		const old = await deliverInbound(admin, {
			from: "sender@example.net",
			to: SUPPORT_ADDRESS,
			subject,
			text: "This message is old enough to go cold.",
			attachments: [{ filename: "note.txt", contentType: "text/plain", content: "cold attachment bytes" }],
		});
		oldId = old.id;
		const fresh = await deliverInbound(admin, {
			from: "sender@example.net",
			to: SUPPORT_ADDRESS,
			subject: uniqueToken("Still warm "),
			text: "This message just arrived.",
		});

		// Backdates the seeded message well past the rule's age, the way a real mailbox accumulates old mail.
		const oldEnough = Math.floor(Date.now() / 1000) - 60 * DAY_SECONDS;
		sql(`UPDATE messages SET created_at = ${oldEnough} WHERE id = '${old.id}'`);
		sql(`UPDATE message_attachments SET created_at = ${oldEnough} WHERE message_id = '${old.id}'`);

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

		await page.goto("/storage");
		await expect(page.getByRole("heading", { level: 2, name: "Cold storage" })).toBeVisible();
		const row = page.locator('[data-cold-rule="mail"]');
		await expect(row.getByRole("status")).toHaveText("Never run");
		await row.getByLabel("Older than (days)").fill("30");
		await chooseOption(row.getByLabel("Move to"), { label: storeName });
		await row.getByRole("checkbox", { name: "On" }).click();
		await row.getByRole("button", { name: "Save" }).click();
		await expect(row.getByRole("button", { name: "Run now" })).toBeEnabled();
		await row.getByRole("button", { name: "Run now" }).click();
		// Polls the fake S3 bucket directly for the moved object rather than the job's bookkeeping counter or
		// the UI's own three-second refetch, the way e2e/48-storage-s3.spec.ts's waitForMigration polls the
		// admin API for a store migration: this is the actual move completing (copied, verified and the
		// source deleted), not a proxy for it, so the reads just below are never racing the move itself.
		const objectKeys = () => [...fake.buckets.get(bucket)!.objects.keys()];
		await expect
			.poll(() => objectKeys().some((key) => key.startsWith("inbound/")), {
				timeout: 120_000,
				intervals: [500, 1000, 2000],
			})
			.toBe(true);
		const { jobs } = await okJson<{
			jobs: { objectClass: string; status: string; objectsDone: number; errors: number }[];
		}>(await admin.get("/api/admin/storage/cold"));
		expect(jobs.find((entry) => entry.objectClass === "mail")?.errors).toBe(0);

		// Opening the old message's original and attachment both read through the cold store transparently.
		const original = await admin.get(`/api/messages/${old.id}/original`);
		expect(original.status()).toBe(200);
		expect(await original.text()).toContain(subject);
		const [attachment] = await attachmentsOf(admin, old.id);
		expect(attachment).toBeTruthy();
		const bytes = await download(admin, old.id, attachment.id);
		expect(bytes.toString("utf8")).toBe("cold attachment bytes");

		// The message that was too young to move is untouched.
		const freshOriginal = await admin.get(`/api/messages/${fresh.id}/original`);
		expect(await freshOriginal.text()).toContain(fresh.subject);

		// Still findable: the search index lives in D1 and never depended on where the raw bytes are.
		await page.goto("/inbox");
		const search = page.getByRole("textbox", { name: /Search mail/ });
		await search.fill(subject);
		await search.press("Enter");
		await expect(page.getByRole("main").getByText(subject, { exact: true }).first()).toBeVisible();
	} finally {
		// Cold-moved objects and the rule referencing this store must go before the store itself can. Scoped
		// to what this spec itself touched (the mail rule, the mail job, and only the message this spec
		// delivered), so a slice's shared database keeps any other spec's cold storage state intact.
		sql("UPDATE storage_cold_rules SET enabled = 0, target = 'r2-ia' WHERE object_class = 'mail'");
		if (oldId) sql(`DELETE FROM object_locations WHERE key = (SELECT raw_r2_key FROM messages WHERE id = '${oldId}')`);
		sql("DELETE FROM storage_cold_jobs WHERE object_class = 'mail'");
		if (storeId) await admin.delete(`/api/admin/storage/stores/${storeId}`).catch(() => undefined);
		await admin.dispose();
		await fake.close();
	}
});
