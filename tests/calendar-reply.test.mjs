import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-calendar-reply-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/calendar/utils.ts")],
	outfile: join(outDir, "utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { createCalendarReply, createCalendarInvitation } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);
const text = (buffer) => new TextDecoder().decode(buffer);
const unfold = (value) => value.replace(/\r\n /g, "");

const base = {
	uid: "ABC-123@calendar.test",
	organizer: "olivia@example.org",
	attendee: "reviewer@example.com",
	partstat: "ACCEPTED",
	sequence: 2,
	now: new Date("2026-04-01T09:00:00Z"),
};

test("reply is METHOD:REPLY with the organizer's exact UID", () => {
	const body = text(createCalendarReply(base));
	const lines = body.split("\r\n");
	assert.ok(lines.includes("METHOD:REPLY"));
	assert.ok(lines.includes("UID:ABC-123@calendar.test"));
	assert.ok(!body.includes("@mailflare"));
	assert.ok(lines.includes("ORGANIZER:mailto:olivia@example.org"));
	assert.ok(lines.includes("ATTENDEE;PARTSTAT=ACCEPTED:mailto:reviewer@example.com"));
	assert.ok(lines.includes("SEQUENCE:2"));
	assert.ok(lines.includes("DTSTAMP:20260401T090000Z"));
	assert.equal(lines[0], "BEGIN:VCALENDAR");
	assert.equal(lines.at(-1), "END:VCALENDAR");
});

test("reply supports declined/tentative, name, summary and times; negative sequence clamps to 0", () => {
	const body = text(
		createCalendarReply({
			...base,
			partstat: "DECLINED",
			attendeeName: 'Re "viewer"',
			summary: "Plan, review; \\ done\nnext",
			startsAt: new Date("2026-04-15T13:00:00Z"),
			endsAt: new Date("2026-04-15T14:00:00Z"),
			sequence: -5,
		}),
	);
	const unfolded = unfold(body);
	assert.ok(unfolded.includes('ATTENDEE;PARTSTAT=DECLINED;CN="Re viewer":mailto:reviewer@example.com'));
	assert.ok(unfolded.includes("SUMMARY:Plan\\, review\\; \\\\ done\\nnext"));
	assert.ok(unfolded.includes("DTSTART:20260415T130000Z"));
	assert.ok(unfolded.includes("DTEND:20260415T140000Z"));
	assert.ok(unfolded.includes("SEQUENCE:0"));
	assert.ok(createCalendarReply({ ...base }) instanceof ArrayBuffer);
	assert.ok(text(createCalendarReply({ ...base, partstat: "TENTATIVE" })).includes("PARTSTAT=TENTATIVE"));
});

test("lines fold at 75 octets without splitting multi-byte characters and unfold losslessly", () => {
	const uid = `${"u".repeat(120)}@example.com`;
	const summary = "é".repeat(100) + "😀".repeat(30);
	const body = text(createCalendarReply({ ...base, uid, summary }));
	for (const line of body.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
	assert.ok(body.includes("\r\n "));
	const unfolded = unfold(body);
	assert.ok(unfolded.includes(`UID:${uid}`));
	assert.ok(unfolded.includes(`SUMMARY:${summary}`));
	assert.ok(!body.includes("\uFFFD"));
});

test("control characters in identifiers are refused", () => {
	assert.throws(() => createCalendarReply({ ...base, uid: "a\r\nMETHOD:CANCEL" }));
	assert.throws(() => createCalendarReply({ ...base, organizer: "a@b\nX:y" }));
	assert.throws(() => createCalendarReply({ ...base, attendee: "a@b\nX:y" }));
});

test("invitations still carry the @mailflare suffix", () => {
	const body = text(
		createCalendarInvitation({
			title: "T",
			description: "D",
			location: "L",
			startsAt: new Date("2026-04-15T13:00:00Z"),
			endsAt: new Date("2026-04-15T14:00:00Z"),
			uid: "event-1",
		}),
	);
	assert.ok(body.includes("\r\nUID:event-1@mailflare\r\n"));
	assert.ok(body.includes("METHOD:REQUEST"));
	assert.ok(
		text(
			createCalendarInvitation({
				title: "T",
				description: "D",
				location: "L",
				startsAt: new Date(),
				endsAt: new Date(),
				uid: "x",
				method: "CANCEL",
			}),
		).includes("METHOD:CANCEL"),
	);
});
