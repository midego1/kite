import { BUILD_VERSION_LABEL } from "@/lib/build-version";

/**
 * A record of how far the last page load got, kept in sessionStorage so it survives a page whose main thread froze.
 * The inline `bootTraceScript` starts it in <head>; the app adds its phases with `markBootPhase`, and the boot
 * watchdog (asset-recovery-utils.ts) writes a heartbeat on every tick. A load that ends normally reaches
 * `complete`, is ended by the watchdog, or leaves through `pagehide` soon after its last heartbeat. One whose
 * heartbeat simply stopped while the tab was visible froze, and the next load of the tab says so in the console,
 * in the Details of "Kite couldn't load" and "Reload Kite", and to the server (BOOT_REPORT_PATH), which logs it:
 * a frozen page can show nothing, and the load after it usually starts fine, so this is the one place a freeze
 * leaves a record. Within the phases, `markBootStep` names the part of the app that was rendering last.
 *
 * Nothing personal is kept or shown: paths without query strings or fragments (another origin only by its
 * origin), the first segment of the page's own path, times and counts. No message content, no addresses.
 */

/** sessionStorage key of the current (and, at the start of a load, the previous) load's record. */
const BOOT_TRACE_STORAGE_KEY = "kite-boot-trace";
/** Set on `window` by the inline script: `{ phase, beat, remount, end, details, text }`. */
export const BOOT_TRACE_GLOBAL = "__kiteBoot";
/**
 * The phases of a start, in the order they happen; the furthest one reached is the phase a stuck or frozen load
 * stopped at. `auth-answered` is the session check's answer arriving, `children-rendering` React starting to render
 * the app behind the screen with it, `children-committed` that render's layout effects and `auth-ready` its
 * effects having run.
 */
const BOOT_PHASES = [
	"inline",
	"loader-mounted",
	"auth-answered",
	"children-rendering",
	"children-committed",
	"auth-ready",
	"can-complete",
	"complete",
] as const;
export type BootPhase = (typeof BOOT_PHASES)[number];
/**
 * The watchdog beats every 500 ms. A `pagehide` this long after the last beat ran on a thread that had been
 * frozen, and a gap this long between two visible beats is a stall worth reporting.
 */
const BOOT_FREEZE_GAP_MS = 2_000;
/** How many in-flight requests, slow files and long frames the details list. */
const BOOT_DETAILS_LIMIT = 5;
/**
 * Paths whose next segment is a bearer token (Drive public links and shared attachment links): it is replaced with
 * `:token` before anything is kept. Reset and invitation tokens travel in query strings, which are never kept.
 */
const BOOT_SECRET_PATH = /^(\/d\/|\/api\/public\/drive\/|\/api\/shared-files\/)[^/]+/;
/** Only animation frames longer than this are kept. */
const BOOT_LONG_FRAME_MS = 1_000;
/** Where the next load reports a load that froze (`navigator.sendBeacon`, text/plain JSON); the server logs it. */
const BOOT_REPORT_PATH = "/api/boot-report";
/** sessionStorage key of the kite's return marker (reload-return-utils.ts), read before that script consumes it. */
const RELOAD_RETURN_MARKER_KEY = "kite-reload-flight";

export type BootDetails = {
	phase: string;
	phases: { phase: string; atMs: number }[];
	visibleMs: number;
	loaderMounts: number;
	overlayRemounts: number;
	loaderMounted: boolean;
	ready: boolean;
	longestStall: { ms: number; phase: string } | null;
	inFlight: { path: string; startedAtMs: number; ageMs: number }[];
	slowestResources: { path: string; startMs: number; durationMs: number }[];
	longFrames: {
		startMs: number;
		durationMs: number;
		blockingMs: number;
		scripts: { source: string; invoker: string; function: string; durationMs: number }[];
	}[];
	step: { name: string; atMs: number } | null;
	previousLoad: PreviousBootLoad | null;
};

/**
 * A load of this tab that froze, as the next load found it: the phase and the last step it reached, its last
 * heartbeat, its visible time, and (when known) its build and whether it was the load right after Reload in the
 * update notice. `step`, `build` and `afterUpdate` are left out when the record did not have them.
 */
type PreviousBootLoad = {
	phase: string;
	afterMs: number;
	visibleMs: number;
	step?: string;
	build?: string;
	afterUpdate?: true;
};

type BootTrace = {
	phase?: (name: BootPhase) => void;
	step?: (name: string) => void;
	copy?: (pre: HTMLElement | null) => Promise<BootCopyResult>;
	details?: () => BootDetails;
	text?: () => string;
};

