/**
 * What happened: the next load found that a load of the same tab froze (`previous_load_froze`, the default), or the
 * service worker's freeze watchdog (public/kite-sw.js) saw a startup screen stop and reloaded the tab
 * (`auto_reloaded_after_freeze`) or, within its window after such a reload, left it alone (`freeze_not_reloaded`).
 */
const BOOT_REPORT_EVENTS = ["previous_load_froze", "auto_reloaded_after_freeze", "freeze_not_reloaded"] as const;
type BootReportEvent = (typeof BOOT_REPORT_EVENTS)[number];

/**
 * What is reported about a load that froze (boot-trace-utils.ts, BOOT_REPORT_PATH): the phase and last step it
 * reached, its last heartbeat and visible time, the first segment of its page, its build and whether it was the
 * load right after Reload in the update notice. Times and fixed names only, no personal data.
 */
export type BootFreezeReport = {
	event: BootReportEvent;
	page: string;
	phase: string;
	step: string | null;
	afterMs: number;
	visibleMs: number;
	build: string | null;
	afterUpdate: boolean;
};

/** A report is a few hundred bytes; anything much larger is not one. */
const BOOT_REPORT_MAX_BYTES = 2_048;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const PAGE = /^\/[A-Za-z0-9._-]{0,40}$/;
const BUILD = /^[\w.() -]{1,60}$/;
/** A heartbeat or visible time past a day is no start. */
const MAX_MS = 86_400_000;

function milliseconds(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MS
		? Math.round(value)
		: null;
}

function optional(value: unknown, pattern: RegExp): string | null | undefined {
	if (value === undefined || value === null) return null;
	return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** The report in a beacon's text body, or null when it is not one. */
export function parseBootFreezeReport(text: string): BootFreezeReport | null {
	if (text.length > BOOT_REPORT_MAX_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const afterMs = milliseconds(input.afterMs);
	const visibleMs = milliseconds(input.visibleMs);
	const step = optional(input.step, NAME);
	const build = optional(input.build, BUILD);
	const page = input.page === "" ? "/" : input.page;
	if (typeof input.phase !== "string" || !NAME.test(input.phase)) return null;
	if (typeof page !== "string" || !PAGE.test(page)) return null;
	if (afterMs === null || visibleMs === null || step === undefined || build === undefined) return null;
	const event = input.event ?? "previous_load_froze";
	if (!BOOT_REPORT_EVENTS.includes(event as BootReportEvent)) return null;
	return {
		event: event as BootReportEvent,
		page,
		phase: input.phase,
		step,
		afterMs,
		visibleMs,
		build,
		afterUpdate: input.afterUpdate === true,
	};
}

/**
 * The request body as text, read up to BOOT_REPORT_MAX_BYTES whatever Content-Length says (a beacon can stream);
 * null once it is longer, without reading the rest.
 */
export async function readBootReportBody(request: Request): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > BOOT_REPORT_MAX_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
