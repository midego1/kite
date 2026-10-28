import { expect, type APIRequestContext } from "@playwright/test";
import { SUPPORT_ADDRESS, STORAGE_STATE } from "../../e2e/support/constants";
import { createFolder, uploadFile } from "../../e2e/support/drive";
import { apiContext, postInbound, waitForMessage } from "../../e2e/support/helpers";

// Every name, address and domain here is invented; .test and example.com are reserved for documentation.
const MAIL = [
	{
		from: `"Wingtip Toys" <orders@wingtip.test>`,
		subject: "Your order #4821 has shipped",
		html: `<p>Good news: your order is on its way and should arrive on Thursday.</p><p><b>Tracking number:</b> WT-4821-0093</p>`,
	},
	{
		from: `"Fabrikam Billing" <invoices@fabrikam.test>`,
		subject: "Your October invoice is ready",
		html: `<p>Hello,</p><p>Invoice <b>FB-2026-10</b> for <b>€240.00</b> is ready and will be charged to the card on file on 1 November.</p><p>Fabrikam Billing</p>`,
	},
	{
		from: `"Priya Raman" <priya@acme.test>`,
		subject: "Quarterly support metrics",
		html: `<p>Hi team,</p><p>First-response time dropped to 42 minutes this quarter, and 94% of tickets were solved within a day. The full report is in the shared folder.</p><p>Priya</p>`,
	},
	{
		from: `"Northwind Status" <status@northwind.test>`,
		subject: "Scheduled maintenance this Saturday",
		html: `<h2>Planned maintenance</h2><p>The Northwind API will be read-only on Saturday from 06:00 to 07:00 UTC while we upgrade the database cluster. No action is needed.</p>`,
	},
	{
		from: `"Tom Okafor" <tom@adventure-works.test>`,
		subject: "Offsite agenda and travel details",
		html: `<p>Hi all,</p><p>The offsite is confirmed for 14–15 November in Lisbon. Day one is planning, day two is the customer workshop. Please book travel by Friday so we can share rooms.</p><p>Tom</p>`,
	},
	{
		from: `"Lena Fischer" <lena@contoso.test>`,
		subject: "Design review notes for the new onboarding flow",
		html: `<p>Hi,</p><p>Thanks for walking us through the new onboarding flow yesterday. A few notes from the review:</p><ul><li>The domain step is much clearer now that the DNS records are checked automatically.</li><li>Could the mailbox step suggest <i>hello@</i> and <i>support@</i> as starting points?</li><li>The welcome email should link straight to the inbox.</li></ul><p>Happy to pair on any of these this week.</p><p>Best,<br>Lena</p>`,
	},
];
export const OPENED = MAIL.at(-1)!;

/** A conversation of three, the last with attachments, for the reader's thread view. Delivered last, so it leads the list. */
export const THREAD = [
	{
		from: `"Sofia Marchetti" <sofia@northwind.test>`,
		subject: "Launch plan for the new inbox",
		messageId: "<launch-plan-1@northwind.test>",
		html: `<p>Hi both,</p><p>Here is the first cut of the launch plan for the new inbox. The beta opens to 200 accounts on Monday, the waitlist follows a week later.</p><p>Sofia</p>`,
	},
	{
		from: `"Daniel Osei" <daniel@northwind.test>`,
		subject: "Re: Launch plan for the new inbox",
		messageId: "<launch-plan-2@northwind.test>",
		inReplyTo: "<launch-plan-1@northwind.test>",
		html: `<p>Looks good. Can we add a short tour for the command palette? Most beta users will not find it on their own.</p><p>Daniel</p>`,
	},
	{
		from: `"Sofia Marchetti" <sofia@northwind.test>`,
		subject: "Re: Launch plan for the new inbox",
		messageId: "<launch-plan-3@northwind.test>",
		inReplyTo: "<launch-plan-2@northwind.test>",
		html: `<p>Good call, the tour is in. Attached are the updated plan and the rollout checklist; shout if anything is missing before Monday.</p><p>Sofia</p>`,
		attachments: [
			{ filename: "launch-plan.pdf", contentType: "application/pdf", content: Buffer.alloc(48_000, 37) },
			{ filename: "rollout-checklist.csv", contentType: "text/csv", content: "step,owner\nbeta invites,Sofia\ntour,Daniel\n" },
		],
	},
];

const EVENTS = [
	{ day: 0, start: "09:00", end: "09:30", title: "Team standup", color: "blue", repeat: "weekdays" },
	{ day: 0, start: "13:00", end: "14:00", title: "Design review: onboarding", color: "violet" },
	{ day: 1, start: "11:00", end: "12:00", title: "Customer call: Contoso", color: "emerald", location: "Video call" },
	{ day: 2, start: "15:00", end: "16:30", title: "Quarterly metrics review", color: "orange" },
	{ day: 3, start: "10:00", end: "11:30", title: "Offsite planning", color: "rose" },
	{ day: 4, start: "14:00", end: "15:00", title: "Release check-in", color: "blue" },
];

