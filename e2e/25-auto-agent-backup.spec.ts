import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN, DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { createSignedInAccount, okJson } from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, apiSignIn, postInbound, uniqueToken, waitForBackup, waitForMessage } from "./support/helpers";
import { futureAt, inviteAttachment } from "./support/invites";
import { readActions, readSuggestions, waitForFinishedJob } from "./support/triage";

// Restoring replaces every table, so this file is named to run after every other spec.
test.describe.configure({ mode: "serial" });

type Row = Record<string, string | number | null>;
type BackupDocument = { includedTables: string[]; tables: Record<string, Row[]> };

const ORGANIZER = "alice@partner.test";

let fake: FakeModel;

test.beforeAll(async () => {
	fake = await startFakeModel();
});

test.afterAll(async () => {
	await fake.close();
});

async function takeBackup(admin: APIRequestContext): Promise<BackupDocument> {
	const { backupId } = await okJson<{ backupId: string }>(await admin.post("/api/backups"));
	// Manual backups are exported by the outbound queue consumer, so the request
	// only queues the record and the file appears once the job completes.
	const finished = await waitForBackup(admin, backupId);
	expect(finished.status, finished.error ?? "").toBe("completed");
	const download = await admin.get(`/api/backups/${backupId}/download`);
	expect(download.ok()).toBe(true);
	return JSON.parse(await download.text()) as BackupDocument;
}

