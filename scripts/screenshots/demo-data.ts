import { expect, type APIRequestContext } from "@playwright/test";
import { SUPPORT_ADDRESS, STORAGE_STATE } from "../../e2e/support/constants";
import { createFolder, uploadFile } from "../../e2e/support/drive";
import { apiContext, postInbound, waitForMessage } from "../../e2e/support/helpers";
import type { InboundAttachment } from "../../e2e/support/helpers-types";

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
	{ day: 0, start: "13:00", end: "14:30", title: "Design review: onboarding", color: "violet" },
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

/** Invented right-to-left mail (Arabic and Hebrew) for the changelog's RTL screenshot; not part of the shared demo set. */
export const RTL_MAIL = [
	{
		from: `"ليلى حداد" <layla@fabrikam.test>`,
		subject: "ملاحظات حول خطة الإطلاق",
		html: `<p>مرحباً،</p><p>شكراً على الاجتماع أمس. هذه ملاحظاتي على خطة الإطلاق:</p><ul><li>يبدأ الإصدار التجريبي يوم الاثنين.</li><li>نحتاج إلى جولة قصيرة تشرح Kite للمستخدمين الجدد.</li><li>سأرسل التقرير الكامل غداً.</li></ul><p>مع تحياتي،<br>ليلى</p>`,
	},
	{
		from: `"דנה לוי" <dana@contoso.test>`,
		subject: "סיכום פגישת התכנון",
		html: `<p>שלום,</p><p>תודה על הפגישה אתמול. הסיכום והצעדים הבאים מצורפים כאן, ונשמח לשמוע אם משהו חסר.</p><p>דנה</p>`,
	},
];

/** Invented Arabic mail with an Arabic-named attachment, for the changelog shot of attachment names. */
export const RTL_ATTACHMENT_MAIL = {
	from: `"ليلى حداد" <layla@fabrikam.test>`,
	subject: "فاتورة شهر نوفمبر",
	html: `<p>مرحباً،</p><p>تجدون الفاتورة مرفقة بهذه الرسالة.</p><p>ليلى</p>`,
	attachments: [
		{
			// RFC 2047, as mail clients send a name that is not ASCII.
			filename: `=?UTF-8?B?${Buffer.from("فاتورة نوفمبر.txt").toString("base64")}?=`,
			contentType: "text/plain; charset=utf-8",
			content: "Invoice 2026-11",
		},
	],
};

