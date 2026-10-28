import type { Page } from "@playwright/test";
import { SUPPORT_ADDRESS } from "../../e2e/support/constants";

// Network-level stand-ins for the parts of the README shots that need a model or weeks of history: what the
// assistant said, what automatic reading suggested and what AI usage recorded. Everything else on screen is the
// real app over the seeded e2e database. All names are invented (.test and example.com are reserved).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ago(milliseconds: number): string {
	return new Date(Date.now() - milliseconds).toISOString();
}

/** The Kite AI panel on, with one earlier chat that drafted a reply to Lena for review. */
export async function mockAssistant(page: Page): Promise<void> {
	await page.route("**/api/agent/availability", (route) => route.fulfill({ json: { enabled: true } }));
	await page.route("**/api/agent/settings?*", (route) =>
		route.fulfill({
			json: {
				settings: {
					mailboxId: "demo",
					enabled: true,
					modelId: "demo",
					autoDraftEnabled: false,
					reviewerUserId: null,
					instructions: "",
					dailyLimit: 200,
				},
				models: ["demo"],
				canManage: true,
				providerConfigured: true,
				autoReplyEnabled: false,
				reviewers: [],
			},
		}),
	);
	await page.route("**/api/agent/jobs?*", (route) => route.fulfill({ json: { jobs: [] } }));
	await page.route("**/api/agent/conversations?*", (route) =>
		route.fulfill({
			json: {
				conversations: [
					{ id: "demo-reply", title: "Replying to Lena" },
					{ id: "demo-week", title: "What is on my plate this week?" },
				],
			},
		}),
	);
	await page.route("**/api/agent/conversations/demo-reply?*", (route) =>
		route.fulfill({
			json: {
				messages: [
					{
						id: "user-1",
						role: "user",
						content:
							"Lena asked to pair on the welcome email. Say thanks for the notes, that I like the hello@ and support@ idea, and ask if Thursday afternoon works.",
					},
					{
						id: "draft-tool",
						role: "tool",
						toolName: "draft_reply",
						content: JSON.stringify({ draftId: "demo-draft", revision: 1, status: "draft_created" }),
					},
					{
						id: "assistant-1",
						role: "assistant",
						content:
							"Here is a draft reply to Lena. It is saved as a draft: nothing is sent until you approve it, and you can edit it first.",
					},
				],
			},
		}),
	);
	await page.route("**/api/drafts/demo-draft", (route) =>
		route.fulfill({
			json: {
				draft: {
					id: "demo-draft",
					mailboxId: null,
					fromAddr: SUPPORT_ADDRESS,
					toAddr: "lena@contoso.test",
					subject: "Re: Design review notes for the new onboarding flow",
					textBody:
						"Hi Lena,\n\nThanks for the notes. Suggesting hello@ and support@ in the mailbox step is a great idea, I'll add it. Does Thursday afternoon work to pair on the welcome email?\n\nBest,\nDemo",
					htmlBody: null,
				},
			},
		}),
	);
}

type DemoSuggestion = {
	kind: "phishing" | "reply" | "calendar_invite" | "subscription";
	title: string;
	subject: string;
	from: string;
	hoursAgo: number;
};

const SUGGESTIONS: DemoSuggestion[] = [
	{
		kind: "phishing",
		title: "The link goes to a different site than it shows, and the sender failed its checks",
		subject: "Action required: verify your Wingtip account",
		from: "Wingtip Security <no-reply@wingtip-verify.test>",
		hoursAgo: 2,
	},
	{
		kind: "reply",
		title: "Draft reply ready: confirm Thursday afternoon to pair on the welcome email",
		subject: "Design review notes for the new onboarding flow",
		from: "Lena Fischer <lena@contoso.test>",
		hoursAgo: 3,
	},
	{
		kind: "reply",
		title: "Draft reply ready: book travel before Friday",
		subject: "Offsite agenda and travel details",
		from: "Tom Okafor <tom@adventure-works.test>",
		hoursAgo: 20,
	},
	{
		kind: "calendar_invite",
		title: "Offsite planning, Thursday 10:00 to 11:30. You are free then.",
		subject: "Invitation: Offsite planning",
		from: "Tom Okafor <tom@adventure-works.test>",
		hoursAgo: 5,
	},
	{
		kind: "subscription",
		title: "Fabrikam Cloud, €240.00 a month, next charge 1 November",
		subject: "Your October invoice is ready",
		from: "Fabrikam Billing <invoices@fabrikam.test>",
		hoursAgo: 26,
	},
];

