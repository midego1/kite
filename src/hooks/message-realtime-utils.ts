import { registerKiteServiceWorker } from "@/components/asset-recovery-utils";
import { requestCopyCode } from "@/components/copy-code-host-utils";
import {
	buildNewMessageNotificationParts,
	buildTestCodeNotificationParts,
	makeTestOneTimeCode,
} from "./new-message-notification-utils";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import type { ModuleNoticeEvent, NewMessageEvent } from "./message-realtime-types";

export const REALTIME_FALLBACK_INTERVAL_MS = 60_000;
/** Keeps the socket alive; answered by the Durable Object's auto-response without waking it. */
export const REALTIME_HEARTBEAT_INTERVAL_MS = 25_000;
/** How often a visible tab asks whether mail changed elsewhere (another device, JMAP, a rule). Each check is one D1 read. */
export const REALTIME_REVISION_INTERVAL_MS = 120_000;
/** Focus and visibility events arrive in bursts; one revision check covers them all. */
export const REALTIME_FOCUS_CHECK_THROTTLE_MS = 10_000;
export const REALTIME_RECONNECT_MAX_MS = 30_000;
/** Fired on window when a Kite suggestion is created, decided or closed (realtime or a local action). */
export const AGENT_SUGGESTION_EVENT = "kite:agent-suggestion";
/** Fired on window in every open tab when a module sends the user a notice; the detail is a `ModuleNoticeEvent`. */
export const MODULE_NOTICE_EVENT = "kite:module-notice";
const BROWSER_NOTIFICATIONS_ENABLED_KEY = "kite:browser-notifications-enabled";
const NOTIFICATION_CODES_ENABLED_KEY = "kite:notification-codes-enabled";

export function areBrowserNotificationsEnabled(): boolean {
	try {
		return window.localStorage.getItem(BROWSER_NOTIFICATIONS_ENABLED_KEY) !== "false";
	} catch {
		return true;
	}
}

export function setBrowserNotificationsEnabled(enabled: boolean): void {
	window.localStorage.setItem(BROWSER_NOTIFICATIONS_ENABLED_KEY, String(enabled));
}

/** Whether one-time codes may appear in browser notifications; per browser, default on. */
export function areOneTimeCodesInNotificationsEnabled(): boolean {
	try {
		return window.localStorage.getItem(NOTIFICATION_CODES_ENABLED_KEY) !== "false";
	} catch {
		return true;
	}
}

export function setOneTimeCodesInNotificationsEnabled(enabled: boolean): void {
	window.localStorage.setItem(NOTIFICATION_CODES_ENABLED_KEY, String(enabled));
}

/** NotificationOptions.actions and renotify are missing from the generated DOM lib; this is the subset we set. */
type NotificationOptionsWithActions = NotificationOptions & {
	actions?: { action: string; title: string }[];
	renotify?: boolean;
};

let notificationServiceWorkerPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Registers the Kite notification service worker, which shows notifications
 * with a Copy code action and turns clicks into copy or open-message messages.
 * Registration is idempotent, so repeated calls reuse the browser's registration.
 */
export function ensureNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
	if (!notificationServiceWorkerPromise) {
		notificationServiceWorkerPromise = registerKiteServiceWorker(navigator.serviceWorker).catch(() => {
			// The plain Notification constructor fallback still works without one.
			notificationServiceWorkerPromise = null;
			return null;
		});
	}
	return notificationServiceWorkerPromise;
}

export function dispatchAgentSuggestionChanged(detail: { mailboxId?: string; suggestionId?: string } = {}): void {
	window.dispatchEvent(new CustomEvent(AGENT_SUGGESTION_EVENT, { detail }));
}

