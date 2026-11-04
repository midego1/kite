import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { BASE_URL } from "./support/constants";
import { readAdminAgent } from "./support/agent";
import {
	CALENDAR_TOOLS,
	askAssistant,
	chatRequests,
	firstMailboxId,
	openAssistantPanel,
	openPageCommands,
	sendChat,
	systemPrompt,
	toolNames,
} from "./support/chat";
import { type FakeModel } from "./support/fake-model-types";
import { postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { createSignedInAccount, okJson, selectMailbox } from "./support/auto-read";
import { futureAt, inviteAttachment } from "./support/invites";
import { readSuggestions, waitForFinishedJob } from "./support/triage";
import { restoreModules, setModuleState } from "./support/modules";
import { createMember, fakeAssistant, lastChatRequest, moduleAccessCleanup, owner } from "./support/module-spec";

const CALENDAR_PROMPT = "Use calendar tools only for the user's personal calendar";

test.describe("assistant chat reads the module registry", () => {
	test("calendar tools, the calendar prompt and calendar pages follow the Calendar module, and core tools never leave", async () => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		try {
			const mailboxId = await firstMailboxId(api);
			const zone = "Europe/Amsterdam";
			const ask = async (text: string) => {
				fake.clearRequests();
				await sendChat(api, mailboxId, text);
				return lastChatRequest(fake);
			};

			const on = await ask("What is on today?");
			for (const name of [...CALENDAR_TOOLS, "list_emails", "search_emails", "open_page"])
				expect(toolNames(on), name).toContain(name);
			const everything = openPageCommands(on) ?? [];
			for (const id of [
				"calendar.open",
				"calendar.go_to_date",
				"booking.open",
				"booking.open_event_type",
				"import.open",
				"mail.export",
				"nav-inbox",
				"nav-settings",
			])
				expect(everything, id).toContain(id);
			for (const id of ["compose", "calendar.new_event", "booking.copy_link"]) expect(everything, id).not.toContain(id);
			const promptOn = systemPrompt(on);
			expect(promptOn).toContain("You are a helpful email assistant");
			expect(promptOn).toContain(CALENDAR_PROMPT);
			expect(promptOn).not.toMatch(/\{timeZone\}|\{today\}/);
			expect(promptOn).toContain(`Read relative dates in ${zone}`);
			expect(promptOn).toMatch(/today is \d{4}-\d{2}-\d{2}\./);

			await setModuleState(api, { modules: { calendar: false } });
			const off = await ask("What is on today?");
			for (const name of CALENDAR_TOOLS) expect(toolNames(off), name).not.toContain(name);
			for (const name of ["list_emails", "search_emails", "open_page"]) expect(toolNames(off), name).toContain(name);
			const enumOff = openPageCommands(off) ?? [];
			expect(enumOff.filter((id) => id.startsWith("calendar.") || id.startsWith("booking."))).toEqual([]);
			expect(enumOff).toContain("import.open");
			expect(enumOff).toContain("mail.export");
			const promptOff = systemPrompt(off);
			expect(promptOff).not.toContain(CALENDAR_PROMPT);
			expect(promptOff.toLowerCase()).not.toContain("calendar");
			expect(promptOff).toContain("You are a helpful email assistant");

			await setModuleState(api, { modules: { calendar: true } });
			const back = await ask("What is on today?");
			for (const name of CALENDAR_TOOLS) expect(toolNames(back), name).toContain(name);
			expect(systemPrompt(back)).toContain(CALENDAR_PROMPT);

			await setModuleState(api, { modules: { booking: false } });
			const bookingOff = openPageCommands(await ask("Where can I book?")) ?? [];
			expect(bookingOff).toContain("calendar.open");
			expect(bookingOff).toContain("calendar.go_to_date");
			expect(bookingOff.filter((id) => id.startsWith("booking."))).toEqual([]);
			await setModuleState(api, { modules: { booking: true } });

			await setModuleState(api, { modules: { import: false } });
			const importOff = openPageCommands(await ask("Where do I import?")) ?? [];
			expect(importOff).not.toContain("import.open");
			expect(importOff).toContain("mail.export");
			expect(importOff).toContain("calendar.open");
		} finally {
			await restoreModules(api);
			await cleanup();
			await api.dispose();
		}
	});

	test("a user restricted from Calendar gets no calendar tools, prompt or pages while the owner keeps them", async () => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		let restricted: string[] = [];
		try {
			const member = await createMember(api);
			restricted = [member.id];
			await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
			const ownerMailbox = await firstMailboxId(api);
			const memberMailbox = await firstMailboxId(member.api);

			fake.clearRequests();
			await sendChat(member.api, memberMailbox, "What is on today?");
			const theirs = await lastChatRequest(fake);
			for (const name of CALENDAR_TOOLS) expect(toolNames(theirs), name).not.toContain(name);
			expect(toolNames(theirs)).toEqual(expect.arrayContaining(["list_emails", "open_page"]));
			const theirPages = openPageCommands(theirs) ?? [];
			expect(theirPages.filter((id) => id.startsWith("calendar.") || id.startsWith("booking."))).toEqual([]);
			expect(theirPages).toContain("mail.export");
			expect(systemPrompt(theirs)).not.toContain(CALENDAR_PROMPT);

			fake.clearRequests();
			await sendChat(api, ownerMailbox, "What is on today?");
			const mine = await lastChatRequest(fake);
			for (const name of CALENDAR_TOOLS) expect(toolNames(mine), name).toContain(name);
			expect(openPageCommands(mine)).toContain("calendar.open");
			expect(systemPrompt(mine)).toContain(CALENDAR_PROMPT);
			await moduleAccessCleanup([member]);
		} finally {
			await restoreModules(api, restricted);
			await cleanup();
			await api.dispose();
		}
	});

	test("open_page shows a clickable same-origin link, navigates nothing by itself and the link opens the page", async ({
		page,
	}) => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		try {
			await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
			const panel = await openAssistantPanel(page);
			const links = panel.locator("a[data-agent-tool-link]");

			fake.scriptChat(
				{ toolCalls: [{ name: "open_page", arguments: { command: "calendar.open" } }] },
				{ content: "Here is your calendar." },
			);
			const before = page.url();
			await askAssistant(page, "Open my calendar");
			await expect(panel.getByText("Here is your calendar.")).toBeVisible();
			await expect(links).toHaveCount(1);
			await expect(links.first()).toHaveAttribute("href", "/calendar");
			await expect(links.first()).toHaveText("Open Calendar");
			expect(page.url()).toBe(before);
			await page.screenshot({ path: test.info().outputPath("open-page-link.png") });
			await links.first().click();
			await expect(page).toHaveURL(/\/calendar$/);

			fake.scriptChat(
				{
					toolCalls: [
						{ name: "open_page", arguments: { command: "calendar.go_to_date", params: { date: "2026-11-03" } } },
					],
				},
				{ content: "Opened that day." },
			);
			const second = await openAssistantPanel(page);
			await askAssistant(page, "Show 3 November");
			await expect(second.getByText("Opened that day.")).toBeVisible();
			const dateLink = second.locator("a[data-agent-tool-link]").last();
			await expect(dateLink).toHaveAttribute("href", "/calendar?date=2026-11-03");
			await dateLink.click();
			await expect(page).toHaveURL(/\/calendar\?date=2026-11-03/);
			for (const href of await second
				.locator("a")
				.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")))) {
				if (href) expect(href.startsWith("/") && !href.startsWith("//"), href).toBe(true);
			}
		} finally {
			await restoreModules(api);
			await cleanup();
			await api.dispose();
		}
	});

	test("open_page refuses unknown and disabled ids, invalid params and arbitrary URLs, and no link appears", async ({
		page,
	}) => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		try {
			const mailboxId = await firstMailboxId(api);
			const refused = [
				{ command: "https://evil.example/x" },
				{ command: "//evil.example" },
				{ command: "no.such.command" },
				{ command: "calendar.go_to_date", params: { date: "not-a-date" } },
				{ command: "calendar.go_to_date", params: { date: "2026-11-03", href: "//evil.example" } },
				{ command: "calendar.open", params: { next: "https://evil.example" } },
			];
			const callAll = (calls: object[]) =>
				fake.scriptChat(
					{ toolCalls: calls.map((arguments_) => ({ name: "open_page", arguments: arguments_ })) },
					{ content: "I could not open that." },
				);

			callAll(refused);
			const events = await sendChat(api, mailboxId, "Open these pages");
			const results = events.filter((event) => event.type === "tool" && event.state !== "running");
			expect(results).toHaveLength(refused.length);
			for (const result of results) {
				expect(result.state).toBe("failed");
				expect(JSON.stringify(result.result)).not.toContain("evil.example/x");
			}
			expect(events.some((event) => event.type === "text" && event.text === "I could not open that.")).toBe(true);

			await setModuleState(api, { modules: { calendar: false } });
			callAll([{ command: "calendar.open" }, { command: "booking.open" }]);
			const disabled = await sendChat(api, mailboxId, "Open the calendar");
			const disabledResults = disabled.filter((event) => event.type === "tool" && event.state !== "running");
			expect(disabledResults).toHaveLength(2);
			for (const result of disabledResults) expect(result.state).toBe("failed");
			await setModuleState(api, { modules: { calendar: true } });

			await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
			const panel = await openAssistantPanel(page);
			callAll(refused);
			await askAssistant(page, "Open these pages");
			await expect(panel.getByText("I could not open that.")).toBeVisible();
			await expect(panel.locator("a[data-agent-tool-link]")).toHaveCount(0);
			for (const href of await panel
				.locator("a")
				.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")))) {
				if (href) expect(href.startsWith("/") && !href.startsWith("//"), href).toBe(true);
			}
		} finally {
			await restoreModules(api);
			await cleanup();
			await api.dispose();
		}
	});

	test("a scripted create_event result carries the event ref and the chat links it to the event", async ({ page }) => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		let eventId: string | null = null;
		try {
			await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
			const panel = await openAssistantPanel(page);
			const title = `Ref check ${Date.now()}`;
			fake.scriptChat(
				{
					toolCalls: [
						{
							name: "create_event",
							arguments: { title, startsAt: "2026-11-03T10:00:00Z", endsAt: "2026-11-03T11:00:00Z", timeZone: "UTC" },
						},
					],
				},
				{ content: "The event is on your calendar." },
			);
			await askAssistant(page, "Add a meeting on 3 November");
			await expect(panel.getByText("The event is on your calendar.")).toBeVisible();
			const link = panel.locator("a[data-agent-tool-link]").first();
			await expect(link).toHaveText(title);
			const href = (await link.getAttribute("href")) ?? "";
			expect(href).toMatch(/^\/calendar\?date=\d{4}-\d{2}-\d{2}&event=evt_[\w-]+$/);
			eventId = new URL(href, "http://x").searchParams.get("event");
			await page.screenshot({ path: test.info().outputPath("create-event-ref.png") });

			const secondRequest = chatRequests(fake).at(-1);
			const toolMessages = (
				(secondRequest?.body as { messages: { role: string; content: unknown }[] }).messages ?? []
			).filter((message) => message.role === "tool");
			expect(toolMessages).toHaveLength(1);
			expect(JSON.parse(String(toolMessages[0].content))).toMatchObject({
				status: "created",
				ref: { kind: "calendar:event", id: eventId },
			});
			for (const href of await panel
				.locator("a")
				.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")))) {
				if (href) expect(href.startsWith("/") && !href.startsWith("//"), href).toBe(true);
			}

			await setModuleState(api, { modules: { calendar: false } });
			await page.reload();
			await page.getByRole("button", { name: /^(Open|Close) email assistant$/ }).waitFor();
		} finally {
			await restoreModules(api);
			if (eventId) await api.delete(`/api/calendar/events/${eventId}`);
			await cleanup();
			await api.dispose();
		}
	});
});

