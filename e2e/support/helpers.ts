import { expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { BASE_URL } from "./constants";
import type { InboundMail, StoredMessage } from "./helpers-types";

/** A lowercase word that FTS5 indexes as a single token, for finding test data again. */
export function uniqueToken(prefix = "e2e"): string {
	return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Waits until React has attached its handlers to the element. Interacting
 * earlier falls through to native behaviour (a form posting to itself) while
 * the dev server is still streaming client modules.
 */
export async function waitForHydration(page: Page, selector = "form"): Promise<void> {
	await page.waitForFunction((target) => {
		const element = document.querySelector(target);
		return !!element && Object.keys(element).some((key) => key.startsWith("__reactProps"));
	}, selector);
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
	await page.goto("/login");
	await waitForHydration(page);
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Opens a message from the current list by its subject. Row links use
 * `display: contents`, so clicking the link itself lands on its first child,
 * the star toggle; the subject text is a safe target.
 */
export async function openMessage(page: Page, subject: string | RegExp): Promise<void> {
	await page
		.getByRole("main")
		.getByText(subject, { exact: typeof subject === "string" })
		.first()
		.click();
	await expect(page).toHaveURL(/\/msg_[\w-]+/);
}

/** An API client that sends the same Origin a browser would, so session mutations pass the CSRF check. */
export async function apiContext(
	storageState?: string | Awaited<ReturnType<APIRequestContext["storageState"]>>,
): Promise<APIRequestContext> {
	return request.newContext({ baseURL: BASE_URL, storageState, extraHTTPHeaders: { Origin: BASE_URL } });
}

export async function apiSignIn(email: string, password: string): Promise<APIRequestContext> {
	const api = await apiContext();
	const response = await api.post("/api/auth/login", { data: { email, password } });
	expect(response.ok(), await response.text()).toBe(true);
	return api;
}

function buildMime(mail: InboundMail): string {
	const headers = [
		`From: ${mail.from}`,
		`To: ${mail.to}`,
		`Subject: ${mail.subject}`,
		`Message-ID: ${mail.messageId ?? `<${randomUUID()}@e2e.test>`}`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
	];
	if (mail.inReplyTo) headers.push(`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`);
	const text = mail.text ?? "E2E message body.";
	if (!mail.html) {
		return [...headers, "Content-Type: text/plain; charset=utf-8", "", text, ""].join("\r\n");
	}
	const boundary = `b${randomUUID().replace(/-/g, "")}`;
	return [
		...headers,
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		text,
		`--${boundary}`,
		"Content-Type: text/html; charset=utf-8",
		"",
		mail.html,
		`--${boundary}--`,
		"",
	].join("\r\n");
}

function addressOf(header: string): string {
	return header.match(/<([^>]+)>/)?.[1] ?? header.trim();
}

/**
 * Delivers mail through the Worker's real `email` handler (Miniflare's local
 * trigger endpoint), so it takes the same R2 + queue + parse path as production.
 */
export async function deliverInbound(api: APIRequestContext, mail: InboundMail): Promise<StoredMessage> {
	await postInbound(api, mail);
	return waitForMessage(api, mail.subject);
}

/** Hands the mail to the email handler without waiting for it to be stored, so arrival order is the call order. */
export async function postInbound(api: APIRequestContext, mail: InboundMail): Promise<void> {
	const query = new URLSearchParams({ from: addressOf(mail.from), to: addressOf(mail.to) });
	const response = await api.post(`/cdn-cgi/handler/email?${query}`, {
		data: buildMime(mail),
		headers: { "Content-Type": "message/rfc822" },
	});
	expect(response.status(), await response.text()).toBe(200);
}

/** Polls the message list until a message whose subject contains `subject` is stored. */
export async function waitForMessage(
	api: APIRequestContext,
	subject: string,
	filters: Record<string, string> = {},
): Promise<StoredMessage> {
	let found: StoredMessage | undefined;
	await expect
		.poll(
			async () => {
				const params = new URLSearchParams({ q: subject, limit: "20", ...filters });
				const response = await api.get(`/api/messages?${params}`);
				if (!response.ok()) return false;
				const data = (await response.json()) as { messages: StoredMessage[] };
				found = data.messages.find((message) => message.subject?.includes(subject));
				return !!found;
			},
			{ timeout: 45_000, intervals: [250, 500, 1000] },
		)
		.toBe(true);
	return found!;
}

export async function setSendingSettings(
	api: APIRequestContext,
	settings: { previewEnabled?: boolean; undoSeconds?: number },
): Promise<void> {
	const response = await api.patch("/api/settings/sending", { data: settings });
	expect(response.ok(), await response.text()).toBe(true);
}
