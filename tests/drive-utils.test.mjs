import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	normalizeDriveName,
	canEditDrive,
	driveObjectKey,
	driveItemHref,
	toDriveCrumbs,
	formatDriveSize,
	DRIVE_PROXIED_PART_BYTES,
	DRIVE_MAX_PARTS,
	partCount,
	expectedPartSize,
	maxFileBytes,
	parseUploadRequest,
	normalizeUploadContentType,
	partsComplete,
	parsePartNumbers,
	parsePartEtag,
	effectiveQuota,
	parseQuotaBytes,
	mayChangeQuota,
	generateLinkToken,
	hashLinkToken,
	isWellFormedLinkToken,
	linkExpiry,
	isLinkActive,
	parseLinkPassword,
	unlockCookieName,
	createUnlockValue,
	verifyUnlockValue,
	readCookie,
	parseByteRange,
	driveEtag,
	driveContentHeaders,
	requestedRange,
	DEFAULT_DRIVE_SETTINGS,
	applySettingsPatch,
	trashCutoff,
	parseDriveView,
	encodeDriveCursor,
	decodeDriveCursor,
	nextDriveCursor,
	containsPattern,
	parseDriveCategories,
	isDriveCategory,
	unlockCookieHeader,
	allowPublicLinkRequest,
	allowLinkUnlockAttempt,
} = await bundleModules("kite-drive-utils-", [
	[
		"normalizeDriveName, canEditDrive, driveObjectKey, driveItemHref, toDriveCrumbs, formatDriveSize",
		"src/lib/drive/name-utils.ts",
	],
	[
		"DRIVE_PROXIED_PART_BYTES, DRIVE_MAX_PARTS, partCount, expectedPartSize, maxFileBytes, parseUploadRequest, normalizeUploadContentType, partsComplete, parsePartNumbers, parsePartEtag",
		"src/lib/drive/upload-utils.ts",
	],
	["effectiveQuota, parseQuotaBytes, mayChangeQuota", "src/lib/drive/quota-utils.ts"],
	[
		"generateLinkToken, hashLinkToken, isWellFormedLinkToken, linkExpiry, isLinkActive, parseLinkPassword, unlockCookieName, createUnlockValue, verifyUnlockValue, readCookie, unlockCookieHeader",
		"src/lib/drive/link-utils.ts",
	],
	["parseByteRange, driveEtag, driveContentHeaders, requestedRange", "src/lib/drive/range-utils.ts"],
	["DEFAULT_DRIVE_SETTINGS, applySettingsPatch, trashCutoff", "src/lib/drive/settings-utils.ts"],
	[
		"parseDriveView, encodeDriveCursor, decodeDriveCursor, nextDriveCursor, containsPattern",
		"src/lib/drive/list-utils.ts",
	],
	["parseDriveCategories, isDriveCategory", "src/lib/drive/category-names-utils.ts"],
	["allowPublicLinkRequest, allowLinkUnlockAttempt", "src/lib/drive/rate-limit.ts"],
]);

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

test("names lose separators and control characters and can never be a path", () => {
	assert.equal(normalizeDriveName("  Q1  report.pdf "), "Q1 report.pdf");
	assert.equal(normalizeDriveName("a/b\\c"), "a b c");
	assert.equal(normalizeDriveName("tab\there\u0000x"), "tab here x");
	assert.equal(normalizeDriveName("."), null);
	assert.equal(normalizeDriveName(".."), null);
	assert.equal(normalizeDriveName("   "), null);
	assert.equal(normalizeDriveName(42), null);
	assert.equal(normalizeDriveName("x".repeat(300)).length, 255);
	assert.equal(normalizeDriveName("Überweisung – Mai.pdf"), "Überweisung – Mai.pdf");
});

test("roles, keys, links into the app and crumbs", () => {
	assert.equal(canEditDrive("owner"), true);
	assert.equal(canEditDrive("edit"), true);
	assert.equal(canEditDrive("view"), false);
	assert.equal(canEditDrive(null), false);
	assert.equal(driveObjectKey("drv_1"), "drive/drv_1");
	assert.equal(driveItemHref({ id: "drv_f", kind: "folder" }), "/drive/f/drv_f");
	assert.equal(driveItemHref({ id: "drv_x", kind: "file" }), "/drive?file=drv_x");
	assert.deepEqual(toDriveCrumbs([{ id: "a", name: "A", extra: 1 }]), [{ id: "a", name: "A" }]);
	assert.equal(formatDriveSize(512), "512 B");
	assert.equal(formatDriveSize(1536), "1.5 KB");
	assert.equal(formatDriveSize(20 * MiB), "20 MB");
});

