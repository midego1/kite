import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { getContentDisposition, objectClassOf } = await bundleModules("kite-content-disposition-", [
	["getContentDisposition", "src/lib/http/content-disposition-utils.ts"],
	["objectClassOf", "src/lib/storage/object-classes-utils.ts"],
]);

test("an ASCII name keeps both parameters identical", () => {
	assert.equal(
		getContentDisposition("report.pdf", false),
		"attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
	);
	assert.equal(getContentDisposition("pixel.png", true), "inline; filename=\"pixel.png\"; filename*=UTF-8''pixel.png");
});

test("a non-ASCII name is exact in filename* and replaced in the fallback", () => {
	assert.equal(
		getContentDisposition("Überweisung 2026 – Mai.pdf", false),
		"attachment; filename=\"_berweisung 2026 _ Mai.pdf\"; filename*=UTF-8''%C3%9Cberweisung%202026%20%E2%80%93%20Mai.pdf",
	);
});

test("quotes, backslashes and line breaks never reach the header", () => {
	const value = getContentDisposition("evil\"\\name\r\nSet-Cookie: x=1 (a)*'.txt", false);
	assert.doesNotMatch(value, /[\r\n]/);
	assert.equal(
		value,
		"attachment; filename=\"evil__name  Set-Cookie: x=1 (a)*'.txt\"; filename*=UTF-8''evil%22%5Cname%20%20Set-Cookie%3A%20x%3D1%20%28a%29%2A%27.txt",
	);
	assert.equal(decodeURIComponent(value.split("UTF-8''")[1]), "evil\"\\name  Set-Cookie: x=1 (a)*'.txt");
});

test("object keys map to their storage class by prefix", () => {
	for (const key of ["inbound/a.eml", "imports/x", "drafts/d.eml", "attachments/m/1", "jmap-uploads/u"])
		assert.equal(objectClassOf(key), "mail", key);
	assert.equal(objectClassOf("drive/drv_1"), "drive");
	assert.equal(objectClassOf("backups/database/2026.json"), "backups");
	for (const key of ["avatars/u", "branding/app-icon", "health/check", "driver/x", ""])
		assert.equal(objectClassOf(key), "system", key);
});
