import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-send-limits-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const limits = await bundle("src/lib/email/send-limits-utils.ts", "limits.mjs");
const errors = await bundle("src/app/api/send/error-utils.ts", "errors.mjs");

test("send limits default to 100 an hour and 500 a day", () => {
	assert.deepEqual(limits.resolveSendLimits({}), { perHour: 100, perDay: 500 });
});

test("send limits can be changed or turned off from the environment", () => {
	assert.deepEqual(limits.resolveSendLimits({ SEND_LIMIT_PER_HOUR: "20", SEND_LIMIT_PER_DAY: " 80 " }), {
		perHour: 20,
		perDay: 80,
	});
	assert.deepEqual(limits.resolveSendLimits({ SEND_LIMIT_PER_HOUR: "0", SEND_LIMIT_PER_DAY: "0" }), {
		perHour: 0,
		perDay: 0,
	});
});

test("unreadable limit values fall back to the default instead of removing the limit", () => {
	for (const value of ["abc", "-5", "1.5", "", "   "]) {
		assert.deepEqual(
			limits.resolveSendLimits({ SEND_LIMIT_PER_HOUR: value, SEND_LIMIT_PER_DAY: value }),
			{ perHour: 100, perDay: 500 },
			JSON.stringify(value),
		);
	}
});

test("a user under both limits may send", () => {
	assert.equal(limits.describeSendLimitBreach({ lastHour: 99, lastDay: 499 }, { perHour: 100, perDay: 500 }), null);
});

test("the hourly limit refuses the send that would exceed it", () => {
	const message = limits.describeSendLimitBreach({ lastHour: 100, lastDay: 100 }, { perHour: 100, perDay: 500 });
	assert.match(message, /^Sending limit reached: at most 100 messages an hour/);
	assert.match(message, /SEND_LIMIT_PER_HOUR/);
});

test("the daily limit applies even when the hour is quiet", () => {
	const message = limits.describeSendLimitBreach({ lastHour: 1, lastDay: 500 }, { perHour: 100, perDay: 500 });
	assert.match(message, /at most 500 messages a day/);
});

test("a window set to 0 is not limited", () => {
	assert.equal(limits.describeSendLimitBreach({ lastHour: 9999, lastDay: 1 }, { perHour: 0, perDay: 500 }), null);
	assert.equal(limits.describeSendLimitBreach({ lastHour: 1, lastDay: 9999 }, { perHour: 100, perDay: 0 }), null);
});

test("a refused send answers 429 on the send routes", () => {
	const message = limits.describeSendLimitBreach({ lastHour: 100, lastDay: 100 }, { perHour: 100, perDay: 500 });
	assert.equal(errors.getSendErrorStatus(message), 429);
	assert.equal(errors.getSendErrorStatus("Mailbox not found"), 403);
});