test("automatic reading requests carry no tools, UI commands or open_page, with Calendar on and off", async () => {
	const api = await owner();
	const { fake, cleanup } = await fakeAssistant(api);
	let memberApi: APIRequestContext | null = null;
	try {
		const member = await createMember(api);
		memberApi = member.api;
		const { mailboxes } = (await (await member.api.get("/api/mailboxes")).json()) as {
			mailboxes: { id: string; localPart: string }[];
		};
		const mailboxId = mailboxes.find((item) => item.localPart === member.email.split("@")[0])!.id;
		const saved = await member.api.put("/api/agent/settings", { data: { mailboxId, autonomy: "suggest" } });
		expect(saved.ok(), await saved.text()).toBe(true);
		const commandIds = (openPageCommands(await lastChatRequestAfterChat(api, fake)) ?? []).filter((id) =>
			id.includes("."),
		);
		expect(commandIds.length).toBeGreaterThan(3);

		for (const calendar of [true, false]) {
			await setModuleState(api, { modules: { calendar } });
			const token = uniqueToken(calendar ? "autoon" : "autooff");
			await postInbound(member.api, {
				from: "Customer <customer@outside.test>",
				to: member.email,
				subject: token,
				text: `Can you confirm ${token}? [[scenario:question]]`,
			});
			const message = await waitForMessage(member.api, token, { status: "received" });
			const job = await waitForFinishedJob(member.api, mailboxId, message.id, "triage");
			expect(job.status).toBe("completed");
			const mine = fake.requests().filter((request) => JSON.stringify(request.body).includes(token));
			expect(new Set(mine.map((request) => request.kind)).has("triage")).toBe(true);
			for (const request of mine) {
				expect(["triage", "repair", "draft"], String(request.kind)).toContain(request.kind);
				expect(request.tools, String(request.kind)).toEqual([]);
				expect(request.body).not.toHaveProperty("tools");
				const prompt = systemPrompt(request);
				expect(prompt).not.toContain("open_page");
				for (const id of commandIds) expect(prompt, id).not.toContain(id);
			}
		}
	} finally {
		await restoreModules(api);
		await memberApi?.dispose();
		await cleanup();
		await api.dispose();
	}
});

