import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE } from "../../e2e/support/constants";
import { apiContext, openMessage, setSendingSettings } from "../../e2e/support/helpers";
import { OPENED, seedDemoData } from "./demo-data";

// Records the README demo against the isolated, seeded e2e server. Run it with `npm run demo:record`;
// a plain `npm run screenshots` skips it.
const RECORD = process.env.KITE_RECORD_DEMO === "1";
const DEMO_VIDEO_DIR = "test-results/demo";

test.describe("demo recording", () => {
	test.skip(!RECORD, "Set KITE_RECORD_DEMO=1 (npm run demo:record) to record the demo");
	test.beforeAll(async () => {
		await seedDemoData();
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: true, undoSeconds: 10 });
		await api.dispose();
	});

	// Headless recordings have no pointer, so draw one that follows the mouse.
	const POINTER = `
		const dot = document.createElement("div");
		dot.style.cssText = "position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(79,70,229,.55);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;left:-50px;top:-50px;transition:transform .08s";
		const attach = () => document.documentElement.appendChild(dot);
		if (document.documentElement) attach(); else addEventListener("DOMContentLoaded", attach);
		addEventListener("mousemove", (event) => { dot.style.left = event.clientX + "px"; dot.style.top = event.clientY + "px"; }, true);
		addEventListener("mousedown", () => { dot.style.transform = "scale(.7)"; }, true);
		addEventListener("mouseup", () => { dot.style.transform = "scale(1)"; }, true);
	`;

	async function glideTo(page: Page, target: ReturnType<Page["locator"]>) {
		const box = await target.boundingBox();
		if (!box) throw new Error("Cannot move the pointer to an element that is not visible");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
		await page.waitForTimeout(250);
	}

	async function click(page: Page, target: ReturnType<Page["locator"]>) {
		await glideTo(page, target);
		await target.click();
	}

	test("inbox, reply with preview and undo, calendar, domains", async ({ browser }) => {
		mkdirSync(DEMO_VIDEO_DIR, { recursive: true });
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			viewport: { width: 1280, height: 800 },
			recordVideo: { dir: DEMO_VIDEO_DIR, size: { width: 1280, height: 800 } },
			colorScheme: "light",
		});
		await context.addInitScript(() => {
			localStorage.setItem("kite-style", "kite");
			localStorage.setItem("kite-theme", "light");
		});
		await context.addInitScript(POINTER);
		const page = await context.newPage();
		const pause = (ms: number) => page.waitForTimeout(ms);

		await page.goto("/inbox");
		await expect(page.getByRole("main").getByText(OPENED.subject).first()).toBeVisible();
		await page.mouse.move(640, 400);
		await pause(1800);

		const row = page.getByRole("main").getByText(OPENED.subject, { exact: true }).first();
		await glideTo(page, row);
		await openMessage(page, OPENED.subject);
		await expect(page.locator("iframe").first().contentFrame().getByText(/Happy to pair/)).toBeAttached();
		await pause(2200);

		await click(page, page.getByRole("button", { name: "Reply (r)" }));
		const body = page.getByRole("textbox", { name: "Message body" });
		await body.click();
		await body.pressSequentially("Hi Lena,\n\nGreat notes, thank you. Does Thursday afternoon work to pair on the welcome email?\n\nBest,\nDemo", {
			delay: 28,
		});
		await pause(900);

		await click(page, page.getByRole("button", { name: "Review send" }));
		const dialog = page.getByRole("dialog", { name: "Preview email before sending" });
		await expect(dialog).toBeVisible();
		await pause(2200);
		await click(page, dialog.getByRole("button", { name: "Confirm and send" }));
		const undoBar = page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
		await expect(undoBar).toBeVisible();
		await pause(1800);
		await click(page, undoBar.getByRole("button", { name: "Undo" }));
		await expect(page.getByText("Sending undone")).toBeVisible();
		await pause(1800);

		await page.goto("/calendar");
		await expect(page.getByRole("button", { name: /Design review: onboarding/ }).first()).toBeVisible();
		await page.mouse.move(700, 420, { steps: 10 });
		await pause(2800);

		await page.goto("/domains");
		await click(page, page.getByRole("button", { name: "Show details" }).first());
		await expect(page.getByRole("main").getByText("example.com").first()).toBeVisible();
		await pause(3200);

		const video = page.video();
		await context.close();
		await video?.saveAs(`${DEMO_VIDEO_DIR}/demo.webm`);
	});
});
