import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

// Turns the recording from `npm run demo:record` into docs/assets/demo.gif (needs ffmpeg).
const input = "test-results/demo/demo.webm";
const output = "docs/assets/demo.gif";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const MAX_BYTES = 8 * 1024 * 1024;
const filter =
	"fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";

const result = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-i", input, "-vf", filter, "-loop", "0", output], {
	stdio: "inherit",
});
if (result.status !== 0) {
	console.error("ffmpeg failed; is it installed?");
	process.exit(1);
}
const bytes = statSync(output).size;
console.log(`${output}: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
if (bytes > MAX_BYTES) {
	console.error("The GIF is over 8 MB; shorten the recording or lower fps/width in this script.");
	process.exit(1);
}
