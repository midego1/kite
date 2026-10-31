import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// Turns the frames `npm run demo:record` captured (test-results/demo, see screencast.ts) into the README animation:
// docs/assets/kite-tour.mp4 (H.264, for the link under the GIF) and docs/assets/kite-tour.gif (needs ffmpeg 5+;
// FFMPEG_PATH points at another binary, for example `npx ffmpeg-static`'s).
const DIR = "test-results/demo";
const MP4 = "docs/assets/kite-tour.mp4";
const GIF = "docs/assets/kite-tour.gif";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const GIF_WIDTH = Number(process.env.DEMO_GIF_WIDTH ?? 1280);
const GIF_FPS = Number(process.env.DEMO_GIF_FPS ?? 15);
const MAX_GIF_BYTES = 10 * 1024 * 1024;
/** The last frame stays on screen this long before the loop starts again. */
const HOLD_END_SECONDS = 1.2;

const { frames, cuts, marks = [], endedAt } = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8"));
if (!frames.length) throw new Error("No frames were recorded; run `npm run demo:record`.");

/** How much of [from, to) is on camera, with the cut stretches taken out. */
function onCamera(from, to) {
	let seconds = Math.max(0, to - from);
	for (const cut of cuts) seconds -= Math.max(0, Math.min(to, cut.to) - Math.max(from, cut.from));
	return seconds;
}

// The concat demuxer plays each frame for its duration: until the next frame was painted, minus any cut.
const lines = ["ffconcat version 1.0"];
let total = 0;
frames.forEach((frame, index) => {
	const until = index + 1 < frames.length ? frames[index + 1].at : endedAt;
	let duration = onCamera(frame.at, until);
	if (index === frames.length - 1) duration += HOLD_END_SECONDS;
	if (duration < 0.001) return;
	total += duration;
	lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`);
});
// The demuxer ignores the last entry's duration unless the file is listed once more.
lines.push(lines.at(-2));
writeFileSync(path.join(DIR, "frames.ffconcat"), `${lines.join("\n")}\n`);
console.log(`${frames.length} frames, ${total.toFixed(1)} s on camera`);
for (const { label, at } of marks) console.log(`  ${onCamera(frames[0].at, at).toFixed(1).padStart(5)} s  ${label}`);

function ffmpeg(args) {
	const result = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(DIR, "frames.ffconcat"), ...args], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		console.error("ffmpeg failed; is it installed (or FFMPEG_PATH set)?");
		process.exit(1);
	}
}

function report(file) {
	const bytes = statSync(file).size;
	console.log(`${file}: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
	return bytes;
}

ffmpeg([
	"-vf",
	"fps=30,format=yuv420p",
	"-c:v",
	"libx264",
	"-preset",
	"slow",
	"-crf",
	"20",
	"-tune",
	"animation",
	"-movflags",
	"+faststart",
	"-an",
	MP4,
]);
report(MP4);

// One palette for the whole film (the UI has few colours), dithered lightly so text stays crisp, and only the
// changed rectangle of each frame stored.
ffmpeg([
	"-vf",
	`fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
	"-loop",
	"0",
	GIF,
]);
if (report(GIF) > MAX_GIF_BYTES) {
	console.error("The GIF is over 10 MB; shorten the recording or lower DEMO_GIF_FPS / DEMO_GIF_WIDTH.");
	process.exit(1);
}
