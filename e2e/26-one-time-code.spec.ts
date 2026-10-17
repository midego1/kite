import { expect, test, type Page } from "@playwright/test";
import { ADMIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

type CapturedNotification = {
	title: string;
	options: Record<string, unknown> | null;
	source: "sw" | "constructor";
};

/**
 * Makes `new Notification` and `ServiceWorkerRegistration.showNotification`
 * record into `window.__kiteNotifications` instead of relying on the OS, and
 * reports the document as hidden (the notification path only runs for
 * background tabs, which Chromium's headless shell never produces).
 */
function stubNotifications() {
	const script = () => {
		const shown: CapturedNotification[] = [];
		(window as { __kiteNotifications?: CapturedNotification[] }).__kiteNotifications = shown;
		const push = (title: string, options: NotificationOptions | null | undefined, source: "sw" | "constructor") => {
			shown.push({ title, options: (options as Record<string, unknown> | null) ?? null, source });
		};
		class NotificationStub {
			static permission = "granted" as NotificationPermission;
			static requestPermission() {
				return Promise.resolve("granted" as NotificationPermission);
			}
			onclick: (() => void) | null = null;
			constructor(title: string, options?: NotificationOptions) {
				push(title, options, "constructor");
			}
			close() {}
		}
		Object.defineProperty(window, "Notification", { value: NotificationStub, configurable: true });
		const prototype = (
			window as {
				ServiceWorkerRegistration?: {
					prototype?: { showNotification?: (title: string, options?: NotificationOptions) => Promise<void> };
				};
			}
		).ServiceWorkerRegistration?.prototype;
		if (prototype && typeof prototype.showNotification === "function") {
			prototype.showNotification = function (title: string, options?: NotificationOptions) {
				push(title, options, "sw");
				return Promise.resolve();
			};
		}
		Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
		Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
	};
	return script;
}

/** Delivers an invented OTP email through the real inbound pipeline. */
async function deliverCodeMail(subject: string, code: string) {
	const api = await apiContext(STORAGE_STATE);
	const message = await deliverInbound(api, {
		from: `"Nodsoft Security" <security@nodsoft.example.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: `Hello,\n\nYour verification code is ${code}. It expires in 10 minutes.\n\nDo not share it with anyone.\n\nThe Nodsoft team`,
	});
	await api.dispose();
	return message;
}

/**
 * Seeds `kite-session-user`, which the app's own sign-in writes to localStorage
 * and which the realtime hook requires before it opens the socket. The shared
 * session state only carries cookies, so without this the page never connects.
 */
async function seedRealtimeSession(page: Page) {
	const api = await apiContext();
	const response = await api.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
	const body = (await response.json()) as { userId?: string };
	await api.dispose();
	if (!body.userId) throw new Error(`Could not read the admin user id: ${response.status()}`);
	await page.addInitScript((userId) => {
		localStorage.setItem("kite-session-user", userId);
	}, body.userId);
}

/** Records the app's realtime sockets, so a test can wait for one to be open before delivering mail. */
function instrumentRealtime() {
	const script = () => {
		const sockets: { url: string; socket: WebSocket }[] = [];
		(window as { __kiteSockets?: { url: string; socket: WebSocket }[] }).__kiteSockets = sockets;
		const OriginalWebSocket = window.WebSocket;
		const PatchedWebSocket = class extends OriginalWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				sockets.push({ url: String(url), socket: this as unknown as WebSocket });
			}
		};
		Object.defineProperty(window, "WebSocket", { value: PatchedWebSocket, configurable: true });
	};
	return script;
}

async function waitForRealtimeSocket(page: Page) {
	await page.waitForFunction(() =>
		((window as { __kiteSockets?: { url: string; socket: WebSocket }[] }).__kiteSockets ?? []).some(
			(entry) => entry.url.includes("/api/realtime") && entry.socket.readyState === 1,
		),
	);
}

async function lastNotification(page: Page): Promise<CapturedNotification> {
	await expect
		.poll(() => page.evaluate(() => (window as { __kiteNotifications?: unknown[] }).__kiteNotifications?.length ?? 0))
		.toBeGreaterThan(0);
	return page.evaluate(() => {
		const shown = (window as { __kiteNotifications?: CapturedNotification[] }).__kiteNotifications;
		return shown![shown!.length - 1];
	});
}

test("the new-mail popup shows the code and Copy puts it on the clipboard", async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await seedRealtimeSession(page);
	await page.addInitScript(instrumentRealtime());
	await page.goto("/inbox");
	// The popup only renders for events that arrive on the live socket.
	await waitForRealtimeSocket(page);
	const subject = `Sign in to Nodsoft ${uniqueToken("otp")}`;
	await deliverCodeMail(subject, "918273");
	await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
	await expect(page.getByText("918273").first()).toBeVisible();
	await page.getByRole("button", { name: "Copy code" }).click();
	await expect(page.getByText("Code copied")).toBeVisible();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("918273");
});

test("the open message shows a copy-code chip", async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const subject = `Sign in to Nodsoft ${uniqueToken("otp")}`;
	await deliverCodeMail(subject, "441902");
	await page.goto("/inbox");
	await openMessage(page, subject);
	const readerCopy = page.getByRole("main").getByRole("button", { name: "Copy code" });
	await expect(readerCopy).toBeVisible();
	await readerCopy.click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("441902");
});

/**
 * Delivers an HTML-only verification mail whose lowercase code sits in its own
 * table cell, with a footer address close enough to "The code will expire"
 * that its street number would make the code ambiguous.
 */
async function deliverHtmlOnlyCodeMail(subject: string, code: string) {
	const api = await apiContext(STORAGE_STATE);
	const message = await deliverInbound(api, {
		from: `"Examplehost Accounts" <alert@examplehost.example.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: null,
		html: [
			`<table><tr><td><h1>Please verify your account</h1></td></tr>`,
			`<tr><td><p>Hi there,</p><p>Simply copy and paste the temporary authentication code into the pop-up verification form on the Examplehost website.</p></td></tr>`,
			`<tr><td><a href="#" style="color:#3355ff">${code}</a></td></tr>`,
			`<tr><td>The code will expire thirty minutes after the request was made.</td></tr></table>`,
			`<p>4600 East Example Street, Suite 300, Exampleville, ZZ 85034</p>`,
		].join(""),
	});
	await api.dispose();
	return message;
}

test("an HTML-only message with a lowercase code above a footer address shows the chip", async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const subject = `Important action required: Please verify account ${uniqueToken("otp")}`;
	await deliverHtmlOnlyCodeMail(subject, "b77f3a");
	await page.goto("/inbox");
	await openMessage(page, subject);
	const readerCopy = page.getByRole("main").getByRole("button", { name: "Copy code" });
	await expect(readerCopy).toBeVisible();
	await readerCopy.click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("b77f3a");
});

