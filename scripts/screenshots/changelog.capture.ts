import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { STORAGE_STATE } from "../../e2e/support/constants";
import { seedDemoData } from "./demo-data";

// Screenshots for the changelog (docs/releasing.md#screenshots-in-the-changelog), taken against the isolated,
// seeded e2e server, so only invented demo data appears. They land in public/changelog/<name>.webp, ready for a
// fragment's `![what it shows](/changelog/<name>.webp)`. Run them with `npm run changelog:screenshot`; a plain
// `npm run screenshots` skips them, so existing images are never rewritten by accident.
// Add a shot to SHOTS for a new change: `open` gets a page signed in as the demo admin and returns the element
// (a dialog, a panel) or the page to capture.
const RECORD = process.env.KITE_CHANGELOG_SHOTS === "1";
const OUT_DIR = path.join(process.cwd(), "public", "changelog");
/** The limits scripts/changelog-images.mjs enforces. */
const MAX_WIDTH = 1600;
const MAX_BYTES = 200 * 1024;

type Theme = "light" | "dark";
type Shot = {
	/** The file name without `.webp`: lowercase, dated, e.g. `2026-11-02-whats-new-images`. */
	name: string;
	theme?: Theme;
	viewport?: { width: number; height: number };
	open: (page: Page) => Promise<Locator | Page>;
};

const SHOTS: Shot[] = [
	{
		name: "2026-11-02-whats-new-images",
		viewport: { width: 1100, height: 760 },
		open: async (page) => {
			await page.goto("/inbox");
			await page.getByRole("button", { name: /^Updated / }).click();
			const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
			await dialog
				.getByRole("navigation", { name: "Releases" })
				.getByRole("button", { name: /^2026\.11\.01\.2/ })
				.click();
			const thumbnail = dialog.getByRole("button", { name: /command center in light mode/i });
			await thumbnail.scrollIntoViewIfNeeded();
			await expect(thumbnail).toBeVisible();
			await expect.poll(() => dialog.locator("img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete))).toBe(true);
			return dialog;
		},
	},
];

async function openPage(browser: Browser, { theme = "light", viewport }: Shot) {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: viewport ?? { width: 1280, height: 800 },
		colorScheme: theme,
	});
	await context.addInitScript((nextTheme) => {
		localStorage.removeItem("kite-style");
		localStorage.setItem("kite-theme", nextTheme);
	}, theme);
	return context.newPage();
}

/** WebP at the best quality that stays under the size limit, at most MAX_WIDTH wide. */
async function toWebp(png: Buffer): Promise<Buffer> {
	for (const quality of [82, 74, 66, 58, 50]) {
		const webp = await sharp(png).resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality }).toBuffer();
		if (webp.length <= MAX_BYTES) return webp;
	}
	throw new Error("The screenshot does not fit in 200 KB; crop it to the relevant part");
}

test.describe("changelog screenshots", () => {
	test.skip(!RECORD, "Set KITE_CHANGELOG_SHOTS=1 (npm run changelog:screenshot) to take them");
	test.beforeAll(seedDemoData);

	for (const shot of SHOTS) {
		test(shot.name, async ({ browser }) => {
			const page = await openPage(browser, shot);
			const target = await shot.open(page);
			await page.waitForLoadState("networkidle");
			await page.evaluate(() => document.fonts.ready);
			const png = await target.screenshot({ animations: "disabled", caret: "hide" });
			mkdirSync(OUT_DIR, { recursive: true });
			writeFileSync(path.join(OUT_DIR, `${shot.name}.webp`), await toWebp(png));
			await page.context().close();
		});
	}
});