test("part sizes: every part is full except the last, and an empty file has none", () => {
	const part = DRIVE_PROXIED_PART_BYTES;
	assert.equal(part, 32 * MiB);
	assert.equal(partCount(0, part), 0);
	assert.equal(partCount(1, part), 1);
	assert.equal(partCount(part, part), 1);
	assert.equal(partCount(part + 1, part), 2);
	assert.equal(expectedPartSize(part + 10, part, 1), part);
	assert.equal(expectedPartSize(part + 10, part, 2), 10);
	assert.equal(expectedPartSize(part + 10, part, 3), null);
	assert.equal(expectedPartSize(part + 10, part, 0), null);
	assert.equal(expectedPartSize(part + 10, part, 1.5), null);
	assert.equal(expectedPartSize(0, part, 1), null);
	assert.equal(maxFileBytes(part), part * DRIVE_MAX_PARTS);
	assert.equal(partsComplete([2, 1, 3], 3), true);
	assert.equal(partsComplete([1, 3], 3), false);
	assert.equal(partsComplete([1, 2, 2], 3), false);
	assert.equal(partsComplete([], 0), true);
});

test("direct upload part numbers and ETags are validated", () => {
	assert.deepEqual(parsePartNumbers({ partNumbers: [3, 1] }, 3), [3, 1]);
	assert.equal(parsePartNumbers({ partNumbers: [4] }, 3), null);
	assert.equal(parsePartNumbers({ partNumbers: [0] }, 3), null);
	assert.equal(parsePartNumbers({ partNumbers: [1.5] }, 3), null);
	assert.equal(parsePartNumbers({ partNumbers: [1, 1] }, 3), null);
	assert.equal(parsePartNumbers({ partNumbers: [] }, 3), null);
	assert.equal(parsePartNumbers({ partNumbers: Array.from({ length: 21 }, (_, index) => index + 1) }, 30), null);
	assert.equal(parsePartNumbers(null, 3), null);
	assert.equal(parsePartEtag({ etag: '"0a1b2c3d"' }), "0a1b2c3d");
	assert.equal(parsePartEtag({ etag: " abc-2 " }), "abc-2");
	assert.equal(parsePartEtag({ etag: 'a"b' }), null);
	assert.equal(parsePartEtag({ etag: "" }), null);
	assert.equal(parsePartEtag({ etag: "x".repeat(129) }), null);
	assert.equal(parsePartEtag({}), null);
});

test("upload requests are validated and content types normalized", () => {
	const part = DRIVE_PROXIED_PART_BYTES;
	assert.deepEqual(parseUploadRequest({ name: "a.txt", size: 3, contentType: "Text/Plain", parentId: "" }, part), {
		name: "a.txt",
		size: 3,
		contentType: "text/plain",
		parentId: null,
		fingerprint: "",
	});
	assert.deepEqual(parseUploadRequest(null, part), { error: "Invalid upload" });
	assert.deepEqual(parseUploadRequest({ size: -1 }, part), { error: "Invalid file size" });
	assert.deepEqual(parseUploadRequest({ size: 1.5 }, part), { error: "Invalid file size" });
	assert.deepEqual(parseUploadRequest({ size: maxFileBytes(part) + 1 }, part), { error: "File is too large" });
	assert.deepEqual(parseUploadRequest({ size: 1, parentId: 7 }, part), { error: "Invalid folder" });
	assert.equal(parseUploadRequest({ size: 1, fingerprint: "f".repeat(500) }, part).fingerprint.length, 200);
	assert.equal(normalizeUploadContentType(undefined), "application/octet-stream");
	assert.equal(normalizeUploadContentType("  "), "application/octet-stream");
	assert.equal(normalizeUploadContentType("text/html\r\nX: y"), "application/octet-stream");
	assert.equal(normalizeUploadContentType("image/png"), "image/png");
});

test("quotas: an override wins and null is unlimited", () => {
	assert.equal(effectiveQuota(undefined, null), null);
	assert.equal(effectiveQuota(undefined, 100), 100);
	assert.equal(effectiveQuota({ quotaBytes: null }, 100), null);
	assert.equal(effectiveQuota({ quotaBytes: 5 }, null), 5);
	assert.equal(parseQuotaBytes(null), null);
	assert.equal(parseQuotaBytes(0), 0);
	assert.equal(parseQuotaBytes(-1), undefined);
	assert.equal(parseQuotaBytes("5"), undefined);
	assert.equal(parseQuotaBytes(1.5), undefined);
});

