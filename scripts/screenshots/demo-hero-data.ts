import { expect, type Page } from "@playwright/test";
// Renamed: called from a plain function, the `use` prefix would read as a React hook to the linter.
import { useFakeProvider as switchToFakeProvider } from "../../e2e/support/agent";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "../../e2e/support/constants";
import { startFakeModel } from "../../e2e/support/fake-model";
import { FAKE_SCENARIOS } from "../../e2e/support/fake-model-scenarios";
import type { FakeModel } from "../../e2e/support/fake-model-types";
import { apiContext, postInbound, waitForMessage } from "../../e2e/support/helpers";
import { THREAD, seedDemoData } from "./demo-data";

// What the README animation adds to the shared demo data: a fuller inbox with attachments and a designed
// newsletter for dark mode, model answers for the summary and Write with Kite, and two connected accounts.
// Every name, address and domain is invented; .test and .example are reserved for documentation.

const filler = (kilobytes: number) => Buffer.alloc(kilobytes * 1024, 37);

/** A newsletter that brings its own colours, which dark mode adapts and "Original colours" restores. */
export const NEWSLETTER = {
	from: `"Fourth Coffee" <hello@fourthcoffee.test>`,
	subject: "Autumn roasts are here",
	html: `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f6efe6"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="background-color:#fffaf3;border-radius:12px">
<tr><td style="background-color:#3d2b1f;color:#f6e7d3;padding:28px 32px;font-family:Georgia,serif;font-size:26px;border-radius:12px 12px 0 0">Fourth Coffee <span style="color:#e3a15b">·</span> Autumn roasts</td></tr>
<tr><td style="padding:28px 32px;color:#4a3a2f;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6">
<p style="margin:0 0 14px;color:#4a3a2f">Three new single origins just landed: a honey-processed Costa Rica, a bright Ethiopia Guji and our Harvest Blend with notes of baked apple and cocoa.</p>
<p style="margin:0 0 22px;color:#6b5a4c">Members get 15% off the first bag, roasted the day it ships.</p>
<a href="https://example.com/roasts" style="display:inline-block;background-color:#c2632a;color:#ffffff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Shop the roasts</a>
</td></tr>
<tr><td style="padding:0 32px 26px;color:#9a8878;font-family:Helvetica,Arial,sans-serif;font-size:12px">Fourth Coffee Roasters · 12 Harbour Lane · You get this because you joined the tasting club.</td></tr>
</table></td></tr></table>`,
};

const EXTRA_MAIL = [
	{
		from: `"Grace Kim" <grace@woodgrove.test>`,
		subject: "Quick question about API rate limits",
		html: `<p>Hi,</p><p>We are moving our ticket sync to your API next week. Is the limit per key or per account? We would batch about 4,000 requests an hour.</p><p>Thanks,<br>Grace</p>`,
	},
	NEWSLETTER,
	{
		from: `"Jonas Weber" <jonas@litware.test>`,
		subject: "Photos from the Lisbon offsite",
		html: `<p>Hi all,</p><p>A few favourites from the offsite are attached. The full album is in Drive under Offsite Lisbon.</p><p>Jonas</p>`,
		attachments: [
			{ filename: "tram-28.jpg", contentType: "image/jpeg", content: filler(180) },
			{ filename: "team-dinner.jpg", contentType: "image/jpeg", content: filler(220) },
		],
	},
	{
		from: `"Mia Lindqvist" <mia@tailspin.test>`,
		subject: "Signed pilot agreement",
		html: `<p>Hello,</p><p>Attached is the countersigned pilot agreement. We start on the 1st; I will send the onboarding contacts tomorrow.</p><p>Kind regards,<br>Mia Lindqvist<br>Tailspin Logistics</p>`,
		attachments: [{ filename: "tailspin-pilot-agreement.pdf", contentType: "application/pdf", content: filler(96) }],
	},
];

const plain = (html: string) =>
	html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** The shared demo data plus the animation's extra mail, delivered after it so the newest rows lead the list. */
export async function seedHeroData(): Promise<void> {
	await seedDemoData();
	const api = await apiContext(STORAGE_STATE);
	const seeded = await api.get(`/api/messages?${new URLSearchParams({ q: NEWSLETTER.subject, limit: "1" })}`);
	const { messages } = (await seeded.json()) as { messages: unknown[] };
	if (messages.length === 0) {
		for (const mail of EXTRA_MAIL) {
			await postInbound(api, { ...mail, to: `"Support" <${SUPPORT_ADDRESS}>`, text: plain(mail.html) });
			await waitForMessage(api, mail.subject);
		}
	}
	// The e2e setup's own support thread (global-setup.ts) would lead the list; the animation starts with the demo mail.
	const setup = await api.get(`/api/messages?${new URLSearchParams({ q: "Cannot access workspace", limit: "100" })}`);
	const setupIds = ((await setup.json()) as { messages: { id: string }[] }).messages.map(({ id }) => id);
	if (setupIds.length) await api.post("/api/messages/bulk", { data: { messageIds: setupIds, action: "archive" } });
	// A server kept across runs (E2E_REUSE_SERVER=1) still has the reply the last run drafted, and the last upload.
	const drafts = await api.get(`/api/messages?${new URLSearchParams({ status: "draft", limit: "100" })}`);
	for (const { id } of ((await drafts.json()) as { messages: { id: string }[] }).messages) await api.delete(`/api/drafts/${id}`);
	const drive = (await (await api.get("/api/drive/items")).json()) as { items: { id: string; name: string }[] };
	const uploads = drive.items.filter(({ name }) => name === DRIVE_UPLOAD).map(({ id }) => id);
	for (const action of ["trash", "delete"])
		if (uploads.length) await api.post("/api/drive/items/bulk", { data: { action, ids: uploads } });
	await api.dispose();
}

