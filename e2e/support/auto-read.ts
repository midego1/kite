import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { DOMAIN } from "./constants";
import { apiSignIn } from "./helpers";

const ACCOUNT_PASSWORD = "auto-read-password-123";

export type MailboxSettingsBody = {
	settings: Record<string, unknown> & {
		autonomy: string;
		capabilities: Record<string, unknown> & { mutedSenders: string[] };
		triageModelId: string | null;
		autoReadDailyLimit: number;
		dailySpendCapMicros: number | null;
		pausedUntil: string | null;
	};
	canManage: boolean;
	autoReadAvailable: boolean;
	externalProviderBlocked: boolean;
	providerLabel: string;
};

export async function okJson<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function exampleDomainId(admin: APIRequestContext): Promise<string> {
	const { domains } = await okJson<{ domains: { id: string; hostname: string }[] }>(await admin.get("/api/domains"));
	const domain = domains.find((item) => item.hostname === DOMAIN);
	expect(domain).toBeDefined();
	return domain!.id;
}

/** Creates an account (with its personal mailbox) and returns a signed-in client for it. */
export async function createSignedInAccount(
	admin: APIRequestContext,
	username: string,
	role: "user" | "admin" = "user",
) {
	const domainId = await exampleDomainId(admin);
	const { account } = await okJson<{ account: { id: string } }>(
		await admin.post("/api/accounts", {
			data: { username, domainId, password: ACCOUNT_PASSWORD, role, useAllDomains: true },
		}),
	);
	const api = await apiSignIn(`${username}@${DOMAIN}`, ACCOUNT_PASSWORD);
	const { mailboxes } = await okJson<{ mailboxes: { id: string; localPart: string }[] }>(
		await api.get("/api/mailboxes"),
	);
	const mailbox = mailboxes.find((item) => item.localPart === username);
	expect(mailbox).toBeDefined();
	return { id: account.id, api, mailboxId: mailbox!.id };
}

export async function createSharedMailbox(admin: APIRequestContext, localPart: string): Promise<string> {
	const domainId = await exampleDomainId(admin);
	const response = await admin.post("/api/mailboxes", {
		data: { domainId, localPart, displayName: localPart, type: "shared" },
	});
	return (await okJson<{ id: string }>(response)).id;
}

export async function shareMailbox(admin: APIRequestContext, mailboxId: string, userId: string, permission: string) {
	await okJson(await admin.post(`/api/mailboxes/${mailboxId}/access`, { data: { userId, permission } }));
}

export async function readMailboxSettings(api: APIRequestContext, mailboxId: string): Promise<MailboxSettingsBody> {
	return okJson<MailboxSettingsBody>(await api.get(`/api/agent/settings?mailboxId=${encodeURIComponent(mailboxId)}`));
}

/** Only the automatic reading fields, which are what these tests compare before and after a request. */
export function autoReadFields(body: MailboxSettingsBody) {
	const { autonomy, capabilities, triageModelId, autoReadDailyLimit, dailySpendCapMicros, pausedUntil } = body.settings;
	return { autonomy, capabilities, triageModelId, autoReadDailyLimit, dailySpendCapMicros, pausedUntil };
}

/** Makes the mailbox picker start on this mailbox for every page load in the context. */
export async function selectMailbox(page: Page, mailboxId: string) {
	await page.addInitScript((id) => localStorage.setItem("selected-mailbox-id", id), mailboxId);
}

/** Opens the assistant settings from the inbox and returns the "Automatic reading" section. */
export async function openAutoReadSection(page: Page) {
	await page.goto("/inbox");
	const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
	await expect(toggle).toBeVisible();
	// The full-page loader can cover the header for a while when the dev server is busy compiling.
	if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click({ timeout: 45_000 });
	const panel = page.locator("#email-assistant-panel");
	await panel.getByRole("button", { name: "Assistant settings" }).click();
	const section = panel.getByRole("region", { name: "Automatic reading" });
	await expect(section).toBeVisible();
	return section;
}

export function collectConsoleErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}
