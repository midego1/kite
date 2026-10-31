import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import { STORAGE_STATE } from "../../e2e/support/constants";
import { DRIVE_UPLOAD, NEWSLETTER, THREAD, WRITE_REQUEST, mockConnectedAccounts, seedHeroData, startDemoModel } from "./demo-hero-data";
import { OVERLAY_SCRIPT } from "./demo-overlay";
import { Screencast } from "./screencast";

// Records the README animation (docs/assets/kite-tour.gif and .mp4) against the isolated, seeded e2e server, so
// only invented demo data appears. Run it with `npm run demo:record`; a plain `npm run screenshots` skips it.
// The scenes are the real app; only the connected accounts list and the model answers are stand-ins.
const RECORD = process.env.KITE_RECORD_DEMO === "1";
const OUT_DIR = "test-results/demo";
const VIEWPORT = { width: 1280, height: 800 };
/** The page renders at 2x; the screencast still delivers frames at the viewport's size in CSS pixels. */
const SCALE = 2;

let restoreModel: (() => Promise<void>) | undefined;

test.describe("demo recording", () => {
	test.skip(!RECORD, "Set KITE_RECORD_DEMO=1 (npm run demo:record) to record the demo");
	test.beforeAll(async () => {
		await seedHeroData();
		restoreModel = await startDemoModel();
	});
	test.afterAll(async () => {
		await restoreModel?.();
	});

	test("the README tour", async ({ browser }) => {
		test.setTimeout(1_800_000);
		await warmUp(browser);
		const { page, version, film } = await openTour(browser);
		const director = new Director(page, film);
		try {
			await scenes(director, version);
		} finally {
			// A failed run still leaves its frames and manifest behind, to see where it went wrong.
			await film.stop();
			await page.context().close();
		}
	});
});

const THREAD_SUBJECT = THREAD[0]!.subject;
const ADMIN_ALERTS = { enabled: false, alerts: [], signature: null };

/** Under `vite dev` every route compiles on its first visit; visiting them once keeps that out of the film. */
async function warmUp(browser: Browser) {
	const context = await browser.newContext({ storageState: STORAGE_STATE, viewport: VIEWPORT });
	const page = await context.newPage();
	for (const path of ["/inbox", "/calendar", "/drive", "/settings/connected-accounts", "/admin", "/settings/appearance"]) {
		await page.goto(path);
		await expect(page.getByRole("main").first()).toBeVisible({ timeout: 240_000 });
		await page.waitForLoadState("networkidle");
	}
	await page.goto("/inbox");
	await page.getByRole("main").getByText(THREAD_SUBJECT).first().click();
	await expect(page.getByRole("list", { name: "Participants" })).toBeVisible({ timeout: 120_000 });
	await page.getByRole("button", { name: "Reply (r)" }).click();
	await expect(page.getByRole("textbox", { name: "Message body" })).toBeVisible({ timeout: 120_000 });
	await context.close();
}

async function openTour(browser: Browser) {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: VIEWPORT,
		deviceScaleFactor: SCALE,
		colorScheme: "light",
	});
	await context.addInitScript(() => {
		if (sessionStorage.getItem("hero-started")) return;
		sessionStorage.setItem("hero-started", "1");
		localStorage.removeItem("kite-style");
		localStorage.setItem("kite-theme", "light");
		localStorage.setItem("kite-message-density", "compact");
		localStorage.setItem("kite-reading-pane", "right");
	});
	await context.addInitScript(OVERLAY_SCRIPT);
	const page = await context.newPage();
	// The demo install has no sending provider, so Admin would lead with an "Operational alerts" notice.
	await page.route("**/api/admin/alerts/active", (route) => route.fulfill({ json: ADMIN_ALERTS }));
	await mockConnectedAccounts(page);
	const version = { current: "demo-1" };
	await page.route("**/api/version", (route) =>
		route.fulfill({ json: { version: version.current }, headers: { "Cache-Control": "no-store" } }),
	);
	await page.clock.install();
	const film = new Screencast(page, OUT_DIR);
	return { page, version, film };
}

