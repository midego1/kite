import assert from "node:assert/strict";
import test from "node:test";
import { loadFinance } from "./support/finance-bundle.mjs";

const { parseCancelLink } = await loadFinance("cancel-link-utils");
const { cancelLinkLine } = await loadFinance("text-utils");

const ONE_CLICK = "List-Unsubscribe=One-Click";

test("keeps the first https URL of the header", () => {
	assert.deepEqual(parseCancelLink("<https://vendor.example/cancel?u=1>", null), {
		url: "https://vendor.example/cancel?u=1",
		oneClick: false,
	});
	assert.deepEqual(
		parseCancelLink("<mailto:leave@vendor.example>, <https://a.vendor.example/x>, <https://b.vendor.example/y>", null),
		{ url: "https://a.vendor.example/x", oneClick: false },
	);
});

test("drops http, mailto, IP literals, local names and credentials", () => {
	for (const header of [
		"<http://vendor.example/cancel>",
		"<mailto:leave@vendor.example?subject=unsubscribe>",
		"<https://192.168.1.10/cancel>",
		"<https://[::1]/cancel>",
		"<https://0x7f000001/cancel>",
		"<https://localhost/cancel>",
		"<https://app.localhost/cancel>",
		"<https://printer.local/cancel>",
		"<https://billing.internal/cancel>",
		"<https://intranet/cancel>",
		"<https://user:secret@vendor.example/cancel>",
		"<https://user@vendor.example/cancel>",
		"<not a url>",
		"https://vendor.example/no-brackets",
		`<https://vendor.example/${"a".repeat(2_100)}>`,
	])
		assert.equal(parseCancelLink(header, ONE_CLICK), null, header);
	assert.equal(parseCancelLink(null, ONE_CLICK), null);
	assert.equal(parseCancelLink("", null), null);
});

test("one-click only for the exact RFC 8058 value", () => {
	const header = "<https://vendor.example/cancel>";
	assert.equal(parseCancelLink(header, ONE_CLICK).oneClick, true);
	assert.equal(parseCancelLink(header, ` ${ONE_CLICK} `).oneClick, true);
	for (const post of [null, "", "List-Unsubscribe=one-click", "List-Unsubscribe=One-Click; extra", "One-Click"])
		assert.equal(parseCancelLink(header, post).oneClick, false, String(post));
});

test("the card names the link's host, or says there is none", () => {
	assert.equal(
		cancelLinkLine({ cancelLink: { url: "https://vendor.example/c", oneClick: false } }),
		"Cancel link: vendor.example",
	);
	assert.equal(cancelLinkLine({ cancelLink: null }), "No cancel link");
	assert.equal(cancelLinkLine({ cancelLink: { url: "not a url", oneClick: false } }), "No cancel link");
});