async function lastChatRequestAfterChat(api: APIRequestContext, fake: FakeModel) {
	fake.clearRequests();
	await sendChat(api, await firstMailboxId(api), "Hello");
	return lastChatRequest(fake);
}

test("assistant controls answer the same with Calendar on and off and gain no module fields", async () => {
	const api = await owner();
	const { fake, cleanup } = await fakeAssistant(api);
	try {
		const mailboxId = await firstMailboxId(api);
		const seen: { admin: string[]; mailbox: string[]; capabilities: string[] }[] = [];
		for (const calendar of [true, false]) {
			await setModuleState(api, { modules: { calendar } });
			const admin = await readAdminAgent(api);
			const mailbox = (await (await api.get(`/api/agent/settings?mailboxId=${mailboxId}`)).json()) as {
				settings: { capabilities: Record<string, unknown> } & Record<string, unknown>;
			};
			seen.push({
				admin: Object.keys(admin).sort(),
				mailbox: Object.keys(mailbox.settings).sort(),
				capabilities: Object.keys(mailbox.settings.capabilities).sort(),
			});
			expect(admin.dailySpendCapMicros).toBeGreaterThan(0);

			for (const autonomy of ["act", "auto"]) {
				const refused = await api.put("/api/agent/settings", { data: { mailboxId, autonomy } });
				expect(refused.status(), autonomy).toBe(400);
			}
			for (const autonomy of ["suggest", "off"]) {
				const saved = await api.put("/api/agent/settings", { data: { mailboxId, autonomy } });
				expect(saved.status(), autonomy).toBe(200);
			}

			const answered = await sendChat(api, mailboxId, "Hello");
			expect(answered.some((event) => event.type === "text" || event.type === "done")).toBe(true);
			const off = await api.put("/api/admin/agent", { data: { enabled: false } });
			expect(off.ok(), await off.text()).toBe(true);
			const refusal = await api.post("/api/agent/chat", { data: { mailboxId, text: "Hello" } });
			expect(refusal.status()).toBe(403);
			expect(await refusal.json()).toMatchObject({ code: "assistant_off" });
			const on = await api.put("/api/admin/agent", { data: { enabled: true } });
			expect(on.ok(), await on.text()).toBe(true);
		}
		expect(seen[1]).toEqual(seen[0]);
		expect(fake.requests().length).toBeGreaterThan(0);
	} finally {
		await restoreModules(api);
		await cleanup();
		await api.dispose();
	}
});

