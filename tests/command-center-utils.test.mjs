import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-command-center-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/command-center/command-center-utils.ts")],
	outfile: join(bundleDirectory, "center.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const {
	accountLines,
	attentionHref,
	canConnectAccounts,
	dateLabel,
	greetingFor,
	healthLines,
	hourIn,
	statusChips,
	statusChipsInput,
} = await import(pathToFileURL(join(bundleDirectory, "center.mjs")).href);

const MAX_ACCOUNT_LINES = 4;
/** What the Accounts card says about a working account whose last check was `iso` ago. */
const relativeTime = (iso, now) => {
	const [line] = accountLines({
		accounts: [
			{ id: "a", label: "A", address: "a@example.com", status: "active", sync: { running: false, lastSuccessAt: iso } },
		],
		now,
	});
	return line.detail === "Not checked yet" ? "" : line.detail.replace(/^Synced /, "");
};

const NOW = new Date("2026-10-31T08:14:00Z");

test("the greeting follows the hour", () => {
	assert.equal(greetingFor(3), "Good night");
	assert.equal(greetingFor(5), "Good morning");
	assert.equal(greetingFor(11), "Good morning");
	assert.equal(greetingFor(12), "Good afternoon");
	assert.equal(greetingFor(17), "Good afternoon");
	assert.equal(greetingFor(18), "Good evening");
	assert.equal(greetingFor(23), "Good evening");
});

test("the hour is read in the user's time zone, with the device's as the fallback", () => {
	assert.equal(hourIn(NOW, "UTC"), 8);
	assert.equal(hourIn(NOW, "Europe/Amsterdam"), 9);
	assert.equal(hourIn(NOW, "Pacific/Auckland"), 21);
	assert.equal(hourIn(NOW, "Not/AZone"), NOW.getHours());
});

test("the date line names the weekday, day, month and year in the zone", () => {
	assert.equal(dateLabel(NOW, "UTC", "en-GB"), "Saturday 31 October 2026");
	assert.equal(dateLabel(new Date("2026-10-31T23:30:00Z"), "Pacific/Auckland", "en-GB"), "Sunday 1 November 2026");
	assert.equal(dateLabel(NOW, "Not/AZone", "en-GB"), NOW.toDateString());
});

test("status chips: unread always, Screener while it screens or holds mail, For you once known and shown", () => {
	const base = {
		unread: 12,
		folderTitle: "Inbox",
		folderHref: "/inbox",
		held: 0,
		screenerOn: false,
		forYou: null,
		forYouVisible: false,
	};
	assert.deepEqual(
		statusChips(base).map((chip) => chip.label),
		["12 unread in Inbox"],
	);
	assert.deepEqual(
		statusChips({ ...base, screenerOn: true, held: 3 }).map((chip) => [chip.id, chip.label, chip.href]),
		[
			["unread", "12 unread in Inbox", "/inbox"],
			["screener", "3 in Screener", "/screener"],
		],
	);
	// Held mail keeps the chip after the Screener was switched to Inbox mode.
	assert.equal(statusChips({ ...base, held: 1 }).length, 2);
	assert.equal(statusChips({ ...base, forYou: 2, forYouVisible: false }).length, 1);
	assert.equal(statusChips({ ...base, forYou: null, forYouVisible: true }).length, 1);
	const all = statusChips({ ...base, screenerOn: true, held: 3, forYou: 2, forYouVisible: true });
	assert.deepEqual(
		all.map((chip) => chip.label),
		["12 unread in Inbox", "3 in Screener", "2 For you"],
	);
	assert.equal(all[2].href, "/for-you");
	// A tile draws the number large and what it counts under it; together they read as the label.
	assert.deepEqual(
		all.map((chip) => [chip.value, chip.caption]),
		[
			[12, "unread in Inbox"],
			[3, "in Screener"],
			[2, "For you"],
		],
	);
	const starred = statusChips({ ...base, unread: 0, folderTitle: "Starred", folderHref: "/starred" })[0];
	assert.equal(starred.label, "0 unread in Starred");
	assert.equal(starred.href, "/starred");
});

test("relative time reads naturally and says nothing about the future or nothing", () => {
	const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
	assert.equal(relativeTime(null, NOW), "");
	assert.equal(relativeTime("not a date", NOW), "");
	assert.equal(relativeTime(at(-30), NOW), "");
	assert.equal(relativeTime(at(20), NOW), "just now");
	assert.equal(relativeTime(at(180), NOW), "3 min ago");
	assert.equal(relativeTime(at(2 * 3600), NOW), "2 h ago");
	assert.equal(relativeTime(at(26 * 3600), NOW), "yesterday");
	assert.equal(relativeTime(at(5 * 86400), NOW), "5 days ago");
});

function account(overrides) {
	return {
		id: "a",
		label: "Gmail",
		address: "jamie@example.com",
		status: "active",
		sync: { running: false, lastSuccessAt: new Date(NOW.getTime() - 3 * 60_000).toISOString() },
		...overrides,
	};
}

test("account lines: a tone and detail per status, failures first, at most four", () => {
	const lines = accountLines({
		accounts: [
			account({ id: "ok" }),
			account({ id: "paused", status: "paused" }),
			account({ id: "auth", status: "auth_failed", label: "" }),
			account({ id: "tls", status: "tls_failed" }),
			account({ id: "err", status: "error" }),
			account({ id: "off", status: "disabled" }),
		],
		now: NOW,
	});
	assert.equal(lines.length, MAX_ACCOUNT_LINES);
	assert.deepEqual(
		lines.map((line) => [line.id, line.tone, line.detail, line.action?.label ?? null]),
		[
			["auth", "warn", "Sign-in failed", "Reconnect"],
			["tls", "warn", "Certificate problem", "Review"],
			["err", "warn", "Checking stopped", "Review"],
			["ok", "ok", "Synced 3 min ago", null],
		],
	);
	// An account without a label is named by its address.
	assert.equal(lines[0].name, "jamie@example.com");
	assert.equal(lines[0].action.href, "/settings/connected-accounts");
});

