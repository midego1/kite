import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";

type Frame = { file: string; at: number };
type Cut = { from: number; to: number };
type OpenCut = { from: number; untilFrameAfter: number };

/**
 * Records a page as JPEG frames through Chromium's screencast, which keeps every pixel sharp where Playwright's
 * `recordVideo` encodes a soft, low-bitrate VP8. Each frame keeps the moment it was painted, so
 * `encode-demo.mjs` can play the frames back at their real pace. Stretches marked with `cut()` (page loads, model
 * answers) are left out of the film. The screencast belongs to the tab, so it keeps running through a reload.
 */
export class Screencast {
	private readonly frames: Frame[] = [];
	private readonly cuts: Cut[] = [];
	private readonly openCuts: OpenCut[] = [];
	private readonly marks: { label: string; at: number }[] = [];
	private session: CDPSession | null = null;
	private cutStart: number | null = null;
	private pending = Promise.resolve();

	constructor(
		private readonly page: Page,
		private readonly dir: string,
	) {}

	async start({ width, height }: { width: number; height: number }): Promise<void> {
		rmSync(this.dir, { recursive: true, force: true });
		mkdirSync(path.join(this.dir, "frames"), { recursive: true });
		const session = await this.page.context().newCDPSession(this.page);
		this.session = session;
		session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
			const file = `frames/${String(this.frames.length).padStart(5, "0")}.jpg`;
			this.frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
			writeFileSync(path.join(this.dir, file), Buffer.from(data, "base64"));
			this.pending = this.pending
				.then(async () => {
					await session.send("Page.screencastFrameAck", { sessionId });
				})
				.catch(() => {});
		});
		await session.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: width, maxHeight: height });
	}

	/** Notes a moment (a scene starting), which `encode-demo.mjs` prints with its time in the film. */
	mark(label: string): void {
		this.marks.push({ label, at: Date.now() / 1000 });
	}

	/** Leaves out what happens until `resume()`; the film jumps from the last frame before to the first one after. */
	cut(): void {
		this.cutStart ??= Date.now() / 1000;
	}

	resume(): void {
		if (this.cutStart === null) return;
		this.cuts.push({ from: this.cutStart, to: Date.now() / 1000 });
		this.cutStart = null;
	}

	/**
	 * Ends the cut at the first frame painted after `seconds` (a time in seconds since the epoch), for example the
	 * moment a reload committed, so the new page is on camera from its very first paint.
	 */
	resumeAtFirstFrameAfter(seconds: number): void {
		if (this.cutStart === null) return;
		this.openCuts.push({ from: this.cutStart, untilFrameAfter: seconds });
		this.cutStart = null;
	}

	/** Stops recording and writes `manifest.json`: the frames with their times, and the stretches to leave out. */
	async stop(): Promise<void> {
		this.resume();
		await this.pending;
		await this.session?.send("Page.stopScreencast").catch(() => {});
		for (const { from, untilFrameAfter } of this.openCuts) {
			const first = this.frames.find((frame) => frame.at > untilFrameAfter);
			if (first) this.cuts.push({ from, to: first.at - 0.001 });
		}
		writeFileSync(
			path.join(this.dir, "manifest.json"),
			JSON.stringify({ frames: this.frames, cuts: this.cuts, marks: this.marks, endedAt: Date.now() / 1000 }, null, "\t"),
		);
	}
}