/** A message with three attachments, for the "Download all" shots; the second one with a program among them. */
export const ATTACHMENTS_ZIP_MAIL = {
	from: `"Priya Raman" <priya@acme.test>`,
	subject: "Q3 board pack",
	html: `<p>Hi,</p><p>The board pack for Thursday is attached: the slides, the budget and the minutes.</p><p>Priya</p>`,
	attachments: [
		{ filename: "Q3 slides.pdf", contentType: "application/pdf", content: "%PDF-1.7 demo slides" },
		{ filename: "Budget 2027.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: "demo budget" },
		{ filename: "Minutes.txt", contentType: "text/plain", content: "Demo minutes" },
	],
};
export const ATTACHMENTS_ZIP_FLAGGED_MAIL = {
	from: `"Tom Okafor" <tom@adventure-works.test>`,
	subject: "Installer and notes",
	html: `<p>Here is the installer we talked about, and my notes.</p><p>Tom</p>`,
	attachments: [
		{ filename: "setup.exe", contentType: "application/octet-stream", content: "MZ demo installer" },
		{ filename: "notes.txt", contentType: "text/plain", content: "Demo notes" },
	],
};

/** A message in Thai and what the translation shot shows for it, with the same markup. */
export const THAI_MAIL = {
	from: `"สมชาย ใจดี" <somchai@wingtip.test>`,
	subject: "แผนการเดินทางเดือนหน้า",
	html: `<p>สวัสดีครับ</p><p>ขอบคุณสำหรับการประชุมเมื่อวานนี้ นี่คือสิ่งที่เราตกลงกันไว้:</p><ul><li>ทีมของเราจะไปถึงกรุงเทพฯ ในวันจันทร์</li><li>โปรดส่งเอกสารให้เราก่อนวันศุกร์</li></ul><p>ด้วยความเคารพ<br>สมชาย</p>`,
};
export const THAI_MAIL_TRANSLATED = {
	subject: "Travel plans for next month",
	html: `<p>Hello,</p><p>Thank you for yesterday's meeting. This is what we agreed:</p><ul><li>Our team arrives in Bangkok on Monday.</li><li>Please send us the documents before Friday.</li></ul><p>With respect,<br>Somchai</p>`,
};

/** A message whose sender fails SPF, DKIM and DMARC, for the sender authentication warning shot. */
export const SENDER_AUTH_MAIL = {
	from: `"Billing" <billing@northwind-invoices.test>`,
	subject: "Your December invoice",
	html: `<p>Hello,</p><p>Your invoice for December is attached. Thanks for your business.</p>`,
};

/** Delivers the right-to-left demo mail once, so the shot finds it in the Inbox. */
export async function seedRtlMail(): Promise<void> {
	await deliverOnce(RTL_MAIL);
}

export async function seedRtlAttachmentMail(): Promise<void> {
	await deliverOnce([RTL_ATTACHMENT_MAIL]);
}

/** Delivers the "Download all" demo mails once. */
export async function seedAttachmentsZipMail(): Promise<void> {
	await deliverOnce([ATTACHMENTS_ZIP_MAIL, ATTACHMENTS_ZIP_FLAGGED_MAIL]);
}

/** Delivers the sender authentication demo mail once, with headers that fail every check. */
export async function seedSenderAuthDemo(): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	const found = await api.get(`/api/messages?${new URLSearchParams({ q: SENDER_AUTH_MAIL.subject, limit: "20" })}`);
	const { messages: existing } = (await found.json()) as { messages: { subject?: string }[] };
	if (!existing.some((message) => message.subject === SENDER_AUTH_MAIL.subject)) {
		await postInbound(api, {
			...SENDER_AUTH_MAIL,
			to: `"Support" <${SUPPORT_ADDRESS}>`,
			text: plainText(SENDER_AUTH_MAIL.html),
			headers: {
				"Authentication-Results":
					"mx.cloudflare.net; spf=fail smtp.mailfrom=bounce@northwind-invoices.test; dkim=fail header.d=northwind-invoices.test; dmarc=fail header.from=northwind-invoices.test policy.dmarc=none",
			},
		});
		await waitForMessage(api, SENDER_AUTH_MAIL.subject);
	}
	await api.dispose();
}

/** Delivers the Thai demo mail once. */
export async function seedThaiMail(): Promise<void> {
	await deliverOnce([THAI_MAIL]);
}

async function deliverOnce(
	mails: readonly { from: string; subject: string; html: string; attachments?: InboundAttachment[] }[],
): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	for (const mail of mails) {
		const found = await api.get(`/api/messages?${new URLSearchParams({ q: mail.subject, limit: "20" })}`);
		const { messages: existing } = (await found.json()) as { messages: { subject?: string }[] };
		if (existing.some((message) => message.subject === mail.subject)) continue;
		await postInbound(api, { ...mail, to: `"Support" <${SUPPORT_ADDRESS}>`, text: plainText(mail.html) });
		await waitForMessage(api, mail.subject);
	}
	await api.dispose();
}

/** Posts the demo mail, shared mailboxes and calendar events into the isolated e2e server. */
export async function seedDemoData(): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	// A server kept across runs (E2E_REUSE_SERVER=1) already holds the demo data; seeding it twice would double it.
	const seeded = await api.get(`/api/messages?${new URLSearchParams({ q: THREAD[0]!.subject, limit: "1" })}`);
	expect(seeded.ok(), `Looking for earlier demo data failed: ${seeded.status()} ${await seeded.text()}`).toBe(true);
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