test("account lines: the quiet states and a check that runs now", () => {
	const lines = accountLines({
		accounts: [
			account({ id: "paused", status: "paused" }),
			account({ id: "off", status: "disabled" }),
			account({ id: "running", sync: { running: true, lastSuccessAt: null } }),
			account({ id: "never", sync: { running: false, lastSuccessAt: null } }),
		],
		now: NOW,
	});
	assert.deepEqual(
		lines.map((line) => [line.id, line.tone, line.detail]),
		[
			["running", "ok", "Checking now"],
			["never", "ok", "Not checked yet"],
			["paused", "muted", "Paused"],
			["off", "muted", "Off"],
		],
	);
	assert.deepEqual(accountLines({ accounts: [], now: NOW }), []);
});

test("the chips' input defaults what is not known, and the accounts card shows only when it may", () => {
	const quiet = { loaded: false, total: 0, mailboxes: [] };
	assert.deepEqual(
		statusChipsInput({
			unread: undefined,
			folderTitle: "Inbox",
			folderHref: "/inbox",
			held: undefined,
			screener: null,
			suggestions: quiet,
		}),
		{
			unread: 0,
			folderTitle: "Inbox",
			folderHref: "/inbox",
			held: 0,
			screenerOn: false,
			forYou: null,
			forYouVisible: false,
		},
	);
	assert.deepEqual(
		statusChipsInput({
			unread: 4,
			folderTitle: "Inbox",
			folderHref: "/inbox",
			held: 2,
			screener: { enabled: true, mode: "screener" },
			suggestions: { loaded: true, total: 3, mailboxes: [{ autonomy: "off" }, { autonomy: "suggest" }] },
		}),
		{
			unread: 4,
			folderTitle: "Inbox",
			folderHref: "/inbox",
			held: 2,
			screenerOn: true,
			forYou: 3,
			forYouVisible: true,
		},
	);
	assert.equal(
		statusChipsInput({
			unread: 0,
			folderTitle: "Inbox",
			held: 0,
			screener: { enabled: true, mode: "inbox" },
			suggestions: { loaded: true, total: 0, mailboxes: [{ autonomy: "off" }] },
		}).screenerOn,
		false,
	);
	assert.equal(canConnectAccounts(undefined), false);
	assert.equal(canConnectAccounts({ refusal: null, accounts: [] }), true);
	assert.equal(canConnectAccounts({ refusal: "install_off", accounts: [] }), false);
	assert.equal(canConnectAccounts({ refusal: "not_permitted", accounts: [{}] }), true);
});

test("the admin page's anchors open the admin overview from the mailbox", () => {
	assert.equal(attentionHref("#database"), "/admin#database");
	assert.equal(attentionHref("/backups"), "/backups");
});

test("health lines: a healthy last backup and a database comfortably within its limit", () => {
	const data = {
		migrations: null,
		counts: null,
		databaseSize: { size: { usedBytes: 412 * 1024 ** 2, limitBytes: 10 * 1024 ** 3 }, level: "ok" },
		backups: {
			level: "ok",
			lastSuccess: {
				id: "b",
				trigger: "schedule",
				completedAt: new Date(NOW.getTime() - 6 * 3600_000).toISOString(),
				size: 184 * 1024 ** 2,
				durationMs: 1000,
			},
			lastFailure: null,
			inProgress: false,
			automatic: null,
			restore: null,
		},
	};
	assert.deepEqual(healthLines(data, NOW), [
		{ id: "backups", text: "Backups healthy · last backup 6 h ago", detail: "184 MB" },
		{ id: "database", text: "Database 412 MB of 10.0 GB", detail: "4%" },
	]);
	// A limit that is unknown leaves the percentage out; a size that is not fine is the attention list's job.
	assert.deepEqual(
		healthLines(
			{ ...data, backups: null, databaseSize: { size: { usedBytes: 2 * 1024 ** 3, limitBytes: null }, level: "ok" } },
			NOW,
		),
		[{ id: "database", text: "Database 2.0 GB", detail: "" }],
	);
	assert.deepEqual(
		healthLines({ ...data, backups: null, databaseSize: { ...data.databaseSize, level: "warn" } }, NOW),
		[],
	);
	// A backup that failed, one that needs recovery, or no size known: nothing is claimed.
	assert.deepEqual(
		healthLines({ ...data, databaseSize: null, backups: { ...data.backups, level: "failed" } }, NOW),
		[],
	);
	assert.deepEqual(
		healthLines({ ...data, databaseSize: null, backups: { ...data.backups, restore: { needsRecovery: true } } }, NOW),
		[],
	);
	assert.deepEqual(
		healthLines(
			{
				...data,
				databaseSize: null,
				backups: { ...data.backups, lastSuccess: { ...data.backups.lastSuccess, size: null, completedAt: "bad" } },
			},
			NOW,
		),
		[{ id: "backups", text: "Backups healthy · last backup finished", detail: "" }],
	);
	assert.deepEqual(healthLines({ migrations: null, counts: null, databaseSize: null, backups: null }, NOW), []);
});