test("a backup with live agent data and invite events restores intact, including a tentative event", async () => {
	const admin = await apiContext(STORAGE_STATE);
	const restoreProvider = await useFakeProvider(admin, fake);
	const username = `bk${uniqueToken("")}`;
	const account = await createSignedInAccount(admin, username);
	const address = `${username}@${DOMAIN}`;
	await okJson(
		await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
	);

	async function deliver(daysAhead: number, summary: string) {
		const uid = `${uniqueToken("uid")}@partner.test`;
		const subject = uniqueToken("inv");
		await postInbound(account.api, {
			from: `Alice <${ORGANIZER}>`,
			to: address,
			subject,
			text: "Please join.",
			attachments: [inviteAttachment({ uid, start: futureAt(daysAhead, 10), summary })],
		});
		const message = await waitForMessage(account.api, subject, { status: "received" });
		await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
		const { suggestions } = await readSuggestions(account.api, { mailboxId: account.mailboxId, messageId: message.id });
		const suggestion = suggestions.find((item) => item.kind === "calendar_invite");
		expect(suggestion).toBeDefined();
		return { uid, suggestion: suggestion! };
	}
	const accept = (id: string) =>
		account.api.post(`/api/agent/suggestions/${id}/accept`, { data: { option: "accept" } });
	const events = async () => {
		const range = new URLSearchParams({
			start: futureAt(50, 0).toISOString(),
			end: futureAt(80, 0).toISOString(),
		});
		const body = await okJson<{ events: Row[] }>(await account.api.get(`/api/calendar/events?${range}`));
		return body.events;
	};

	let admin2: APIRequestContext | undefined;
	let account2: APIRequestContext | undefined;
	try {
		const kept = await deliver(61, uniqueToken("Kept invite"));
		const undone = await deliver(62, uniqueToken("Undone invite"));
		const open = await deliver(63, uniqueToken("Open invite"));
		const dismissed = await deliver(64, uniqueToken("Dismissed invite"));
		await okJson(await accept(kept.suggestion.id));
		await okJson(await accept(undone.suggestion.id));
		const createRow = (await readActions(account.api, account.mailboxId)).find(
			(action) => action.suggestionId === undone.suggestion.id && action.action === "create_event",
		);
		await okJson(await account.api.post(`/api/agent/actions/${createRow!.id}/undo`));
		await okJson(await account.api.post(`/api/agent/suggestions/${dismissed.suggestion.id}/dismiss`));
		await restoreProvider();

		const document = await takeBackup(admin);
		for (const table of ["agent_suggestions", "agent_actions", "agent_sender_policies", "calendar_events"])
			expect(document.includedTables).toContain(table);
		const mine = (rows: Row[]) => rows.filter((row) => row.mailbox_id === account.mailboxId);
		expect(
			mine(document.tables.agent_suggestions)
				.map((row) => row.status)
				.sort(),
		).toEqual(expect.arrayContaining(["open", "dismissed"]));
		const actionStatuses = mine(document.tables.agent_actions).map((row) => row.status);
		expect(actionStatuses).toEqual(expect.arrayContaining(["applied", "undone"]));
		const keptEvent = document.tables.calendar_events.find((row) => row.ical_uid === kept.uid);
		expect(keptEvent).toMatchObject({
			ical_uid: kept.uid,
			ical_sequence: 0,
			organizer: ORGANIZER,
			status: "confirmed",
		});
		expect(keptEvent!.source_message_id).toEqual(expect.stringMatching(/^msg_/));
		expect(document.tables.calendar_events.some((row) => row.ical_uid === undone.uid)).toBe(false);

		// Nothing in the product writes a sender policy, a blocked action or a tentative event yet, so
		// the document carries them the way a later release would.
		const template = mine(document.tables.agent_actions)[0];
		document.tables.agent_actions.push({ ...template, id: `act_${uniqueToken("blk")}`, status: "blocked" });
		document.tables.agent_sender_policies.push({
			id: `asp_${uniqueToken("pol")}`,
			mailbox_id: account.mailboxId,
			pattern: `@${ORGANIZER.split("@")[1]}`,
			require_auth: 1,
			allowed_actions: '["accept_invite"]',
			template_rule: null,
			created_by_user_id: account.id,
			created_at: Date.now(),
		});
		keptEvent!.status = "tentative";

		// Change the live data, then restore the document.
		await okJson(await account.api.post(`/api/agent/suggestions/${open.suggestion.id}/dismiss`));
		const gone = await account.api.delete(
			`/api/calendar/events/${(await events()).find((e) => e.icalUid === kept.uid)!.id}`,
		);
		expect(gone.ok()).toBe(true);
		expect((await events()).filter((event) => event.icalUid === kept.uid)).toEqual([]);

		const restored = await admin.post("/api/backups/restore", {
			multipart: {
				backup: { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document)) },
			},
		});
		expect(restored.ok(), await restored.text()).toBe(true);

		admin2 = await apiSignIn(ADMIN.email, ADMIN.password);
		account2 = await apiSignIn(address, "auto-read-password-123");
		const suggestions = (await readSuggestions(account2, { mailboxId: account.mailboxId })).suggestions;
		const byId = (id: string) => suggestions.find((item) => item.id === id)?.status;
		expect(byId(open.suggestion.id)).toBe("open");
		expect(byId(dismissed.suggestion.id)).toBe("dismissed");
		const statuses = (await readActions(account2, account.mailboxId)).map((action) => action.status);
		expect(statuses).toEqual(expect.arrayContaining(["applied", "undone", "blocked"]));

		const range = new URLSearchParams({ start: futureAt(50, 0).toISOString(), end: futureAt(80, 0).toISOString() });
		const { events: after } = await okJson<{ events: Row[] }>(await account2.get(`/api/calendar/events?${range}`));
		const back = after.find((event) => event.icalUid === kept.uid);
		expect(back).toMatchObject({ icalUid: kept.uid, icalSequence: 0, organizer: ORGANIZER, status: "tentative" });
		expect(back!.sourceMessageId).toBe(keptEvent!.source_message_id);

		const again = await takeBackup(admin2);
		expect(again.tables.agent_sender_policies.some((row) => row.mailbox_id === account.mailboxId)).toBe(true);
	} finally {
		await account2?.dispose();
		await admin2?.dispose();
		await account.api.dispose();
		await admin.dispose();
	}
});
