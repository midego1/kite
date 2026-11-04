import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomInt } from "node:crypto";
import { DOMAIN, STORAGE_STATE } from "./constants";
import { useFakeProvider as pointAssistantAtFake } from "./agent";
import { CALENDAR_TOOLS, chatRequests } from "./chat";
import { startFakeModel } from "./fake-model";
import { type FakeModel } from "./fake-model-types";
import { apiContext } from "./helpers";
import { turnScreenerOff } from "./screener";

export async function owner(): Promise<APIRequestContext> {
	return apiContext(STORAGE_STATE);
}

export async function ownerBooking(api: APIRequestContext): Promise<{ id: string; username: string }> {
	const me = await (await api.get("/api/auth/me")).json();
	const booking = await (await api.get("/api/booking")).json();
	return { id: me.user.id, username: booking.username };
}

/** A visitor with no session, which is what a person following a public booking link is. */
export async function visitor(): Promise<APIRequestContext> {
	return apiContext();
}

export const MEMBER_PASSWORD = "module-member-password-123";

/** A regular account with its own mailbox, signed in on a separate API client. */
export async function createMember(admin: APIRequestContext, role: "user" | "admin" = "user") {
	const username = `${role === "admin" ? "adminb" : "member"}${Date.now()}${randomInt(1000)}`;
	const { domains } = await (await admin.get("/api/domains")).json();
	const created = await admin.post("/api/accounts", {
		data: {
			username,
			domainId: domains.find((item: { hostname: string }) => item.hostname === DOMAIN).id,
			password: MEMBER_PASSWORD,
			role,
			useAllDomains: true,
		},
	});
	expect(created.ok(), await created.text()).toBe(true);
	const id = (await created.json()).account.id as string;
	const email = `${username}@${DOMAIN}`;
	const api = await apiContext();
	const login = await api.post("/api/auth/login", { data: { email, password: MEMBER_PASSWORD } });
	expect(login.ok(), await login.text()).toBe(true);
	await turnScreenerOff(api);
	return { id, email, api };
}

export const moduleSection = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

export const moduleSwitch = (page: Page, name: string) => moduleSection(page, name).getByRole("switch");

export async function moduleAccessCleanup(members: { api: APIRequestContext }[]) {
	await Promise.all(members.map((member) => member.api.dispose()));
}

/** Starts a fake model, points the assistant at it and returns what each chat test needs, with its cleanup. */
export async function fakeAssistant(api: APIRequestContext) {
	const fake = await startFakeModel();
	let restore: (() => Promise<void>) | null = null;
	try {
		restore = await pointAssistantAtFake(api, fake);
	} catch (error) {
		await fake.close();
		throw error;
	}
	return {
		fake,
		cleanup: async () => {
			await restore?.();
			await fake.close();
		},
	};
}

export async function lastChatRequest(fake: FakeModel) {
	const requests = chatRequests(fake);
	expect(requests.length).toBeGreaterThan(0);
	return requests[requests.length - 1];
}

export const CALENDAR_MCP_TOOLS = [...CALENDAR_TOOLS].sort();

export const CALENDAR_SCOPES = ["mcp:calendar-read", "mcp:calendar-write"];

/** Deletes the keys a test created, whichever way they were made. */
export async function deleteKeys(api: APIRequestContext, ids: { mcp?: string[]; api?: string[] }) {
	for (const id of ids.mcp ?? []) await api.delete(`/api/agent/mcp-keys?id=${encodeURIComponent(id)}`);
	for (const id of ids.api ?? []) await api.delete(`/api/api-keys?id=${encodeURIComponent(id)}`);
}

export const CALENDAR_EVENTS = ["calendar.event.created", "calendar.event.updated", "calendar.event.deleted"];

export const FINANCE_EVENTS = ["finance.subscription.detected", "finance.subscription.renewal_due"];

export type SearchSection = {
	id: string;
	label: string;
	items: { ref: { kind: string; id: string }; label: string; sublabel: string; href: string }[];
};

export async function searchSections(api: APIRequestContext, query: string, extra = ""): Promise<SearchSection[]> {
	const response = await api.get(`/api/search?q=${encodeURIComponent(query)}${extra}`);
	expect(response.status(), await response.text()).toBe(200);
	return ((await response.json()) as { sections: SearchSection[] }).sections;
}

export async function createEvent(api: APIRequestContext, title: string, extra: Record<string, unknown> = {}) {
	const created = await api.post("/api/calendar/events", {
		data: { title, startsAt: "2031-05-05T10:00:00Z", endsAt: "2031-05-05T11:00:00Z", ...extra },
	});
	expect(created.status(), await created.text()).toBeLessThan(300);
	return ((await created.json()) as { event: { id: string } }).event.id;
}

export async function createTemplate(api: APIRequestContext, title: string, text: string): Promise<string> {
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; senderAddresses: string[] }[];
	};
	const created = await api.post("/api/templates", {
		data: { mailboxId: mailboxes[0].id, from: mailboxes[0].senderAddresses[0], title, text, html: `<p>${text}</p>` },
	});
	expect(created.status(), await created.text()).toBe(201);
	return ((await created.json()) as { template: { id: string } }).template.id;
}

export async function openSendMenu(page: Page) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	await page.getByRole("button", { name: "Schedule send options" }).click();
	const menu = page.getByRole("menu");
	await expect(menu.getByText("Schedule", { exact: true })).toBeVisible();
	return menu;
}

export async function templateStatusRows(api: APIRequestContext): Promise<{ id: string }[]> {
	const response = await api.get("/api/messages?status=template");
	expect(response.status(), await response.text()).toBe(200);
	return ((await response.json()) as { messages: { id: string }[] }).messages;
}

export async function expectLink(scope: Locator, name: string, on: boolean) {
	const link = scope.getByRole("link", { name, exact: true });
	if (on) await expect(link, name).toBeVisible();
	else await expect(link, name).toHaveCount(0);
}