/** The file the animation uploads to Drive. */
export const DRIVE_UPLOAD = "Brand film final.mp4";

/** The reply Write with Kite writes to Sofia; typed into the panel as the request. */
export const WRITE_REQUEST = "Thank Sofia, and ask for a short FAQ for beta users.";
const WRITE_ANSWER =
	"Hi Sofia,\n\nThanks for pulling this together, the plan looks great and the tour is a nice touch.\n\nOne small ask: could we add a short FAQ for the beta users before Monday?\n\nBest,\nDemo";

const SUMMARY = {
	language: "en",
	overview:
		"Sofia shared the launch plan for the new inbox: the beta opens to 200 accounts on Monday and the waitlist follows a week later. Daniel's command palette tour is now in.",
	points: [
		{ label: "Dates", text: "Beta opens Monday; the waitlist a week later." },
		{ label: "Next steps", text: "Review the updated plan and the rollout checklist before Monday." },
	],
};

/**
 * Starts the loopback fake model with the animation's own answers and makes it the install's provider, so the
 * summary and Write with Kite run through the real app. Returns a function that restores the previous provider.
 */
export async function startDemoModel(): Promise<() => Promise<void>> {
	FAKE_SCENARIOS["kite-demo"] = {
		triage: () => ({ content: JSON.stringify({ category: "fyi", priority: "normal" }) }),
		compose: () => ({ content: WRITE_ANSWER }),
		summary: () => ({ content: JSON.stringify(SUMMARY) }),
	};
	const fake: FakeModel = await startFakeModel();
	fake.setDefaultScenario("kite-demo");
	const api = await apiContext(STORAGE_STATE);
	const restore = await switchToFakeProvider(api, fake);
	// Automatic reading stays off, so the only model requests are the ones the animation makes.
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	for (const { id } of mailboxes) {
		const response = await api.put("/api/agent/settings", { data: { mailboxId: id, autonomy: "off" } });
		expect(response.ok(), await response.text()).toBe(true);
	}
	return async () => {
		await restore();
		await api.dispose();
		await fake.close();
	};
}

const HOUR = 3_600_000;

function connectedAccount(id: string, preset: "gmail" | "icloud", label: string, address: string, mailboxId: string) {
	const presetLabel = preset === "gmail" ? "Gmail" : "iCloud Mail";
	const host = preset === "gmail" ? "imap.gmail.com" : "imap.mail.me.com";
	const smtp = preset === "gmail" ? "smtp.gmail.com" : "smtp.mail.me.com";
	const now = Date.now();
	return {
		id,
		label,
		address,
		displayName: "Demo User",
		preset,
		presetLabel,
		mailboxId,
		imap: { host, port: 993, security: "tls" },
		smtp: { host: smtp, port: 587, security: "starttls" },
		username: address,
		status: "active",
		statusReason: null,
		lastError: null,
		hasPassword: true,
		sync: {
			enabled: true,
			intervalMinutes: 5,
			lastSuccessAt: new Date(now - 2 * 60_000).toISOString(),
			nextSyncAt: new Date(now + 3 * 60_000).toISOString(),
			failures: 0,
			problem: null,
			running: false,
		},
		sending: { enabled: true, appendSent: preset !== "gmail", providerSavesSent: preset === "gmail", verified: true, block: null },
		createdAt: new Date(now - 30 * 24 * HOUR).toISOString(),
		updatedAt: new Date(now - HOUR).toISOString(),
	};
}

/** Settings → Connected accounts lists a Gmail and an iCloud account; the presets and the rest are the app's own. */
export async function mockConnectedAccounts(page: Page): Promise<void> {
	await page.route("**/api/external-accounts", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const response = await route.fetch();
		const body = (await response.json()) as Record<string, unknown>;
		const api = await apiContext(STORAGE_STATE);
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		await api.dispose();
		const mailboxId = mailboxes[0]!.id;
		await route.fulfill({
			response,
			json: {
				...body,
				refusal: null,
				accounts: [
					connectedAccount("demo-gmail", "gmail", "Personal", "demo.user@gmail.example", mailboxId),
					connectedAccount("demo-icloud", "icloud", "Family", "demo.user@icloud.example", mailboxId),
				],
			},
		});
	});
}

export { THREAD };