function bootTrace(): BootTrace | null {
	if (typeof window === "undefined") return null;
	const trace = (window as unknown as Record<string, unknown>)[BOOT_TRACE_GLOBAL];
	return trace && typeof trace === "object" ? (trace as BootTrace) : null;
}

/** Records that the app reached `phase` (the first time only; `loader-mounted` also counts the mounts). */
export function markBootPhase(phase: BootPhase): void {
	try {
		bootTrace()?.phase?.(phase);
	} catch {
		// The trace is diagnostics only; the app never depends on it.
	}
}

/**
 * Records the part of the app that is rendering (or committing) now, overwriting the last one: placed in render
 * bodies and effects along the start, so a load that froze names where. Short, fixed names only.
 */
export function markBootStep(name: string): void {
	try {
		bootTrace()?.step?.(name);
	} catch {
		// The trace is diagnostics only; the app never depends on it.
	}
}

/** What Copy details did: copied the JSON, or (without the clipboard API) selected the text for the user to copy. */
export type BootCopyResult = "copied" | "selected" | "failed";

/** The label Copy details shows after `result`. */
export function bootCopyLabel(result: BootCopyResult): string {
	if (result === "copied") return "Copied";
	if (result === "selected") return "Text selected, copy it";
	return "Copy details";
}

/** Copy details: the JSON on the clipboard, or `pre`'s text selected where the clipboard API is missing. */
export async function copyBootDetails(pre: HTMLElement | null): Promise<BootCopyResult> {
	try {
		return (await bootTrace()?.copy?.(pre)) ?? "failed";
	} catch {
		return "failed";
	}
}

/** What the trace knows about this load, for the Details of the startup screen's recovery; null without it. */
export function readBootDetails(): { details: BootDetails; text: string } | null {
	try {
		const trace = bootTrace();
		const details = trace?.details?.();
		if (!details) return null;
		return { details, text: trace?.text?.() ?? "" };
	} catch {
		return null;
	}
}

/*
 * Runs first in <head>, before the boot watchdog and the app's entry script. It reads the previous load's record,
 * reports a freeze, starts this load's record and keeps what the details need: a fetch wrapper for the requests
 * still open, a PerformanceObserver for the slowest files and for animation frames over BOOT_LONG_FRAME_MS (where
 * the browser has long-animation-frame entries), with their scripts' source and invoker. The wrapper only notes
 * a path and a start time and returns fetch's own promise.
 */
