import { expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { BASE_URL, STORAGE_STATE } from "./constants";
import type { InboundAttachment, InboundMail, StoredMessage, BackupRow, RestoreSummary } from "./helpers-types";

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

/** Opens a message from the current list by clicking its subject. */
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

const newBoundary = () => `b${randomUUID().replace(/-/g, "")}`;

/** The body as MIME lines, starting with its Content-Type header. */
function bodyPart(mail: InboundMail): string[] {
	const text = mail.text ?? "E2E message body.";
	if (!mail.html) return ["Content-Type: text/plain; charset=utf-8", "", text];
	if (mail.text === null) return ["Content-Type: text/html; charset=utf-8", "", mail.html];
	const boundary = newBoundary();
	return [
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
	];
}

/**
 * Quoted-printable (RFC 2045 §6.7) of any bytes, with soft line breaks before 76 characters. The last line ends in a
 * soft break too, so the line break before the next delimiter adds nothing to the decoded bytes.
 */
function quotedPrintable(bytes: Buffer): string[] {
	const lines: string[] = [];
	let line = "";
	for (const byte of bytes) {
		const plain = byte >= 33 && byte <= 126 && byte !== 61;
		const token = plain ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		if (line.length + token.length > 75) {
			lines.push(`${line}=`);
			line = "";
		}
		line += token;
	}
	lines.push(`${line}=`);
	return lines;
}

function attachmentPart(attachment: InboundAttachment): string[] {
	const bytes = Buffer.from(attachment.content);
	const encoding = attachment.transferEncoding ?? "base64";
	return [
		`Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
		`Content-Disposition: ${attachment.disposition ?? "attachment"}; filename="${attachment.filename}"`,
		...(attachment.contentId ? [`Content-ID: <${attachment.contentId}>`] : []),
		`Content-Transfer-Encoding: ${encoding}`,
		"",
		...(encoding === "base64" ? (bytes.toString("base64").match(/.{1,76}/g) ?? []) : quotedPrintable(bytes)),
	];
}

/** Parts as the lines of one multipart body, ending with its close delimiter. */
function multipart(type: string, parts: string[][]): string[] {
	const boundary = newBoundary();
	return [
		`Content-Type: multipart/${type}; boundary="${boundary}"`,
		"",
		...parts.flatMap((part) => [`--${boundary}`, ...part]),
		`--${boundary}--`,
	];
}

/**
 * The message body: the text, the HTML and the attachments in a multipart/mixed. With `related`, inline attachments
 * sit with the body in a multipart/related, as mail clients send images an HTML body shows by `cid:`.
 */
function messageBody(mail: InboundMail): string[] {
	const attachments = mail.attachments ?? [];
	const inline = mail.related ? attachments.filter((attachment) => attachment.disposition === "inline") : [];
	const files = attachments.filter((attachment) => !inline.includes(attachment));
	const body = inline.length ? multipart("related", [bodyPart(mail), ...inline.map(attachmentPart)]) : bodyPart(mail);
	return files.length ? multipart("mixed", [body, ...files.map(attachmentPart)]) : body;
}

/**
 * A message as the bytes the email handler receives. Exported so a test can compare what it sent with what Kite kept
 * ("Show original", the JMAP email blob).
 */
export function buildMime(mail: InboundMail): string {
	const headers = [
		`From: ${mail.from}`,
		`To: ${mail.to}`,
		`Subject: ${mail.subject}`,
		`Message-ID: ${mail.messageId ?? `<${randomUUID()}@e2e.test>`}`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		...Object.entries(mail.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
	];
	if (mail.inReplyTo) headers.push(`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`);
	return [...headers, ...messageBody(mail), ""].join("\r\n");
}

function addressOf(header: string): string {
	return header.match(/<([^>]+)>/)?.[1] ?? header.trim();
}

/**
 * Delivers mail through the Worker's real `email` handler (Miniflare's local
 * trigger endpoint), so it takes the same R2 + queue + parse path as production.
 */
export async function deliverInbound(
	api: APIRequestContext,
	mail: InboundMail,
	mime = buildMime(mail),
): Promise<StoredMessage> {
	await postInbound(api, mail, mime);
	return waitForMessage(api, mail.subject);
}

/**
 * Hands the mail to the email handler without waiting for it to be stored, so arrival order is the call order. `mime`
 * is what `buildMime(mail)` returns unless a test built it first to compare with later.
 */
export async function postInbound(api: APIRequestContext, mail: InboundMail, mime = buildMime(mail)): Promise<void> {
	const query = new URLSearchParams({ from: addressOf(mail.from), to: addressOf(mail.to) });
	const response = await api.post(`/cdn-cgi/handler/email?${query}`, {
		data: mime,
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

/** Every backup row the admin API lists, newest first. */
export async function readBackups(api: APIRequestContext): Promise<BackupRow[]> {
	const response = await api.get("/api/backups");
	if (!response.ok()) throw new Error(`Failed to read backups: ${response.status()}`);
	const data = (await response.json()) as { backups: BackupRow[] };
	return data.backups;
}

/**
 * Waits for a backup the admin API queued to finish. `POST /api/backups` only
 * enqueues it, so the row is unfinished when the request returns and the export
 * happens on the outbound queue consumer.
 */
/**
 * Waits for the queued restore (`restoreId`, or whichever runs) to end and returns its summary. The restore
 * replaces the sessions table, so reads fail while it runs; `api` (the suite's admin session by default, which
 * every backup taken during the run holds) answers again once it is done.
 */
export async function waitForRestore(api?: APIRequestContext, restoreId?: string): Promise<RestoreSummary> {
	const client = api ?? (await apiContext(STORAGE_STATE));
	let ended: RestoreSummary | undefined;
	try {
		await expect
			.poll(
				async () => {
					const response = await client.get("/api/backups/health").catch(() => null);
					if (!response?.ok()) return "running";
					const restore = ((await response.json()) as { restore?: RestoreSummary | null }).restore;
					if (!restore || restore.active || (restoreId && restore.id !== restoreId)) return "running";
					ended = restore;
					return "ended";
				},
				{ timeout: 180_000, intervals: [500, 1000] },
			)
			.toBe("ended");
	} finally {
		if (!api) await client.dispose();
	}
	return ended!;
}

export async function waitForBackup(api: APIRequestContext, backupId: string): Promise<BackupRow> {
	let row: BackupRow | undefined;
	await expect
		.poll(
			async () => {
				row = (await readBackups(api)).find((backup) => backup.id === backupId);
				return row?.status;
			},
			{ timeout: 60_000, intervals: [250, 500, 1000] },
		)
		.toMatch(/completed|failed/);
	return row!;
}