test("quota overrides follow the account editing rule", () => {
	const primary = { id: "p", role: "admin", isPrimaryAdmin: true, canManageUsers: false };
	const manager = { id: "m", role: "admin", isPrimaryAdmin: false, canManageUsers: true };
	const admin = { id: "a", role: "admin", isPrimaryAdmin: false, canManageUsers: false };
	const user = { role: "user", isPrimaryAdmin: false };
	const otherAdmin = { role: "admin", isPrimaryAdmin: false };
	assert.equal(mayChangeQuota(primary, otherAdmin), true);
	assert.equal(mayChangeQuota(primary, { role: "admin", isPrimaryAdmin: true }), true);
	assert.equal(mayChangeQuota(manager, user), true);
	assert.equal(mayChangeQuota(manager, otherAdmin), false);
	assert.equal(mayChangeQuota(admin, user), false);
});

test("link tokens are 32 random bytes in base64url and are stored only as a hash", async () => {
	const token = generateLinkToken();
	assert.equal(token.length, 43);
	assert.ok(isWellFormedLinkToken(token));
	assert.notEqual(generateLinkToken(), token);
	const hash = await hashLinkToken(token);
	assert.equal(hash, await hashLinkToken(token));
	assert.notEqual(hash, token);
	assert.ok(!isWellFormedLinkToken(`${token}x`));
	assert.ok(!isWellFormedLinkToken("short"));
	assert.ok(!isWellFormedLinkToken(`${token.slice(0, 42)}/`));
});

test("every link expires within the install's maximum, and 0 turns links off", () => {
	const now = new Date("2026-05-01T00:00:00Z");
	assert.equal(linkExpiry(7, 30, now).getTime(), now.getTime() + 7 * DAY);
	assert.equal(linkExpiry(30, 30, now).getTime(), now.getTime() + 30 * DAY);
	assert.deepEqual(linkExpiry(31, 30, now), { error: "Choose an expiry from 1 to 30 days", status: 400 });
	assert.equal(linkExpiry(0, 30, now).status, 400);
	assert.equal(linkExpiry(undefined, 30, now).status, 400);
	assert.equal(linkExpiry(null, 30, now).status, 400);
	assert.equal(linkExpiry(1.5, 30, now).status, 400);
	assert.deepEqual(linkExpiry(1, 0, now), { error: "Public links are turned off", status: 403 });
	assert.equal(isLinkActive({ expiresAt: new Date(now.getTime() + 1), revokedAt: null }, now), true);
	assert.equal(isLinkActive({ expiresAt: now, revokedAt: null }, now), false);
	assert.equal(isLinkActive({ expiresAt: new Date(now.getTime() + DAY), revokedAt: now }, now), false);
	assert.equal(parseLinkPassword(undefined), undefined);
	assert.equal(parseLinkPassword(""), undefined);
	assert.equal(parseLinkPassword("secret"), "secret");
	assert.equal(parseLinkPassword(5), null);
	assert.equal(parseLinkPassword("x".repeat(201)), null);
});

test("an unlock cookie is bound to the link and its password and ends with the link", async () => {
	const now = new Date("2026-05-01T00:00:00Z");
	const link = { id: "dln_1", passwordHash: "$2a$10$hash", expiresAt: new Date(now.getTime() + DAY) };
	const { value, maxAge } = await createUnlockValue(link, now);
	assert.equal(maxAge, 3600);
	assert.equal(await verifyUnlockValue(link, value, now), true);
	assert.equal(await verifyUnlockValue(link, value, new Date(now.getTime() + 3601 * 1000)), false, "expired");
	assert.equal(await verifyUnlockValue({ ...link, id: "dln_2" }, value, now), false, "another link");
	assert.equal(await verifyUnlockValue({ ...link, passwordHash: "$2a$10$new" }, value, now), false, "new password");
	const [until, signature] = value.split(".");
	assert.equal(await verifyUnlockValue(link, `${Number(until) + 600}.${signature}`, now), false, "extended");
	assert.equal(await verifyUnlockValue(link, undefined, now), false);
	assert.equal(await verifyUnlockValue(link, "garbage", now), false);
	const soon = { ...link, expiresAt: new Date(now.getTime() + 60 * 1000) };
	assert.equal((await createUnlockValue(soon, now)).maxAge, 60);
	assert.equal(unlockCookieName("dln_1"), "kite_link_dln_1");
	assert.equal(unlockCookieName("a;b=c"), "kite_link_abc");
	assert.equal(readCookie("a=1; kite_link_x=v.w=; b=2", "kite_link_x"), "v.w=");
	assert.equal(readCookie(null, "a"), undefined);
});