/** Automatic reading on for the shared mailbox, with a short list for the For you page and its sidebar count. */
export async function mockForYou(page: Page): Promise<void> {
	const { mailboxes } = (await (await page.request.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; address?: string; email?: string }[];
	};
	const mailbox = mailboxes.find((item) => (item.address ?? item.email) === SUPPORT_ADDRESS) ?? mailboxes[0]!;
	const suggestions = SUGGESTIONS.map((item, index) => ({
		id: `demo-suggestion-${index}`,
		mailboxId: mailbox.id,
		messageId: `demo-message-${index}`,
		kind: item.kind,
		title: item.title,
		createdAt: ago(item.hoursAgo * HOUR),
		message: { subject: item.subject, from: item.from },
		messageRef: { kind: "mail:message", id: `demo-message-${index}` },
		messageTarget: { href: "/inbox", label: item.subject },
	}));
	const kindTotals: Record<string, number> = {};
	for (const item of suggestions) kindTotals[item.kind] = (kindTotals[item.kind] ?? 0) + 1;
	await page.route("**/api/agent/suggestions?status=open", (route) =>
		route.fulfill({
			json: {
				suggestions,
				total: suggestions.length,
				kindTotals,
				mailboxes: [{ id: mailbox.id, address: SUPPORT_ADDRESS, autonomy: "suggest" }],
			},
		}),
	);
}

const USAGE_MODELS = [
	{ provider: "anthropic", model: "claude-sonnet-5-5", source: "chat", input: 5400, output: 380, cost: 21_900 },
	{ provider: "anthropic", model: "claude-haiku-4-5", source: "triage", input: 1900, output: 140, cost: 2_600 },
	{ provider: "openai", model: "gpt-4.1-mini", source: "summary", input: 3100, output: 220, cost: 2_100 },
];

/** Two weeks of requests, a few a day, so the chart and the table have something believable to show. */
export async function mockAiUsage(page: Page): Promise<void> {
	const daily = Array.from({ length: 14 }, (_, index) => {
		const day = new Date(Date.now() - (13 - index) * DAY);
		const requests = [14, 22, 18, 9, 4, 26, 31, 24, 19, 12, 5, 29, 34, 21][index]!;
		return {
			date: day.toISOString().slice(0, 10),
			requests,
			inputTokens: requests * 3400,
			outputTokens: requests * 240,
		};
	});
	const rows = Array.from({ length: 12 }, (_, index) => {
		const entry = USAGE_MODELS[index % USAGE_MODELS.length]!;
		const jitter = 1 + ((index * 7) % 5) / 10;
		return {
			id: `usage-${index}`,
			createdAt: ago(index * 47 * 60_000 + 12 * 60_000),
			provider: entry.provider,
			model: entry.model,
			source: entry.source,
			inputTokens: Math.round(entry.input * jitter),
			outputTokens: Math.round(entry.output * jitter),
			costUsdMicros: Math.round(entry.cost * jitter),
		};
	});
	const requests = daily.reduce((sum, day) => sum + day.requests, 0);
	const inputTokens = daily.reduce((sum, day) => sum + day.inputTokens, 0);
	const outputTokens = daily.reduce((sum, day) => sum + day.outputTokens, 0);
	await page.route("**/api/admin/ai-usage?*", (route) =>
		route.fulfill({
			json: {
				totals: {
					requests,
					inputTokens,
					outputTokens,
					totalTokens: inputTokens + outputTokens,
					costUsdMicros: Math.round(requests * 6_200),
					pricedRequests: requests,
				},
				daily,
				timeZone: "UTC",
				rows,
				page: 1,
				pageSize: 12,
				totalPages: 1,
			},
		}),
	);
}