export function getRealtimeWebSocketUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/api/realtime`;
}

export function getReconnectDelay(attempt: number): number {
	return Math.min(1_000 * 2 ** attempt, REALTIME_RECONNECT_MAX_MS);
}

export function parseNewMessageEvent(value: string): NewMessageEvent | null {
	try {
		const payload = JSON.parse(value) as Partial<NewMessageEvent>;
		if (
			payload.type !== "new_message" ||
			typeof payload.messageId !== "string" ||
			typeof payload.mailboxId !== "string" ||
			typeof payload.from !== "string"
		) {
			return null;
		}

		return {
			type: "new_message",
			messageId: payload.messageId,
			mailboxId: payload.mailboxId,
			from: payload.from,
			fromName: typeof payload.fromName === "string" ? payload.fromName : null,
			subject: typeof payload.subject === "string" ? payload.subject : null,
			oneTimeCode: typeof payload.oneTimeCode === "string" ? payload.oneTimeCode : null,
		};
	} catch {
		return null;
	}
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A `module_notice` realtime payload, or null for anything else, incomplete, or linking off this site. */
export function parseModuleNoticeEvent(value: string): ModuleNoticeEvent | null {
	try {
		const payload = JSON.parse(value) as Partial<Record<keyof ModuleNoticeEvent, unknown>> | null;
		if (
			payload?.type !== "module_notice" ||
			!nonEmptyString(payload.moduleId) ||
			!nonEmptyString(payload.notice) ||
			!nonEmptyString(payload.title)
		) {
			return null;
		}
		const href = payload.href ?? null;
		if (href !== null && !isSameOriginPath(href)) return null;
		return {
			type: "module_notice",
			moduleId: payload.moduleId,
			notice: payload.notice,
			title: payload.title,
			body: typeof payload.body === "string" ? payload.body : null,
			href,
		};
	} catch {
		return null;
	}
}

export function dispatchModuleNotice(notice: ModuleNoticeEvent): void {
	window.dispatchEvent(new CustomEvent(MODULE_NOTICE_EVENT, { detail: notice }));
}

export async function showBrowserNewMessageNotification(event: NewMessageEvent): Promise<void> {
	if (
		typeof Notification === "undefined" ||
		Notification.permission !== "granted" ||
		!areBrowserNotificationsEnabled() ||
		document.visibilityState === "visible"
	) {
		return;
	}

	try {
		const parts = buildNewMessageNotificationParts(event, areOneTimeCodesInNotificationsEnabled());
		const options: NotificationOptionsWithActions = {
			body: parts.body,
			icon: "/icon-96.png",
			tag: event.messageId,
			// The service worker (and the plain fallback) reads these on click.
			data: parts.code
				? { messageId: event.messageId, code: parts.code, copyOnClick: true }
				: { messageId: event.messageId },
		};
		if (parts.code) options.actions = [{ action: "copy", title: "Copy code" }];
		await presentNotification(parts.title, options, () => {
			if (parts.code) requestCopyCode(parts.code);
			else window.location.assign(`/inbox/${event.messageId}`);
		});
	} catch {
		// The in-app new message popup still handles this email.
	}
}

const TEST_NOTIFICATION_TITLE = "Kite notifications are working";
const TEST_NOTIFICATION_BODY = "New email will be announced like this while Kite is in a background tab.";

/**
 * Shows a sample notification on request from Settings, so a user can check
 * that the browser and the operating system actually display them. Unlike new
 * mail it is shown while the tab is visible, which is where the user is looking.
 * Returns false when notifications are unavailable, blocked or turned off.
 */
export async function showTestBrowserNotification(): Promise<boolean> {
	if (
		typeof Notification === "undefined" ||
		Notification.permission !== "granted" ||
		!areBrowserNotificationsEnabled()
	) {
		return false;
	}
	try {
		await presentNotification(TEST_NOTIFICATION_TITLE, {
			body: TEST_NOTIFICATION_BODY,
			icon: "/icon-96.png",
			tag: "kite-test-notification",
			// Without it, a click while the previous test is still in the notification centre only replaces it
			// silently, so the button looks broken.
			renotify: true,
			data: { test: true },
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Shows a sample one-time code notification from Settings, with the same Copy
 * code action and copy-on-click as a real one, so a user can check the whole
 * copy flow. Returns the sample code, or null when notifications or codes in
 * notifications are unavailable, blocked or turned off.
 */
export async function showTestCodeNotification(): Promise<string | null> {
	if (
		typeof Notification === "undefined" ||
		Notification.permission !== "granted" ||
		!areBrowserNotificationsEnabled() ||
		!areOneTimeCodesInNotificationsEnabled()
	) {
		return null;
	}
	const code = makeTestOneTimeCode();
	const parts = buildTestCodeNotificationParts(code);
	try {
		await presentNotification(
			parts.title,
			{
				body: parts.body,
				icon: "/icon-96.png",
				tag: "kite-test-code-notification",
				renotify: true,
				data: { test: true, code, copyOnClick: true },
				actions: [{ action: "copy", title: "Copy code" }],
			},
			() => requestCopyCode(code),
		);
		return code;
	} catch {
		return null;
	}
}

/**
 * Shown through the service worker when one is available: it supports the
 * Copy code action and can copy or open the message when the notification is
 * clicked even if this tab was closed. The plain constructor is the fallback.
 */
async function presentNotification(
	title: string,
	options: NotificationOptionsWithActions,
	onClick?: () => void,
): Promise<void> {
	const registration = await ensureNotificationServiceWorker();
	if (registration) {
		try {
			await registration.showNotification(title, options);
			return;
		} catch {
			// Fall through to the constructor.
		}
	}
	const notification = new Notification(title, options);
	notification.onclick = () => {
		window.focus();
		onClick?.();
		notification.close();
	};
}