/** Moves a drawn pointer like a hand would: eased, never in a straight robotic line, and records it all. */
class Director {
	private x = VIEWPORT.width * 0.62;
	private y = VIEWPORT.height * 0.55;

	constructor(
		readonly page: Page,
		readonly film: Screencast,
	) {}

	/** Shows the pointer where the next glide starts. */
	parkPointer() {
		return this.page.mouse.move(this.x, this.y);
	}

	pause(ms: number) {
		return this.page.waitForTimeout(ms);
	}

	async caption(text: string | null) {
		this.film.mark(text ?? "(no caption)");
		await this.offCamera(() => this.page.evaluate((value) => (window as unknown as { __heroCaption: (text: string | null) => void }).__heroCaption(value), text));
	}

	/** Eased and slightly arced, as a wrist moves. Paced by the clock, so a busy machine skips points, not time. */
	async glideTo(x: number, y: number, ms = 650) {
		const [fromX, fromY] = [this.x, this.y];
		const bend = Math.min(50, Math.hypot(x - fromX, y - fromY) * 0.1);
		const started = Date.now();
		for (let t = 0; t < 1; ) {
			t = Math.min(1, (Date.now() - started) / ms);
			const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
			const lift = Math.sin(Math.PI * eased) * bend;
			await this.page.mouse.move(fromX + (x - fromX) * eased, fromY + (y - fromY) * eased - lift);
			await this.page.waitForTimeout(8);
		}
		[this.x, this.y] = [x, y];
	}

	/** Types `text` into a field at about `charsPerSecond`, paced by the clock like `glideTo`. */
	async type(field: Locator, text: string, charsPerSecond = 38) {
		const started = Date.now();
		for (let shown = 0; shown < text.length; ) {
			shown = Math.min(text.length, Math.ceil(((Date.now() - started) / 1000) * charsPerSecond));
			await field.fill(text.slice(0, shown));
			await this.page.waitForTimeout(16);
		}
	}

	async glide(target: Locator, ms?: number, offset = { x: 0.5, y: 0.5 }) {
		// Finding the target takes a few round trips while nothing moves on screen; they are left out.
		const box = await this.offCamera(async () => {
			await target.scrollIntoViewIfNeeded();
			return target.boundingBox();
		});
		if (!box) throw new Error("Cannot move the pointer to an element that is not visible");
		await this.glideTo(box.x + box.width * offset.x, box.y + box.height * offset.y, ms);
	}

	async click(target: Locator, ms?: number) {
		await this.glide(target, ms);
		await this.pause(120);
		await this.page.mouse.down();
		await this.pause(70);
		await this.page.mouse.up();
	}

	/** Waits for the app off camera: the film jumps from just before the wait to just after it. */
	async offCamera<T>(work: () => Promise<T>): Promise<T> {
		this.film.cut();
		try {
			return await work();
		} finally {
			this.film.resume();
		}
	}

	async setTheme(theme: "light" | "dark") {
		await this.page.evaluate(async (value) => {
			const apply = () => {
				localStorage.setItem("kite-theme", value);
				document.documentElement.classList.toggle("dark", value === "dark");
				document.documentElement.classList.toggle("light", value !== "dark");
				window.dispatchEvent(new CustomEvent("kite:theme-changed", { detail: value }));
			};
			const style = document.createElement("style");
			style.textContent =
				"::view-transition-old(root),::view-transition-new(root){animation-duration:.7s;animation-timing-function:ease-in-out}";
			document.head.appendChild(style);
			if (!("startViewTransition" in document)) return apply();
			await document.startViewTransition(apply).finished;
			style.remove();
		}, theme);
	}
}

/** The film's Drive upload: big enough for the progress to show, filler bytes. */
function uploadFile() {
	const file = path.resolve(OUT_DIR, "..", "demo-upload", DRIVE_UPLOAD);
	mkdirSync(path.dirname(file), { recursive: true });
	if (!existsSync(file)) writeFileSync(file, Buffer.alloc(24 * 1024 * 1024, 32));
	return file;
}

