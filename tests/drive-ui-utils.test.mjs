import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	driveIconKind,
	sortDriveItems,
	driveFileUrl,
	publicContentUrl,
	emailHref,
	previewKind,
	folderHref,
	viewHref,
	DRIVE_VIEW_TITLES,
	usagePercent,
	folderPathsOf,
	parentPathOf,
	uploadFingerprint,
	parseQuotaGb,
	quotaToGb,
	formatDriveDate,
	driveRowActions,
	isSelectable,
} = await bundleModules("kite-drive-ui-utils-", [
	[
		"driveIconKind, sortDriveItems, driveFileUrl, publicContentUrl, emailHref, previewKind, folderHref, viewHref, DRIVE_VIEW_TITLES, usagePercent, folderPathsOf, parentPathOf, uploadFingerprint, parseQuotaGb, quotaToGb, formatDriveDate, driveRowActions, isSelectable",
		"src/components/drive/drive-utils.ts",
	],
]);

const GB = 1024 ** 3;
const file = (name, contentType = "application/octet-stream") => ({ kind: "file", name, contentType });

test("icons follow the folder, content type and extension rules in order", () => {
	assert.equal(driveIconKind({ kind: "folder", name: "photos.png", contentType: "" }), "folder");
	assert.equal(driveIconKind(file("a.bin", "image/png")), "image");
	assert.equal(driveIconKind(file("a", "video/mp4")), "video");
	assert.equal(driveIconKind(file("a", "audio/mpeg")), "audio");
	assert.equal(driveIconKind(file("REPORT.PDF")), "pdf");
	assert.equal(driveIconKind(file("a", "application/pdf")), "pdf");
	assert.equal(driveIconKind(file("budget.xlsx")), "spreadsheet");
	assert.equal(driveIconKind(file("a", "text/csv")), "spreadsheet");
	assert.equal(driveIconKind(file("deck.key")), "slides");
	assert.equal(driveIconKind(file("a", "application/vnd.ms-powerpoint")), "slides");
	assert.equal(driveIconKind(file("backup.tgz")), "archive");
	assert.equal(driveIconKind(file("a", "application/zip")), "archive");
	assert.equal(driveIconKind(file("main.rs")), "code");
	assert.equal(driveIconKind(file("a", "application/json")), "code");
	assert.equal(driveIconKind(file("a", "text/javascript")), "code");
	assert.equal(driveIconKind(file("notes.md")), "document");
	assert.equal(driveIconKind(file("a", "text/plain")), "document");
	assert.equal(driveIconKind(file("a", "application/msword")), "document");
	assert.equal(driveIconKind(file("README")), "file");
	assert.equal(driveIconKind(file("archive.")), "file");
});

const row = (overrides) => ({
	id: overrides.name,
	kind: "file",
	size: 0,
	updatedAt: "2024-01-01T00:00:00.000Z",
	role: "owner",
	ownerName: "",
	...overrides,
});

test("folders sort first, then by the chosen column with the name breaking ties", () => {
	const items = [
		row({ name: "file 10", size: 5, updatedAt: "2024-01-03T00:00:00.000Z" }),
		row({ name: "File 2", size: 5, updatedAt: "2024-01-02T00:00:00.000Z" }),
		row({ name: "zeta", kind: "folder" }),
		row({ name: "alpha", kind: "folder" }),
		row({ name: "big", size: 99, role: "view", ownerName: "Bea" }),
	];
	const names = (sorted) => sorted.map((item) => item.name);
	assert.deepEqual(names(sortDriveItems(items, "name", true)), ["alpha", "zeta", "big", "File 2", "file 10"]);
	assert.deepEqual(names(sortDriveItems(items, "name", false)), ["zeta", "alpha", "file 10", "File 2", "big"]);
	assert.deepEqual(names(sortDriveItems(items, "size", false)), ["zeta", "alpha", "big", "file 10", "File 2"]);
	assert.deepEqual(names(sortDriveItems(items, "updatedAt", true)), ["alpha", "zeta", "big", "File 2", "file 10"]);
	assert.deepEqual(names(sortDriveItems(items, "owner", true)), ["alpha", "zeta", "File 2", "file 10", "big"]);
	assert.equal(items[0].name, "file 10", "the input is not sorted in place");
});

