import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { FakeModel, FakeRecordedRequest } from "./fake-model-types";

export type ChatEvent = {
	type: string;
	name?: string;
	state?: string;
	result?: unknown;
	text?: string;
	message?: string;
};

export const CALENDAR_TOOLS = [
	"get_calendars",
	"get_schedule",
	"search_events",
	"find_free_time",
	"get_event",
	"create_event",
	"update_events",
	"delete_events",
];

/** Sends one chat message through the API, as the assistant panel does, and returns the NDJSON events. */
export async function sendChat(
	api: APIRequestContext,
	mailboxId: string,
	text: string,
	timeZone = "Europe/Amsterdam",
): Promise<ChatEvent[]> {
	const response = await api.post("/api/agent/chat", {
		data: { mailboxId, text },
		headers: { "X-Time-Zone": timeZone },
	});
	expect(response.ok(), await response.text()).toBe(true);
	return (await response.text())
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ChatEvent);
}

export async function firstMailboxId(api: APIRequestContext): Promise<string> {
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	expect(mailboxes.length).toBeGreaterThan(0);
	return mailboxes[0].id;
}

/** The streamed chat requests the fake model received, oldest first. */
export function chatRequests(fake: FakeModel): FakeRecordedRequest[] {
	return fake.requests().filter((request) => request.path === "/chat/completions" && request.stream);
}

export const toolNames = (request: FakeRecordedRequest) => request.tools.map((tool) => tool.name);

/** The `command` enum of the `open_page` tool in a recorded request, or null when it was not offered. */
export function openPageCommands(request: FakeRecordedRequest): string[] | null {
	const tool = request.tools.find((item) => item.name === "open_page");
	const parameters = tool?.parameters as { properties?: { command?: { enum?: string[] } } } | undefined;
	return parameters?.properties?.command?.enum ?? null;
}

export function systemPrompt(request: FakeRecordedRequest): string {
	const messages = ((request.body as { messages?: { role?: string; content?: unknown }[] }).messages ?? []).filter(
		(message) => message.role === "system",
	);
	return messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
}

export async function openAssistantPanel(page: Page) {
	await page.goto("/inbox");
	const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
	await expect(toggle).toBeVisible();
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	const panel = page.getByRole("region", { name: "Email assistant" });
	await expect(panel.getByRole("textbox", { name: "Message Kite AI" })).toBeEnabled();
	return panel;
}

export async function askAssistant(page: Page, text: string) {
	const panel = page.getByRole("region", { name: "Email assistant" });
	await panel.getByRole("textbox", { name: "Message Kite AI" }).fill(text);
	await panel.getByRole("button", { name: "Send message", exact: true }).click();
}