test("byte ranges: one range, suffixes, open ends and unsatisfiable starts", () => {
	assert.equal(parseByteRange(null, 100), null);
	assert.deepEqual(parseByteRange("bytes=0-9", 100), { start: 0, end: 9 });
	assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
	assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
	assert.deepEqual(parseByteRange("bytes=-500", 100), { start: 0, end: 99 });
	assert.deepEqual(parseByteRange("bytes=50-500", 100), { start: 50, end: 99 });
	assert.equal(parseByteRange("bytes=100-", 100), "invalid");
	assert.equal(parseByteRange("bytes=9-3", 100), "invalid");
	assert.equal(parseByteRange("bytes=-0", 100), "invalid");
	assert.equal(parseByteRange("bytes=0-1,5-6", 100), null, "multiple ranges are served whole");
	assert.equal(parseByteRange("items=0-1", 100), null);
	assert.equal(parseByteRange("bytes=-", 100), null);
	assert.equal(parseByteRange("bytes=0-", 0), null, "an empty file is served whole");
});

test("If-Range for another version serves the whole file", () => {
	const item = { id: "drv_1", size: 100, updatedAt: new Date(1_000_000) };
	const etag = driveEtag(item);
	assert.notEqual(etag, driveEtag({ ...item, updatedAt: new Date(2_000_000) }));
	const ranged = (headers) => requestedRange(new Request("https://x.test/", { headers }), etag, 100);
	assert.deepEqual(ranged({ Range: "bytes=0-1" }), { start: 0, end: 1 });
	assert.deepEqual(ranged({ Range: "bytes=0-1", "If-Range": etag }), { start: 0, end: 1 });
	assert.equal(ranged({ Range: "bytes=0-1", "If-Range": '"old"' }), null);
});