test("an HTML-only message whose markup is deeply indented shows the chip", async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const pad = (depth: number) => " ".repeat(depth * 2);
	const subject = `Your temporary Examplechat login code ${uniqueToken("otp")}`;
	const api = await apiContext(STORAGE_STATE);
	await deliverInbound(api, {
		from: `"Examplechat" <noreply@examplechat.example.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: null,
		html: [
			"<center><table><tr><td>",
			`${pad(10)}<p>`,
			`${pad(12)}Enter this temporary verification code to continue:`,
			`${pad(10)}</p>`,
			`${pad(10)}<p style="font-family: Menlo, monospace; font-size: 24px">`,
			pad(12),
			`${pad(12)}604127`,
			pad(12),
			`${pad(10)}</p>`,
			`${pad(10)}<p>Didn't request a verification code? You can ignore this email.</p>`,
			"</td></tr></table></center>",
		].join("\n"),
	});
	await api.dispose();
	await page.goto("/inbox");
	await openMessage(page, subject);
	const readerCopy = page.getByRole("main").getByRole("button", { name: "Copy code" });
	await expect(readerCopy).toBeVisible();
	await readerCopy.click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("604127");
});

test("an HTML-only message with a lowercase code carries it in the browser notification", async ({ page }) => {
	await seedRealtimeSession(page);
	await page.addInitScript(stubNotifications());
	await page.addInitScript(instrumentRealtime());
	await page.goto("/inbox");
	await expect
		.poll(() => page.evaluate(() => (navigator.serviceWorker?.controller ? 1 : 0)), { timeout: 20_000 })
		.toBe(1);
	await waitForRealtimeSocket(page);
	const subject = `Important action required: Please verify account ${uniqueToken("otp")}`;
	const message = await deliverHtmlOnlyCodeMail(subject, "q4zt8m");
	const entry = await lastNotification(page);
	expect(entry.title).toBe(`q4zt8m · ${subject}`);
	expect(entry.options?.data).toMatchObject({ messageId: message.id, code: "q4zt8m" });
});

test("the browser notification carries the code, a copy action and service-worker data", async ({ page }) => {
	await seedRealtimeSession(page);
	await page.addInitScript(stubNotifications());
	await page.addInitScript(instrumentRealtime());
	await page.goto("/inbox");
	// The service worker must be registered and controlling the page, so the
	// Copy code action and the click handler in kite-sw.js are in place.
	await expect
		.poll(() => page.evaluate(() => (navigator.serviceWorker?.controller ? 1 : 0)), { timeout: 20_000 })
		.toBe(1);
	await waitForRealtimeSocket(page);
	const subject = `Your Nodsoft code ${uniqueToken("otp")}`;
	const message = await deliverCodeMail(subject, "620415");
	const entry = await lastNotification(page);
	expect(entry.source).toBe("sw");
	expect(entry.title).toBe(`620415 · ${subject}`);
	expect(entry.options?.body).toContain("Click to copy");
	expect(entry.options?.body).toContain("Nodsoft Security");
	expect(entry.options?.tag).toBe(message.id);
	expect(entry.options?.data).toEqual({ messageId: message.id, code: "620415", copyOnClick: true });
	expect(entry.options?.actions).toEqual([{ action: "copy", title: "Copy code" }]);
});