/** Waits until the page shows its data, with the startup splash gone. */
async function settled(page: Page) {
	await expect(page.locator("[data-loading-overlay]")).toHaveCSS("opacity", "0", { timeout: 120_000 });
	await expect(page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0, { timeout: 120_000 });
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => document.fonts.ready);
}

function mailRow(page: Page, subject: string | RegExp) {
	return page.locator("[data-message-row]").filter({ hasText: subject }).first();
}

async function scenes(d: Director, version: { current: string }) {
	const { page, film } = d;
	const offCamera = d.offCamera.bind(d);

	// 1. The inbox: compact rows, attachments at a glance.
	await page.goto("/inbox");
	await expect(mailRow(page, NEWSLETTER.subject)).toBeVisible({ timeout: 120_000 });
	await settled(page);
	await d.parkPointer();
	await film.start(VIEWPORT);
	await d.pause(400);
	await d.caption("Your mail, on your own Cloudflare");
	await d.glide(mailRow(page, "Signed pilot agreement"), 800, { x: 0.55, y: 0.5 });
	await d.glide(mailRow(page, "Photos from the Lisbon offsite"), 450, { x: 0.6, y: 0.5 });
	await d.pause(600);

	// 2. A conversation and the people in it.
	await d.click(mailRow(page, THREAD_SUBJECT), 650);
	const chips = page.getByRole("list", { name: "Participants" });
	await offCamera(() => expect(chips).toBeVisible());
	await d.caption("Every conversation, every person at a glance");
	await d.pause(500);
	await d.click(chips.getByRole("button", { name: /Sofia/ }).first(), 650);
	await offCamera(() => expect(page.getByRole("dialog", { name: /Contact card for/ })).toBeVisible());
	await d.pause(1200);
	await page.keyboard.press("Escape");
	await d.pause(200);

	// 3. AI that helps, and waits for you.
	await d.caption("AI that summarizes and drafts, and asks before it acts");
	await d.click(page.getByRole("button", { name: "Summarize conversation" }), 650);
	const summary = page.getByRole("region", { name: "AI summary" });
	await offCamera(() => expect(summary).toContainText("Next steps"));
	await d.glide(summary, 600, { x: 0.45, y: 0.45 });
	await d.pause(1000);
	await d.click(page.getByRole("button", { name: "Reply (r)" }), 550);
	const body = page.getByRole("textbox", { name: "Message body" });
	await offCamera(() => expect(body).toHaveAttribute("contenteditable", "true"));
	// The Write with Kite panel opens at the bottom, where the caption sits.
	await d.caption(null);
	await d.click(page.getByRole("button", { name: "Write with Kite" }), 550);
	const panel = page.getByRole("dialog", { name: "Write with Kite" });
	const request = panel.getByLabel("What should this email say?");
	await offCamera(() => expect(request).toBeEditable());
	await d.type(request, WRITE_REQUEST);
	await d.click(panel.getByRole("button", { name: "Write", exact: true }), 400);
	await offCamera(() => expect(panel.getByRole("button", { name: "Insert", exact: true })).toBeVisible());
	await d.pause(900);
	await d.click(panel.getByRole("button", { name: "Insert", exact: true }), 450);
	await offCamera(() => expect(body).toContainText("FAQ"));
	await d.pause(900);
	// Closing keeps the reply as a draft.
	await d.click(page.getByRole("button", { name: "Close composer" }).filter({ visible: true }).first(), 450);
	await offCamera(() => expect(body).toHaveCount(0));

	// 4. Dark mode that keeps designed mail readable.
	await d.caption("Dark mode that keeps every email readable");
	await d.setTheme("dark");
	await d.click(mailRow(page, NEWSLETTER.subject), 600);
	const original = page.getByRole("button", { name: "Original colours" });
	await offCamera(async () => {
		await expect(original).toBeVisible();
		await expect(page.getByTitle("Message body").contentFrame().getByText("Shop the roasts")).toBeVisible();
	});
	await d.pause(700);
	await d.click(original, 600);
	await d.pause(1000);
	await d.click(original, 200);
	await d.pause(500);

	// 5. Calendar and Drive.
	await offCamera(async () => {
		await page.goto("/calendar");
		await expect(page.getByRole("button", { name: /Design review: onboarding/ }).first()).toBeVisible();
		await settled(page);
	});
	await d.caption("Calendar and Drive, built in");
	await d.glide(page.getByRole("button", { name: /Customer call: Contoso/ }).first(), 800);
	await d.pause(900);
	await offCamera(async () => {
		await page.goto("/drive");
		await expect(page.getByText("Launch plan.pdf").first()).toBeVisible();
		await settled(page);
	});
	const chooser = page.waitForEvent("filechooser");
	await d.click(page.getByRole("button", { name: "Upload files" }).filter({ visible: true }).first(), 650);
	// A file on disk is handed over by path; a buffer would be copied through the protocol for seconds.
	await offCamera(async () => (await chooser).setFiles(uploadFile()));
	await d.pause(1100);
	await offCamera(() => expect(page.getByRole("region", { name: "Uploads" }).getByLabel("Uploaded")).toBeVisible({ timeout: 300_000 }));
	await d.pause(1000);

	// 6. Connected accounts.
	await offCamera(async () => {
		await page.goto("/settings/connected-accounts");
		await expect(page.getByText("demo.user@icloud.example").first()).toBeVisible({ timeout: 120_000 });
		await settled(page);
	});
	await d.caption("Bring your Gmail and iCloud along");
	await d.glide(page.getByText("demo.user@icloud.example").first(), 800);
	await d.pause(1300);

	// 7. Admin: what needs attention comes first.
	await offCamera(async () => {
		await page.goto("/admin");
		await expect(page.getByRole("region", { name: "Needs attention" })).toBeVisible({ timeout: 120_000 });
		await settled(page);
	});
	await d.caption("Admin that leads with what needs you");
	await d.glide(page.getByRole("region", { name: "Needs attention" }), 800, { x: 0.3, y: 0.5 });
	await d.pause(1300);

	// 8. An update lands: the kite flies off and comes back with the new version.
	const notice = page.locator("[data-update-notice]");
	await offCamera(async () => {
		await page.goto("/inbox");
		await expect(mailRow(page, NEWSLETTER.subject)).toBeVisible({ timeout: 120_000 });
		await settled(page);
		version.current = "demo-2";
		await page.clock.fastForward("01:01");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(notice).toBeVisible();
	});
	await d.caption("Updates arrive on their own");
	await d.pause(700);
	const entry = await holdEntryModule(page);
	let committedAt = 0;
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame() && !committedAt) committedAt = Date.now() / 1000;
	});
	await d.click(notice.getByRole("button", { name: "Reload" }), 700);
	// The flight takes about a second; then the reload, whose wait for the server is left out.
	await d.pause(1100);
	film.cut();
	// The held entry module also holds the load event, so wait for the reloaded document's startup screen instead.
	await page.waitForSelector("html.kite-reload-return", { state: "attached", timeout: 120_000 });
	film.resumeAtFirstFrameAfter(committedAt);
	await d.pause(2300);
	await entry.release();
	await offCamera(async () => {
		await expect(mailRow(page, NEWSLETTER.subject)).toBeVisible({ timeout: 120_000 });
		await settled(page);
	});
	await d.caption("Kite · open source mail for your own domains");
	await d.pause(2200);
}

/**
 * Holds the app's entry module after the reload, so the startup screen with the returning kite stays up for a
 * moment as it would on a slower connection (the same trick as e2e/91-update-reload-return.spec.ts).
 */
async function holdEntryModule(page: Page) {
	const held: Route[] = [];
	let holding = true;
	await page.route(
		(url) => url.pathname.endsWith("/entry-browser"),
		async (route) => {
			if (!holding) return route.continue();
			held.push(route);
		},
	);
	return {
		release: async () => {
			holding = false;
			await Promise.all(held.splice(0).map((route) => route.continue()));
		},
	};
}