/** Drive folders and files; the bytes are filler, only names, types and sizes show. */
const DRIVE_FOLDERS = ["Brand assets", "Contracts", "Offsite Lisbon", "Receipts 2026"];
const DRIVE_FILES: { name: string; contentType: string; kilobytes: number }[] = [
	{ name: "Launch plan.pdf", contentType: "application/pdf", kilobytes: 420 },
	{ name: "Quarterly support metrics.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kilobytes: 86 },
	{ name: "Onboarding flow review.pdf", contentType: "application/pdf", kilobytes: 1310 },
	{ name: "Team photo.jpg", contentType: "image/jpeg", kilobytes: 1800 },
	{ name: "Welcome email draft.txt", contentType: "text/plain", kilobytes: 3 },
	{ name: "Offsite agenda.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kilobytes: 58 },
	{ name: "Product walkthrough.mp4", contentType: "video/mp4", kilobytes: 4600 },
];

function plainText(html: string): string {
	let text = html.replace(/<\/(p|li|h2)>/g, "\n");
	// Repeat until stable so removing one tag cannot leave another one behind.
	for (let previous = ""; previous !== text; ) {
		previous = text;
		text = text.replace(/<[^>]*>/g, "");
	}
	return text.replace(/[<>]/g, "").trim();
}

/** Monday of the week the calendar shows, which starts on Sunday, so a Sunday run still lands inside the shown week. */
function mondayOfThisWeek(): Date {
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	today.setUTCDate(today.getUTCDate() - today.getUTCDay() + 1);
	return today;
}

function at(monday: Date, day: number, time: string): string {
	const [hours, minutes] = time.split(":").map(Number);
	const date = new Date(monday);
	date.setUTCDate(date.getUTCDate() + day);
	date.setUTCHours(hours!, minutes!);
	return date.toISOString();
}

async function seedDrive(api: APIRequestContext): Promise<void> {
	const response = await api.get("/api/drive/items");
	const { items } = (await response.json()) as { items: { name: string }[] };
	const stored = new Set(items.map((item) => item.name));
	for (const name of DRIVE_FOLDERS) if (!stored.has(name)) await createFolder(api, name);
	for (const { name, contentType, kilobytes } of DRIVE_FILES) {
		if (!stored.has(name)) await uploadFile(api, name, Buffer.alloc(kilobytes * 1024, 32), { contentType });
	}
}

async function seedCalendar(api: APIRequestContext): Promise<void> {
	const monday = mondayOfThisWeek();
	for (const { day, start, end, ...event } of EVENTS) {
		const response = await api.post("/api/calendar/events", {
			data: { ...event, startsAt: at(monday, day, start), endsAt: at(monday, day, end), timeZone: "UTC" },
		});
		expect(response.ok(), await response.text()).toBe(true);
	}
}

/** Posts the demo mail, shared mailboxes and calendar events into the isolated e2e server. */
export async function seedDemoData(): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	// A server kept across runs (E2E_REUSE_SERVER=1) already holds the demo data; seeding it twice would double it.
	const seeded = await api.get(`/api/messages?${new URLSearchParams({ q: THREAD[0]!.subject, limit: "1" })}`);
	const { messages: existing } = (await seeded.json()) as { messages: unknown[] };
	if (existing.length > 0) {
		await seedDrive(api);
		await api.dispose();
		return;
	}
	for (const mail of MAIL) {
		await postInbound(api, { ...mail, to: `"Support" <${SUPPORT_ADDRESS}>`, text: plainText(mail.html) });
		await waitForMessage(api, mail.subject);
	}
	for (const mail of THREAD) {
		await postInbound(api, { ...mail, to: `"Support" <${SUPPORT_ADDRESS}>`, text: plainText(mail.html) });
		await waitForMessage(api, mail.subject === THREAD[0]!.subject ? mail.subject : `Re: ${THREAD[0]!.subject}`);
	}
	const { domains } = (await (await api.get("/api/domains")).json()) as { domains: { id: string }[] };
	for (const [localPart, displayName] of [
		["hello", "Hello"],
		["team", "Team"],
	]) {
		const response = await api.post("/api/mailboxes", {
			data: { domainId: domains[0]!.id, localPart, displayName, type: "shared" },
		});
		expect(response.ok(), await response.text()).toBe(true);
	}
	await seedCalendar(api);
	await seedDrive(api);
	await api.dispose();
}