test("a copy request the clipboard refuses becomes a dialog with one more Copy", async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/inbox");
	// The same channel the service worker message handler serves. Dispatched in
	// a poll because the listener mounts with the app after the load event.
	await expect
		.poll(async () => {
			await page.evaluate((code) => {
				window.dispatchEvent(new CustomEvent("kite:copy-code", { detail: { code } }));
			}, "337461");
			return page.getByText("Code copied").count();
		})
		.toBeGreaterThan(0);
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("337461");

	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new Error("refused")) },
			configurable: true,
		});
	});
	await page.evaluate((code) => {
		window.dispatchEvent(new CustomEvent("kite:copy-code", { detail: { code } }));
	}, "337461");
	await expect(page.getByRole("dialog").getByText("337461")).toBeVisible();
	await page.evaluate(() => {
		delete (navigator as { clipboard?: unknown }).clipboard;
	});
	await page.getByRole("dialog").getByRole("button", { name: "Copy code" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByText("Code copied").last()).toBeVisible();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("337461");
});

test("Settings can send a test notification while the tab is visible", async ({ page }) => {
	await page.addInitScript(stubNotifications());
	await page.goto("/settings/inbox");
	// The stub hides the tab; a test notification must show regardless.
	const button = page.getByRole("button", { name: "Send test notification" });
	await expect(button).toBeEnabled();
	await button.click();
	const entry = await lastNotification(page);
	expect(entry.title).toBe("Kite notifications are working");
	expect(entry.options?.body).toContain("New email will be announced like this");
	expect(entry.options?.tag).toBe("kite-test-notification");
	expect((entry.options as { renotify?: boolean } | undefined)?.renotify).toBe(true);
	expect(entry.options?.data).toEqual({ test: true });
	await expect(page.getByText(/^Test notification sent/)).toBeVisible();

	// With browser notifications turned off, the button is unavailable.
	await page.getByRole("switch", { name: "Enable browser notifications" }).click();
	await expect(button).toBeDisabled();
});

test("Settings can send a test code notification whose click copies the code", async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.addInitScript(stubNotifications());
	await page.goto("/settings/inbox");
	const button = page.getByRole("button", { name: "Send test code" });
	await expect(button).toBeEnabled();
	await button.click();
	const entry = await lastNotification(page);
	const code = (entry.options?.data as { code?: string } | undefined)?.code ?? "";
	expect(code).toMatch(/^\d{6}$/);
	expect(entry.title).toBe(`${code} · Test sign-in code`);
	expect(entry.options?.body).toBe("From Kite · Click to copy");
	expect(entry.options?.tag).toBe("kite-test-code-notification");
	expect((entry.options as { renotify?: boolean } | undefined)?.renotify).toBe(true);
	expect(entry.options?.data).toEqual({ test: true, code, copyOnClick: true });
	expect(entry.options?.actions).toEqual([{ action: "copy", title: "Copy code" }]);
	await expect(page.getByText(`Test code ${code} sent.`, { exact: false })).toBeVisible();

	// A click on the notification makes the service worker post this message to the tab (public/kite-sw.js).
	await page.evaluate((value) => {
		navigator.serviceWorker.dispatchEvent(
			new MessageEvent("message", { data: { type: "kite:copy-code", code: value } }),
		);
	}, code);
	await expect(page.getByText("Code copied")).toBeVisible();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);

	// With codes kept out of notifications, there is nothing to test.
	await page.getByRole("switch", { name: "Show one-time codes in notifications" }).click();
	await expect(button).toBeDisabled();
});

test("turning the code setting off keeps codes out of the notification", async ({ page }) => {
	await seedRealtimeSession(page);
	await page.addInitScript(stubNotifications());
	await page.addInitScript(instrumentRealtime());
	await page.goto("/settings/inbox");
	const codeSwitch = page.getByRole("switch", { name: "Show one-time codes in notifications" });
	await expect(codeSwitch).toBeEnabled();
	await codeSwitch.click();
	await expect(codeSwitch).not.toBeChecked();
	await page.goto("/inbox");
	await waitForRealtimeSocket(page);
	const subject = `Your Nodsoft code ${uniqueToken("otp")}`;
	const message = await deliverCodeMail(subject, "581024");
	const entry = await lastNotification(page);
	expect(entry.title).toBe(subject);
	expect(entry.title).not.toContain("581024");
	expect(entry.options?.body).not.toContain("581024");
	expect(entry.options?.data).toEqual({ messageId: message.id });
	expect(entry.options?.actions).toBeUndefined();
});