test("content headers: inline only for safe types, everything else downloads as opaque bytes", () => {
	const base = { id: "drv_1", size: 10, updatedAt: new Date(0) };
	const image = driveContentHeaders({ ...base, name: "a.png", contentType: "image/png" }, true);
	assert.equal(image.get("Content-Type"), "image/png");
	assert.match(image.get("Content-Disposition"), /^inline;/);
	assert.equal(image.get("Content-Security-Policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
	assert.equal(image.get("X-Content-Type-Options"), "nosniff");
	assert.equal(image.get("Referrer-Policy"), "no-referrer");
	assert.equal(image.get("Cache-Control"), "private, no-store");
	assert.equal(image.get("Accept-Ranges"), "bytes");
	const pdf = driveContentHeaders({ ...base, name: "a.pdf", contentType: "application/pdf" }, true);
	assert.equal(pdf.get("Content-Security-Policy"), "frame-ancestors 'self'");
	const download = driveContentHeaders({ ...base, name: "a.png", contentType: "image/png" }, false);
	assert.match(download.get("Content-Disposition"), /^attachment;/);
	assert.match(download.get("Content-Security-Policy"), /sandbox/);
	for (const contentType of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "nonsense"]) {
		const headers = driveContentHeaders({ ...base, name: "x", contentType }, true);
		assert.equal(headers.get("Content-Type"), "application/octet-stream", contentType);
		assert.match(headers.get("Content-Disposition"), /^attachment;/, contentType);
	}
	const named = driveContentHeaders({ ...base, name: "Überweisung.pdf", contentType: "application/pdf" }, false);
	assert.match(named.get("Content-Disposition"), /filename\*=UTF-8''%C3%9Cberweisung\.pdf/);
});

test("settings: link lifetime 0 or 1-365, retention 1-365, quota bytes or null", () => {
	assert.deepEqual(DEFAULT_DRIVE_SETTINGS, { defaultQuotaBytes: null, linkMaxDays: 30, trashRetentionDays: 30 });
	assert.deepEqual(applySettingsPatch(DEFAULT_DRIVE_SETTINGS, { linkMaxDays: 0 }).settings.linkMaxDays, 0);
	assert.deepEqual(applySettingsPatch(DEFAULT_DRIVE_SETTINGS, { linkMaxDays: 365 }).settings.linkMaxDays, 365);
	for (const linkMaxDays of [366, -1, 1.5, null, "7"])
		assert.ok("error" in applySettingsPatch(DEFAULT_DRIVE_SETTINGS, { linkMaxDays }), String(linkMaxDays));
	for (const trashRetentionDays of [0, 366, null])
		assert.ok("error" in applySettingsPatch(DEFAULT_DRIVE_SETTINGS, { trashRetentionDays }));
	assert.equal(applySettingsPatch(DEFAULT_DRIVE_SETTINGS, { defaultQuotaBytes: 5e9 }).settings.defaultQuotaBytes, 5e9);
	assert.equal(
		applySettingsPatch({ ...DEFAULT_DRIVE_SETTINGS, defaultQuotaBytes: 1 }, { defaultQuotaBytes: null }).settings
			.defaultQuotaBytes,
		null,
	);
	assert.ok("error" in applySettingsPatch(DEFAULT_DRIVE_SETTINGS, { defaultQuotaBytes: -5 }));
	assert.ok("error" in applySettingsPatch(DEFAULT_DRIVE_SETTINGS, null));
	assert.deepEqual(applySettingsPatch(DEFAULT_DRIVE_SETTINGS, {}).settings, DEFAULT_DRIVE_SETTINGS);
	const now = new Date("2026-05-31T00:00:00Z");
	assert.equal(trashCutoff(now, 30).toISOString(), "2026-05-01T00:00:00.000Z");
});

test("views, cursors, search patterns and type filters", () => {
	assert.equal(parseDriveView(null), "my");
	assert.equal(parseDriveView("trash"), "trash");
	assert.equal(parseDriveView("nope"), null);
	const cursor = { at: 1714521600, id: "drv_abc-1" };
	assert.deepEqual(decodeDriveCursor(encodeDriveCursor(cursor)), cursor);
	assert.equal(decodeDriveCursor("!!!"), null);
	assert.equal(decodeDriveCursor(btoa("1:bad id")), null);
	assert.equal(decodeDriveCursor(null), null);
	const of = (row) => ({ at: row, id: `id${row}` });
	assert.equal(nextDriveCursor([1, 2], 3, of), null);
	assert.deepEqual(decodeDriveCursor(nextDriveCursor([1, 2, 3], 3, of)), { at: 3, id: "id3" });
	assert.equal(containsPattern("50%_off\\"), "%50\\%\\_off\\\\%");
	assert.deepEqual(parseDriveCategories("photos,videos,photos,bogus"), ["photos", "videos"]);
	assert.deepEqual(parseDriveCategories(null), []);
	assert.equal(isDriveCategory("others"), true);
	assert.equal(isDriveCategory(null), false);
});

test("the unlock cookie is scoped to the link's API path, HttpOnly, SameSite=Strict, and Secure over https", () => {
	const unlock = { value: "v.sig", maxAge: 3600 };
	const header = unlockCookieHeader("lnk_1", "tok", unlock, true);
	assert.ok(header.startsWith(`${unlockCookieName("lnk_1")}=v.sig; `));
	for (const part of ["Max-Age=3600", "Path=/api/public/drive/tok", "HttpOnly", "SameSite=Strict", "Secure"])
		assert.ok(header.split("; ").includes(part), part);
	assert.ok(!unlockCookieHeader("lnk_1", "tok", unlock, false).includes("Secure"));
});

test("public link and unlock budgets key by client IP, and a missing or failing limiter lets the request through", async (t) => {
	const keys = [];
	const limiter = (success) => ({
		limit: async ({ key }) => {
			keys.push(key);
			return { success };
		},
	});
	const request = new Request("https://kite.test/api/public/drive/x", {
		headers: { "cf-connecting-ip": "203.0.113.9" },
	});
	assert.equal(await allowPublicLinkRequest({ DRIVE_LINK_RATE_LIMIT: limiter(true) }, request), true);
	assert.equal(await allowPublicLinkRequest({ DRIVE_LINK_RATE_LIMIT: limiter(false) }, request), false);
	assert.equal(await allowLinkUnlockAttempt({ LOGIN_RATE_LIMIT: limiter(false) }, request, "lnk_1"), false);
	assert.deepEqual(keys, ["203.0.113.9", "203.0.113.9", "drive-unlock:203.0.113.9:lnk_1"]);
	assert.equal(await allowPublicLinkRequest({}, request), true);
	t.mock.method(console, "warn", () => {});
	const broken = { limit: async () => Promise.reject(new Error("down")) };
	assert.equal(await allowLinkUnlockAttempt({ LOGIN_RATE_LIMIT: broken }, request, "lnk_1"), true);
});