export const bootTraceScript = `(() => {
	try {
		const key = ${JSON.stringify(BOOT_TRACE_STORAGE_KEY)};
		const order = ${JSON.stringify(BOOT_PHASES)};
		const freezeGapMs = ${BOOT_FREEZE_GAP_MS};
		const limit = ${BOOT_DETAILS_LIMIT};
		const now = () => Math.round(performance.now());
		const visible = () => document.visibilityState !== "hidden";
		// A path of ours without its query string or fragment, and without the token of a link that grants access by
		// itself; another origin only by its origin.
		const pathOf = (url) => {
			try {
				const parsed = new URL(String(url), location.href);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
				if (parsed.origin !== location.origin) return parsed.origin;
				return parsed.pathname.replace(${BOOT_SECRET_PATH}, "$1:token").slice(0, 200);
			} catch {
				return "?";
			}
		};
		const clip = (value) => String(value || "").split(/[?#]/)[0].slice(0, 200);
		const furthest = (phases) => {
			let best = null;
			for (const entry of phases) if (!best || order.indexOf(entry.p) > order.indexOf(best.p)) best = entry;
			return best;
		};

		let previous = null;
		try {
			previous = JSON.parse(sessionStorage.getItem(key) || "null");
		} catch {}
		let previousLoad = null;
		if (previous && Array.isArray(previous.phases) && typeof previous.beat === "number") {
			const completed = previous.phases.some((entry) => entry && entry.p === "complete");
			const leftLate = !previous.left || !(previous.left.gap <= freezeGapMs);
			if (!completed && !previous.ended && previous.visible === true && leftLate) {
				const last = furthest(previous.phases.filter((entry) => entry && typeof entry.p === "string"));
				previousLoad = {
					phase: last ? last.p : "unknown",
					afterMs: previous.beat,
					visibleMs: typeof previous.visibleMs === "number" ? previous.visibleMs : 0,
				};
				if (previous.step && typeof previous.step.s === "string") previousLoad.step = clip(previous.step.s).slice(0, 40);
				if (typeof previous.build === "string") previousLoad.build = previous.build.slice(0, 60);
				if (previous.afterUpdate === true) previousLoad.afterUpdate = true;
				console.error(
					"[kite] previous load froze at phase " + previousLoad.phase +
						(previousLoad.step ? " (step " + previousLoad.step + ")" : "") +
						" after " + previousLoad.afterMs + " ms",
				);
				// The server logs it: the one record of a freeze that leaves nobody a way to copy its details.
				try {
					if (navigator.sendBeacon) {
						navigator.sendBeacon(${JSON.stringify(BOOT_REPORT_PATH)}, JSON.stringify(Object.assign({ page: typeof previous.page === "string" ? previous.page.slice(0, 40) : "" }, previousLoad)));
					}
				} catch {}
			}
		}
		let afterUpdate = false;
		try {
			afterUpdate = !!sessionStorage.getItem(${JSON.stringify(RELOAD_RETURN_MARKER_KEY)});
		} catch {}

		const record = {
			v: 1,
			page: "/" + (location.pathname.split("/")[1] || ""),
			phases: [{ p: "inline", t: now() }],
			mounts: 0,
			remounts: 0,
			beat: now(),
			visibleMs: 0,
			visible: visible(),
			stall: null,
			step: null,
			build: ${JSON.stringify(BUILD_VERSION_LABEL)},
		};
		if (afterUpdate) record.afterUpdate = true;
		let ended = false;
		const save = () => {
			try {
				sessionStorage.setItem(key, JSON.stringify(record));
			} catch {}
		};
		save();
		const phaseReached = () => {
			const last = furthest(record.phases);
			return last ? last.p : "inline";
		};

		const inFlight = new Map();
		let nextFetch = 0;
		const originalFetch = window.fetch;
		if (typeof originalFetch === "function") {
			window.fetch = function () {
				const promise = originalFetch.apply(window, arguments);
				if (!ended && inFlight.size < 100) {
					const input = arguments[0];
					const id = ++nextFetch;
					inFlight.set(id, { path: pathOf(input && typeof input === "object" && "url" in input ? input.url : input), start: now() });
					const settle = () => {
						inFlight.delete(id);
					};
					promise.then(settle, settle);
				}
				return promise;
			};
		}

		const slowest = [];
		const longFrames = [];
		const keepTop = (list, item, by) => {
			list.push(item);
			list.sort((a, b) => b[by] - a[by]);
			if (list.length > limit) list.length = limit;
		};
		const observers = [];
		const observe = (type, callback) => {
			try {
				const observer = new PerformanceObserver(callback);
				observer.observe({ type, buffered: true });
				observers.push(observer);
			} catch {}
		};
		observe("resource", (list) => {
			for (const entry of list.getEntries()) {
				keepTop(slowest, { path: pathOf(entry.name), startMs: Math.round(entry.startTime), durationMs: Math.round(entry.duration) }, "durationMs");
			}
		});
		// Only where the browser has them: Safari and Firefox warn in the console about an unknown entry type.
		const types = typeof PerformanceObserver === "undefined" ? null : PerformanceObserver.supportedEntryTypes;
		if (types && types.includes("long-animation-frame")) {
			observe("long-animation-frame", (list) => {
				for (const entry of list.getEntries()) {
					if (entry.duration <= ${BOOT_LONG_FRAME_MS}) continue;
					const scripts = Array.from(entry.scripts || [])
						.sort((a, b) => b.duration - a.duration)
						.slice(0, 3)
						.map((script) => ({
							source: script.sourceURL ? pathOf(script.sourceURL) : "",
							// An inline or classic script names its page or file as the invoker: a URL, kept like any other
							// (no token, another origin by its origin). "TimerHandler:setTimeout" and the like stay as they are.
							invoker: /^(?:https?:\\/\\/|blob:|data:)/i.test(String(script.invoker || ""))
								? pathOf(script.invoker)
								: clip(script.invoker),
							function: clip(script.sourceFunctionName),
							durationMs: Math.round(script.duration),
						}));
					keepTop(
						longFrames,
						{
							startMs: Math.round(entry.startTime),
							durationMs: Math.round(entry.duration),
							blockingMs: Math.round(entry.blockingDuration || 0),
							scripts,
						},
						"durationMs",
					);
				}
			});
		}

		addEventListener("visibilitychange", () => {
			if (ended) return;
			record.visible = visible();
			save();
		});
		addEventListener("pagehide", () => {
			if (ended) return;
			const at = now();
			record.left = { t: at, gap: at - record.beat };
			save();
		});

		const end = () => {
			if (ended) return;
			ended = true;
			record.ended = now();
			save();
			for (const observer of observers) observer.disconnect();
		};
		const details = () => {
			const at = now();
			return {
				phase: phaseReached(),
				phases: record.phases.map((entry) => ({ phase: entry.p, atMs: entry.t })),
				visibleMs: record.visibleMs,
				loaderMounts: record.mounts,
				overlayRemounts: record.remounts,
				loaderMounted: window.__kiteLoaderMounted === true,
				ready: window.__kiteAppReady === true,
				longestStall: record.stall,
				step: record.step ? { name: record.step.s, atMs: record.step.t } : null,
				inFlight: Array.from(inFlight.values())
					.sort((a, b) => a.start - b.start)
					.slice(0, limit)
					.map((entry) => ({ path: entry.path, startedAtMs: entry.start, ageMs: at - entry.start })),
				slowestResources: slowest.slice(),
				longFrames: longFrames.slice(),
				previousLoad,
			};
		};
		const seconds = (ms) => (ms / 1000).toFixed(1) + " s";
		const text = () => {
			const d = details();
			const lines = [];
			if (d.previousLoad) {
				lines.push(
					"Previous load froze at " + d.previousLoad.phase +
						(d.previousLoad.step ? " (step " + d.previousLoad.step + ")" : "") +
						" after " + seconds(d.previousLoad.afterMs),
				);
			}
			lines.push("Phase: " + d.phase + " (" + d.phases.map((entry) => entry.phase + " " + seconds(entry.atMs)).join(", ") + ")");
			if (d.step) lines.push("Last step: " + d.step.name + " at " + seconds(d.step.atMs));
			lines.push("Visible: " + seconds(d.visibleMs));
			lines.push("Loader mounts: " + d.loaderMounts + ", overlay remounts: " + d.overlayRemounts);
			lines.push("Loader mounted: " + (d.loaderMounted ? "yes" : "no") + ", app ready: " + (d.ready ? "yes" : "no"));
			if (d.longestStall) lines.push("Longest stall: " + seconds(d.longestStall.ms) + " at " + d.longestStall.phase);
			lines.push("In flight: " + (d.inFlight.length ? d.inFlight.map((entry) => entry.path + " (" + seconds(entry.ageMs) + ")").join(", ") : "none"));
			lines.push("Slowest files: " + (d.slowestResources.length ? d.slowestResources.map((entry) => entry.path + " " + seconds(entry.durationMs)).join(", ") : "none"));
			for (const frame of d.longFrames) {
				const script = frame.scripts[0];
				lines.push(
					"Long frame: " + seconds(frame.durationMs) + " at " + seconds(frame.startMs) +
						(script ? " in " + (script.source || "?") + (script.function ? " " + script.function : "") + (script.invoker ? " via " + script.invoker : "") : ""),
				);
			}
			return lines.join("\\n");
		};

		// Copies the details as JSON; without the clipboard API (plain http) or permission, it selects the text shown in
		// \`pre\` and asks the browser to copy that. Resolves to "copied", "selected" or "failed".
		const copy = (pre) => {
			const select = () => {
				if (!pre) return "failed";
				try {
					const range = document.createRange();
					range.selectNodeContents(pre);
					const selection = getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					return document.execCommand("copy") ? "copied" : "selected";
				} catch {
					return "failed";
				}
			};
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					return navigator.clipboard.writeText(JSON.stringify(details(), null, 2)).then(() => "copied", select);
				}
			} catch {}
			return Promise.resolve(select());
		};

		window[${JSON.stringify(BOOT_TRACE_GLOBAL)}] = {
			phase: (name) => {
				if (ended) return;
				if (name === "loader-mounted") record.mounts += 1;
				if (order.indexOf(name) < 0 || record.phases.some((entry) => entry.p === name)) {
					if (name === "loader-mounted") save();
					return;
				}
				record.phases.push({ p: name, t: now() });
				if (name === "complete") return end();
				save();
			},
			step: (name) => {
				if (ended) return;
				record.step = { s: clip(name).slice(0, 40), t: now() };
				save();
			},
			// The watchdog's tick: visible time so far, and how long the page went without a tick while visible.
			beat: (visibleMs) => {
				if (ended) return;
				const at = now();
				const gap = at - record.beat;
				if (record.visible && visible() && gap > freezeGapMs && (!record.stall || gap > record.stall.ms)) {
					record.stall = { ms: gap, phase: phaseReached() };
				}
				record.beat = at;
				record.visibleMs = Math.round(visibleMs);
				record.visible = visible();
				save();
			},
			copy,
			remount: (count) => {
				if (ended) return;
				record.remounts = count;
				save();
			},
			end,
			details,
			text,
		};
	} catch {}
})();`;