/** Delivers enough invented mail to fill a second Inbox page (the list holds 25 rows), once. */
export async function seedPagedMail(): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	const probe = await api.get(`/api/messages?${new URLSearchParams({ q: "Weekly digest 1", limit: "1" })}`);
	const { messages: existing } = (await probe.json()) as { messages: unknown[] };
	if (existing.length === 0) {
		for (let index = 1; index <= 24; index += 1) {
			const subject = `Weekly digest ${index}`;
			const html = `<p>Highlights from the Tailspin team for week ${index}: nothing needs your attention.</p>`;
			await postInbound(api, {
				from: `"Tailspin Digest" <digest@tailspin.test>`,
				to: `"Support" <${SUPPORT_ADDRESS}>`,
				subject,
				html,
				text: plainText(html),
			});
			await waitForMessage(api, subject);
		}
	}
	await api.dispose();
}

const PAID_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const daysBack = (days: number) => PAID_FORMAT.format(new Date(Date.now() - days * 86_400_000));
const authFor = (domain: string) => ({
	"Auto-Submitted": "auto-generated",
	"Authentication-Results": `mx.cloudflare.net; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
});

/** Invented receipts, invoices and a refund for the Money Watch Payments tab, in three currencies and two months. */
const PAYMENT_MAIL = [
	{
		from: "Stripe <receipts+acct_1DemoNw0000@stripe.com>",
		subject: "Your Northwind Studio receipt [#2214-0042]",
		text: `Northwind Studio\nReceipt #2214-0042\n\nAmount paid\n$500.00\n\nDate paid\n${daysBack(2)}\n\nSummary\nNorthwind Studio setup fee $500.00`,
		domain: "stripe.com",
		vendor: "Northwind Studio",
	},
	{
		from: "Fabrikam Hosting <invoices@fabrikam.test>",
		subject: "Invoice FH-2026-1107 from Fabrikam Hosting",
		text: `Amount due: €120.00\nInvoice date: ${daysBack(1)}\nPlease pay within 14 days.`,
		domain: "fabrikam.test",
		vendor: "Fabrikam Hosting",
	},
	{
		from: "Contoso Coffee <receipts@contoso.test>",
		subject: "Your receipt from Contoso Coffee #4471",
		text: `Amount paid: €18.40\nReceipt date: ${daysBack(3)}\nThanks for stopping by.`,
		domain: "contoso.test",
		vendor: "Contoso Coffee",
	},
	{
		from: "Wingtip Toys <support@wingtip.test>",
		subject: "Your refund has been issued",
		text: `We refunded €35.00 to your card for order #WT-4821.\nRefund date: ${daysBack(4)}`,
		domain: "wingtip.test",
		vendor: "Wingtip Toys",
	},
	{
		from: "Adventure Works <billing@adventure-works.test>",
		subject: "Payment received, receipt AW-77812",
		text: `Amount paid: £42.00\nDate paid: ${daysBack(36)}\nThank you for your payment.`,
		domain: "adventure-works.test",
		vendor: "Adventure Works",
	},
	{
		from: "Litware Print <invoices@litware.test>",
		subject: "Receipt LP-30981 for your print order",
		text: `Total paid: €64.90\nDate paid: ${daysBack(40)}\nOrder LP-30981, 250 business cards.`,
		domain: "litware.test",
		vendor: "Litware Print",
	},
] as const;

/**
 * The Payments tab's demo rows: automatic reading on for the support mailbox, then each invented receipt that is not
 * there yet delivered to it, and a wait until every fixture's vendor is listed, so unrelated rows never stand in.
 */
export async function seedPaymentsDemo(): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string }[];
	};
	const support = mailboxes.find((box) => box.localPart === "support") ?? mailboxes[0]!;
	await api.put("/api/agent/settings", { data: { mailboxId: support.id, autonomy: "suggest" } });
	const vendors = async () =>
		new Set(
			((await (await api.get("/api/finance/payments")).json()) as { payments?: { vendor: string }[] }).payments?.map(
				(row) => row.vendor,
			) ?? [],
		);
	const listed = await vendors();
	for (const { domain, vendor, ...mail } of PAYMENT_MAIL) {
		if (listed.has(vendor)) continue;
		await postInbound(api, { ...mail, to: SUPPORT_ADDRESS, headers: authFor(domain) });
		await waitForMessage(api, mail.subject);
	}
	await expect
		.poll(async () => {
			const now = await vendors();
			return PAYMENT_MAIL.every((mail) => now.has(mail.vendor));
		}, { timeout: 120_000 })
		.toBe(true);
}