test("a calendar invitation suggestion is hidden while Calendar is off, no new one is made, and it returns when Calendar is on", async ({
	browser,
}) => {
	const api = await owner();
	const contexts: BrowserContext[] = [];
	const { cleanup } = await fakeAssistant(api);
	const account = await createSignedInAccount(api, `invoff${uniqueToken("")}`);
	try {
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
		);
		const address = `${(await (await account.api.get("/api/auth/me")).json()).user.email}`;
		const deliver = async (label: string) => {
			const subject = uniqueToken(label);
			await postInbound(account.api, {
				from: "Alice <alice@partner.test>",
				to: address,
				subject,
				text: "Please join.",
				attachments: [
					inviteAttachment({ uid: `${uniqueToken("uid")}@partner.test`, start: futureAt(20, 10), summary: "Planning" }),
				],
			});
			const message = await waitForMessage(account.api, subject, { status: "received" });
			const job = await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
			return { message, job, subject };
		};
		const invitesOf = async (messageId: string) =>
			(await readSuggestions(account.api, { mailboxId: account.mailboxId, messageId })).suggestions.filter(
				(item) => item.kind === "calendar_invite",
			);
		const rowKinds = async (subject: string) => {
			const { messages } = await okJson<{
				messages: { subject: string; agentSuggestions?: { kind: string }[] }[];
			}>(await account.api.get(`/api/messages?mailboxId=${account.mailboxId}&q=${encodeURIComponent(subject)}`));
			return (messages.find((item) => item.subject === subject)?.agentSuggestions ?? []).map((item) => item.kind);
		};

		const first = await deliver("invon");
		expect(first.job.status).toBe("completed");
		expect(first.job.reason).toBeNull();
		const [invite] = await invitesOf(first.message.id);
		expect(invite).toBeDefined();
		expect(await rowKinds(first.subject)).toContain("calendar_invite");

		await setModuleState(api, { modules: { calendar: false } });
		expect(await invitesOf(first.message.id)).toEqual([]);
		expect(await rowKinds(first.subject)).not.toContain("calendar_invite");
		const refused = await account.api.post(`/api/agent/suggestions/${invite.id}/accept`, {
			data: { option: "accept" },
		});
		expect(refused.status()).toBe(409);
		expect(await refused.json()).toMatchObject({ code: "module_disabled" });

		const second = await deliver("invoff");
		expect(second.job.status).toBe("completed");
		expect(second.job.reason).toBe("module_disabled:calendar");
		expect(await invitesOf(second.message.id)).toEqual([]);

		const activity = await okJson<{ skippedJobs: { reason: string | null }[] }>(
			await account.api.get(`/api/agent/actions?mailboxId=${account.mailboxId}`),
		);
		expect(activity.skippedJobs.map((job) => job.reason)).toContain("module_disabled:calendar");

		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		contexts.push(context);
		const page = await context.newPage();
		await selectMailbox(page, account.mailboxId);
		await page.goto("/kite-activity");
		const skipped = page.locator(`[data-activity-skipped="${second.job.id}"]`);
		await expect(skipped).toContainText("Calendar is turned off");
		await expect(page.locator("[data-agent-activity]")).not.toContainText("module_disabled");
		await page.goto("/for-you");
		await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
		await expect(page.getByText("Invitations", { exact: true })).toHaveCount(0);

		await setModuleState(api, { modules: { calendar: true } });
		expect((await invitesOf(first.message.id)).map((item) => item.id)).toEqual([invite.id]);
		expect(await rowKinds(first.subject)).toContain("calendar_invite");
		expect(await invitesOf(second.message.id)).toEqual([]);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
		await restoreModules(api);
		await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "off" } });
		await account.api.dispose();
		await cleanup();
		await api.dispose();
	}
});