test("content URLs point at Drive files, mail attachments and public links", () => {
	assert.equal(driveFileUrl({ id: "drv/1", source: null }), "/api/drive/files/drv%2F1/content");
	assert.equal(driveFileUrl({ id: "drv_1" }, true), "/api/drive/files/drv_1/content?disposition=attachment");
	const source = { messageId: "m1", direction: "inbound" };
	assert.equal(driveFileUrl({ id: "att_1", source }), "/api/drive/attachments/att_1/content");
	assert.equal(publicContentUrl("tok/en", "drv_1"), "/api/public/drive/tok%2Fen/content?item=drv_1");
	assert.equal(publicContentUrl("t", "drv_1", true), "/api/public/drive/t/content?item=drv_1&download=1");
	assert.equal(emailHref({ messageId: "m 1", direction: "inbound" }), "/inbox/m%201");
	assert.equal(emailHref({ messageId: "m2", direction: "outbound" }), "/sent/m2");
	assert.equal(folderHref("drv 1"), "/drive/f/drv%201");
	assert.equal(viewHref("my"), "/drive");
	assert.equal(viewHref("trash"), "/drive/trash");
	assert.equal(DRIVE_VIEW_TITLES.shared, "Shared with me");
});

test("only safe types preview inline; SVG and HTML stay downloads", () => {
	assert.equal(previewKind("image/png"), "image");
	assert.equal(previewKind("image/svg+xml"), null);
	assert.equal(previewKind("video/webm"), "video");
	assert.equal(previewKind("audio/ogg"), "audio");
	assert.equal(previewKind("application/pdf"), "pdf");
	assert.equal(previewKind("text/plain"), "text");
	assert.equal(previewKind("application/json"), "text");
	assert.equal(previewKind("text/html"), null);
	assert.equal(previewKind("application/octet-stream"), null);
});

test("usage is a whole percent capped at 100, and 0 without a limit", () => {
	assert.equal(usagePercent(50, 200), 25);
	assert.equal(usagePercent(1, 3), 33);
	assert.equal(usagePercent(500, 100), 100);
	assert.equal(usagePercent(10, null), 0);
	assert.equal(usagePercent(10, 0), 0);
});

test("folder uploads create parents before children", () => {
	assert.deepEqual(folderPathsOf(["top/b/x.txt", "top/a.txt", "top/b/c/y.txt", "/top//z.txt", "root.txt"]), [
		"top",
		"top/b",
		"top/b/c",
	]);
	assert.deepEqual(folderPathsOf(["b/1", "a/1"]), ["a", "b"]);
	assert.equal(parentPathOf("top/b/x.txt"), "top/b");
	assert.equal(parentPathOf("x.txt"), "");
	assert.equal(uploadFingerprint({ name: "a", size: 10, lastModified: 5 }), "5:10");
});

test("quotas are typed in GB and empty means unlimited", () => {
	assert.deepEqual(parseQuotaGb(""), { bytes: null });
	assert.deepEqual(parseQuotaGb("  "), { bytes: null });
	assert.deepEqual(parseQuotaGb("2"), { bytes: 2 * GB });
	assert.deepEqual(parseQuotaGb("0.5"), { bytes: GB / 2 });
	assert.ok("error" in parseQuotaGb("0"));
	assert.ok("error" in parseQuotaGb("-1"));
	assert.ok("error" in parseQuotaGb("lots"));
	assert.equal(quotaToGb(null), "");
	assert.equal(quotaToGb(2 * GB), "2");
	assert.equal(quotaToGb(1.234 * GB), "1.23");
});

test("dates format for display and a bad value is blank", () => {
	assert.notEqual(formatDriveDate("2024-05-01T12:00:00.000Z"), "");
	assert.equal(formatDriveDate("not a date"), "");
});

test("row menus and selection follow the viewer's role", () => {
	const source = { messageId: "m1", direction: "inbound" };
	assert.deepEqual(driveRowActions({ kind: "file", role: "view", trashedAt: null, source }), [
		"open",
		"download",
		"open-email",
		"save",
	]);
	assert.deepEqual(driveRowActions({ kind: "file", role: "owner", trashedAt: "x", source: null }), [
		"restore",
		"delete",
	]);
	assert.deepEqual(driveRowActions({ kind: "file", role: "edit", trashedAt: "x", source: null }), []);
	assert.deepEqual(driveRowActions({ kind: "folder", role: "owner", trashedAt: null, source: null }), [
		"open",
		"share",
		"rename",
		"move",
		"trash",
	]);
	assert.deepEqual(driveRowActions({ kind: "file", role: "edit", trashedAt: null, source: null }), [
		"open",
		"download",
		"share",
		"rename",
		"move",
		"trash",
	]);
	assert.deepEqual(driveRowActions({ kind: "file", role: "view", trashedAt: null, source: null }), [
		"open",
		"download",
	]);
	assert.equal(isSelectable({ role: "owner", source: null }), true);
	assert.equal(isSelectable({ role: "edit" }), true);
	assert.equal(isSelectable({ role: "view", source: null }), false);
	assert.equal(isSelectable({ role: "owner", source }), false);
});
