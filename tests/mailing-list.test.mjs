import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-mailing-list-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/lib/email/mailing-list-utils.ts";
			export * from "./src/lib/email/one-click-unsubscribe-utils.ts";
			export * from "./src/lib/email/one-click-attempts-utils.ts";
			export { OutboundUrlError } from "./src/lib/security/outbound-url.ts";
			export { parseRawHeaders } from "./src/lib/email/raw-headers.ts";
			export { extractUnsubscribeUrlFromRaw } from "./src/lib/email/unsubscribe.ts";
			export * from "./src/components/messages/mailing-list-notice-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "mailing-list-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const lists = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const raw = (...lines) => new TextEncoder().encode([...lines, "", "Body"].join("\r\n")).buffer;
const headersOf = (...lines) => lists.readMailingListHeaders(lists.parseRawHeaders(raw(...lines)));
const SIGNED =
	"DKIM-Signature: v=1; a=rsa-sha256; d=news.example; s=s1; h=From:To:Subject:List-Unsubscribe:List-Unsubscribe-Post; b=abc";

/** The list headers for header values given by lower-case name, as `parseRawHeaders` returns them. */
const read = (fields) => lists.readMailingListHeaders(new Map(Object.entries(fields)));
const listId = (value) => {
	const { listId: id, listName: name } = read({ "list-id": [value] });
	return { id, name };
};
const oneClick = (unsubscribe, post) =>
	read({ "list-unsubscribe": unsubscribe, "list-unsubscribe-post": post }).oneClickUrl;
const covered = (...signatures) => read({ "dkim-signature": signatures }).dkimCoversUnsubscribe;

test("List-Id gives the identifier and a cleaned display name", () => {
	assert.deepEqual(listId("Kite News <news.kite.example>"), { id: "news.kite.example", name: "Kite News" });
	assert.deepEqual(listId('"Kite \\"Weekly\\"" <Weekly.Kite.Example>'), {
		id: "weekly.kite.example",
		name: 'Kite "Weekly"',
	});
	assert.deepEqual(listId("<only.id.example>"), { id: "only.id.example", name: null });
	assert.deepEqual(listId("bare.id.example"), { id: "bare.id.example", name: null });
	assert.deepEqual(listId("two words"), { id: null, name: null });
	assert.deepEqual(listId("Name <>"), { id: null, name: null });
	assert.deepEqual(read({}).listId, null);
});

test("a List-Id name is decoded from RFC 2047 and loses control and bidi characters", () => {
	assert.equal(listId("=?utf-8?B?S2l0ZSDwn5Ss?= <k.example>").name, "Kite \u{1f52c}");
	assert.equal(listId("=?iso-8859-1?Q?Caf=E9_Club?= <cafe.example>").name, "Café Club");
	assert.equal(listId("=?utf-8?Q?A?= =?utf-8?Q?B?= <ab.example>").name, "AB");
	assert.equal(listId("Evil‮etal⁦ <evil.example>").name, "Eviletal");
	assert.equal(listId("=?x-unknown?Q?abc?= <x.example>").name, null);
	assert.equal(listId("=?utf-8?B?!!!?= <x.example>").id, "x.example");
	const long = listId(`${"n".repeat(200)} <long.example>`).name;
	assert.equal(long.length, 80);
	assert.ok(long.endsWith("…"));
});

test("the reader link prefers http(s), then mailto, and ignores other schemes", () => {
	assert.equal(
		lists.extractUnsubscribeUrlFromRaw(raw("List-Unsubscribe: <mailto:leave@x.example>, <https://x.example/u?id=1>")),
		"https://x.example/u?id=1",
	);
	assert.equal(lists.pickUnsubscribeUrl(["<mailto:leave@x.example>"]), "mailto:leave@x.example");
	assert.equal(lists.pickUnsubscribeUrl(["<javascript:alert(1)>, <ftp://x.example>"]), null);
	assert.equal(lists.pickUnsubscribeUrl([]), null);
	assert.equal(lists.pickUnsubscribeUrl([`<https://x.example/${"a".repeat(3000)}>`]), null);
});

test("one-click needs exactly List-Unsubscribe=One-Click and an https URI", () => {
	const unsubscribe = ["<mailto:leave@x.example>, <http://x.example/plain>, <https://x.example/one?u=1>"];
	assert.equal(oneClick(unsubscribe, ["List-Unsubscribe=One-Click"]), "https://x.example/one?u=1");
	assert.equal(oneClick(unsubscribe, [" list-unsubscribe=one-click "]), "https://x.example/one?u=1");
	assert.equal(oneClick(unsubscribe, []), null);
	assert.equal(oneClick(unsubscribe, ["List-Unsubscribe=One-Click", "List-Unsubscribe=One-Click"]), null);
	assert.equal(oneClick(unsubscribe, ["List-Unsubscribe=Yes"]), null);
	assert.equal(oneClick(["<http://x.example/plain>"], ["List-Unsubscribe=One-Click"]), null);
	// A second List-Unsubscribe field (one prepended in transit is not signed) means no one-click.
	assert.equal(oneClick(["<https://evil.example/u>", ...unsubscribe], ["List-Unsubscribe=One-Click"]), null);
	const loopback = (allowLoopback) =>
		lists.readMailingListHeaders(
			new Map([
				["list-unsubscribe", ["<http://127.0.0.1:4555/u>"]],
				["list-unsubscribe-post", ["List-Unsubscribe=One-Click"]],
			]),
			{ allowLoopback },
		).oneClickUrl;
	assert.equal(loopback(false), null);
	assert.equal(loopback(true), "http://127.0.0.1:4555/u");
});

test("a folded List-Unsubscribe URL loses the whitespace inside its brackets (RFC 2369)", () => {
	const headers = headersOf(
		"List-Unsubscribe: <mailto:u@x.example>,\r\n <https://x.example/unsub/abcdefgh\r\n ijkl>",
		"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
	);
	assert.equal(headers.oneClickUrl, "https://x.example/unsub/abcdefghijkl");
	assert.equal(headers.unsubscribeUrl, "https://x.example/unsub/abcdefghijkl");
	assert.equal(
		lists.extractUnsubscribeUrlFromRaw(raw("List-Unsubscribe: <https://x.example/a\r\n\tb?c=1>")),
		"https://x.example/ab?c=1",
	);
});

test("a value with brackets never falls back to comma fragments, and one-click takes only bracketed URLs", () => {
	const fragment = `<https://good.example/?a=${"x".repeat(2100)},https://evil.example/p>`;
	const headers = read({ "list-unsubscribe": [fragment], "list-unsubscribe-post": ["List-Unsubscribe=One-Click"] });
	assert.equal(headers.oneClickUrl, null);
	assert.equal(headers.unsubscribeUrl, null);
	// Some senders leave the brackets out: the reader still gets the link, one-click does not.
	const bare = read({
		"list-unsubscribe": ["https://x.example/u"],
		"list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
	});
	assert.equal(bare.unsubscribeUrl, "https://x.example/u");
	assert.equal(bare.oneClickUrl, null);
	assert.equal(
		read({ "list-unsubscribe": ["<mailto:a@x.example>, https://x.example/u"] }).unsubscribeUrl,
		"mailto:a@x.example",
	);
});

test("a DKIM signature must sign both List-Unsubscribe headers", () => {
	assert.equal(covered("v=1; h=From : To:\r\n List-Unsubscribe :list-unsubscribe-post; b=x"), true);
	assert.equal(covered(SIGNED.slice("DKIM-Signature: ".length)), true);
	assert.equal(covered("v=1; h=From:List-Unsubscribe; b=x"), false);
	assert.equal(covered("v=1; b=x"), false);
	// Kite knows a signature passed, not which: one that does not cover the headers rules one-click out.
	assert.equal(covered("v=1; h=From; b=x", "v=1; h=list-unsubscribe:list-unsubscribe-post; b=y"), false);
	assert.equal(
		covered(
			"v=1; h=list-unsubscribe:list-unsubscribe-post:from; b=x",
			"v=1; h=From:List-Unsubscribe:List-Unsubscribe-Post; b=y",
		),
		true,
	);
	assert.equal(covered(), false);
});

test("the headers of a raw message, and who gets one-click", () => {
	const headers = headersOf(
		"From: News <news@news.example>",
		"List-Id: News <news.example>",
		"List-Unsubscribe: <https://news.example/one?u=1>, <mailto:leave@news.example>",
		"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
		SIGNED,
	);
	assert.deepEqual(headers, {
		listId: "news.example",
		listName: "News",
		unsubscribeUrl: "https://news.example/one?u=1",
		oneClickUrl: "https://news.example/one?u=1",
		dkimCoversUnsubscribe: true,
	});
	assert.deepEqual(lists.mailingListInfo(headers, { dkimPassed: true, mayUnsubscribe: true }), {
		id: "news.example",
		name: "News",
		oneClick: true,
	});
	assert.equal(lists.mailingListInfo(headers, { dkimPassed: false, mayUnsubscribe: true }).oneClick, false);
	assert.equal(lists.mailingListInfo(headers, { dkimPassed: true, mayUnsubscribe: false }).oneClick, false);
	const unsigned = headersOf(
		"List-Unsubscribe: <https://news.example/one>",
		"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
	);
	assert.equal(lists.canUseOneClick(unsigned, true), false);
	assert.equal(lists.mailingListInfo(headersOf("Subject: hi"), { dkimPassed: true, mayUnsubscribe: true }), null);
	assert.deepEqual(
		lists.mailingListInfo(headersOf("List-Id: <only.example>"), { dkimPassed: true, mayUnsubscribe: true }),
		{
			id: "only.example",
			name: null,
			oneClick: false,
		},
	);
	assert.equal(lists.mailingListInfo(null, { dkimPassed: true, mayUnsubscribe: true }), null);
});

test("a DKIM pass is read from the stored spam signals, and anything malformed is no pass", () => {
	assert.equal(lists.storedDkimPassed(JSON.stringify([{ id: "spf_passed" }, { id: "dkim_passed" }])), true);
	assert.equal(lists.storedDkimPassed(JSON.stringify([{ id: "dkim_failed" }])), false);
	assert.equal(lists.storedDkimPassed("{not json"), false);
	assert.equal(lists.storedDkimPassed(JSON.stringify({ id: "dkim_passed" })), false);
	assert.equal(lists.storedDkimPassed(null), false);
});

test("the one-click target is public https only, through the shared outbound guard", async () => {
	const calls = [];
	const ok = async (url) => {
		calls.push(url);
		return new Response(null, { status: 200 });
	};
	const post = (url, options = {}) => lists.postOneClickUnsubscribe(url, { fetch: ok, ...options });
	assert.deepEqual(await post("https://news.example/u?x=1"), { ok: true, status: 200 });
	assert.deepEqual(calls, ["https://news.example/u?x=1"]);
	for (const url of [
		"http://news.example/u",
		"https://127.0.0.1/u",
		"https://localhost/u",
		"https://10.0.0.1/u",
		"https://169.254.169.254/latest",
		"https://user:pw@news.example/u",
		"https://127.0.0.1.nip.io/u",
		"mailto:leave@news.example",
		"not a url",
	])
		assert.deepEqual(await post(url), { ok: false, reason: "refused_url" }, url);
	// On Node the pinned POST resolves the name; a private answer comes back as OutboundUrlError, never a request.
	const refusing = async () => {
		throw new lists.OutboundUrlError("Private and local addresses are not allowed");
	};
	assert.deepEqual(await post("https://rebind.example/u", { pinnedPost: refusing }), {
		ok: false,
		reason: "refused_url",
	});
	// With the pinned POST there, fetch is never used; a literal private URL never even reaches it.
	const pinned = [];
	const pinnedPost = async (url, init) => {
		pinned.push({ url, init });
		return { status: 204 };
	};
	assert.deepEqual(await post("https://news.example/pinned", { pinnedPost }), { ok: true, status: 204 });
	assert.deepEqual(await post("https://10.0.0.1/u", { pinnedPost }), { ok: false, reason: "refused_url" });
	assert.equal(pinned.length, 1);
	assert.equal(pinned[0].url, "https://news.example/pinned");
	assert.equal(pinned[0].init.body, "List-Unsubscribe=One-Click");
	assert.equal(pinned[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
	assert.ok(pinned[0].init.signal instanceof AbortSignal);
	assert.equal(calls.length, 1, "a refused URL is never fetched");
	assert.equal((await post("http://127.0.0.1:4555/u", { allowLoopback: true })).ok, true);
	assert.deepEqual(await post("http://localhost:4555/u", { allowLoopback: true }), {
		ok: false,
		reason: "refused_url",
	});
	assert.equal(lists.isUnsubscribeLoopbackAllowed("1", "development"), true);
	assert.equal(lists.isUnsubscribeLoopbackAllowed("1", "production"), false);
	assert.equal(lists.isUnsubscribeLoopbackAllowed(undefined, "development"), false);
});

test("the POST is RFC 8058's, never follows a redirect, and only a 2xx counts", async () => {
	const calls = [];
	const answer = (status) => async (url, init) => {
		calls.push({ url, init });
		return new Response(status === 204 ? null : "ok", {
			status,
			headers: status === 302 ? { Location: "http://10.0.0.1/" } : {},
		});
	};
	assert.deepEqual(await lists.postOneClickUnsubscribe("https://news.example/u", { fetch: answer(200) }), {
		ok: true,
		status: 200,
	});
	const { url, init } = calls[0];
	assert.equal(url, "https://news.example/u");
	assert.equal(init.method, "POST");
	assert.equal(init.body, "List-Unsubscribe=One-Click");
	assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
	assert.equal(init.redirect, "manual");
	assert.ok(init.signal instanceof AbortSignal);
	assert.equal((await lists.postOneClickUnsubscribe("https://news.example/u", { fetch: answer(204) })).ok, true);
	assert.deepEqual(await lists.postOneClickUnsubscribe("https://news.example/u", { fetch: answer(302) }), {
		ok: false,
		reason: "redirect",
		status: 302,
	});
	assert.deepEqual(await lists.postOneClickUnsubscribe("https://news.example/u", { fetch: answer(500) }), {
		ok: false,
		reason: "http_error",
		status: 500,
	});
	const before = calls.length;
	assert.deepEqual(await lists.postOneClickUnsubscribe("https://10.0.0.1/u", { fetch: answer(200) }), {
		ok: false,
		reason: "refused_url",
	});
	assert.equal(calls.length, before, "a refused URL is never fetched");
	// AbortSignal.timeout's timer does not hold the event loop open, so the fake fails the way it would.
	const timedOut = async () => {
		throw new DOMException("The operation timed out.", "TimeoutError");
	};
	assert.deepEqual(await lists.postOneClickUnsubscribe("https://news.example/u", { fetch: timedOut }), {
		ok: false,
		reason: "timeout",
	});
	// One deadline covers the pinned POST's DNS check too (tests/pinned-post.test.mjs checks it never connects late).
	const keepAlive = setTimeout(() => {}, 5_000);
	let fetched = false;
	const never = () => new Promise(() => {});
	assert.deepEqual(
		await lists.postOneClickUnsubscribe("https://slow-dns.example/u", {
			pinnedPost: never,
			timeoutMs: 20,
			fetch: async () => {
				fetched = true;
				return new Response(null, { status: 200 });
			},
		}),
		{ ok: false, reason: "timeout" },
	);
	clearTimeout(keepAlive);
	assert.equal(fetched, false);
	// A body that cannot be cancelled does not change the outcome.
	const stubborn = async () => ({ status: 202, body: { cancel: () => Promise.reject(new Error("locked")) } });
	assert.deepEqual(await lists.postOneClickUnsubscribe("https://news.example/u", { fetch: stubborn }), {
		ok: true,
		status: 202,
	});
	assert.deepEqual(await lists.postOneClickUnsubscribe("not a url", { fetch: stubborn, allowLoopback: true }), {
		ok: false,
		reason: "refused_url",
	});
	const broken = async () => {
		throw new TypeError("fetch failed");
	};
	assert.deepEqual(await lists.postOneClickUnsubscribe("https://news.example/u", { fetch: broken }), {
		ok: false,
		reason: "network",
	});
});

test("one request per message goes out: retries after a failure do, parallel twins and refused clicks do not hold", () => {
	const now = Date.parse("2026-11-13T10:00:00Z");
	let seq = 0;
	const row = (id, messageId, secondsAgo, outcome = "pending") => ({
		id,
		seq: ++seq,
		messageId,
		createdAt: now - secondsAgo * 1000,
		outcome,
	});
	const decide = (rows, self) => lists.decideOneClickAttempt(rows, { id: self, messageId: "m1" }, now);
	assert.equal(decide([row("a", "m1", 0)], "a"), null);
	// A request that reached the sender (or is still going out) holds the message for ten minutes.
	assert.equal(decide([row("a", "m1", 120, "done"), row("b", "m1", 0)], "b"), "duplicate");
	assert.equal(decide([row("a", "m1", 60, "pending"), row("b", "m1", 0)], "b"), "duplicate");
	assert.equal(decide([row("a", "m1", 11 * 60, "done"), row("b", "m1", 0)], "b"), null);
	// A failed one does not: the retry goes out.
	for (const failed of ["timeout", "network", "http_error", "redirect", "refused_url"])
		assert.equal(decide([row("a", "m1", 60, failed), row("b", "m1", 0)], "b"), null, failed);
	// Two requests: the one inserted first goes out, whatever their ids or the second they share.
	assert.equal(decide([row("b", "m1", 0), row("a", "m1", 0)], "b"), null);
	assert.equal(decide([row("b", "m1", 0), row("a", "m1", 0)], "a"), "duplicate");
	// A request that reached the sender in the same second still holds the message (whole-second created_at).
	assert.equal(decide([row("z", "m1", 0, "done"), row("a", "m1", 0)], "a"), "duplicate");
	// Refused clicks never stretch the window or count toward the rate.
	const refused = Array.from({ length: 20 }, (_, index) => row(`r${index}`, "m1", 30, "duplicate"));
	assert.equal(decide([row("a", "m1", 11 * 60, "done"), ...refused, row("b", "m1", 0)], "b"), null);
	// Other messages count toward the per-minute limit only: ten went out, the eleventh is refused.
	const others = Array.from({ length: 10 }, (_, index) => row(`o${index}`, `other${index}`, 20, "done"));
	assert.equal(decide([...others, row("b", "m1", 0)], "b"), "rate_limited");
	assert.equal(decide([...others.slice(1), row("b", "m1", 0)], "b"), null);
	const rateRefused = Array.from({ length: 10 }, (_, index) => row(`q${index}`, `other${index}`, 20, "rate_limited"));
	assert.equal(decide([...rateRefused, row("b", "m1", 0)], "b"), null);
	assert.equal(lists.UNSUBSCRIBE_ONE_CLICK_ACTION, "message.unsubscribe_one_click");
});

test("an attempt's outcome is read from its metadata, and anything unreadable is none", () => {
	assert.equal(lists.attemptOutcome(JSON.stringify({ outcome: "done", status: 200 })), "done");
	assert.equal(lists.attemptOutcome(JSON.stringify({ status: 200 })), null);
	assert.equal(lists.attemptOutcome(JSON.stringify({ outcome: 3 })), null);
	assert.equal(lists.attemptOutcome("null"), null);
	assert.equal(lists.attemptOutcome("{oops"), null);
	assert.equal(lists.attemptOutcome(null), null);
});

test("the notice shows on received mail only, never on spam, Trash or held mail", () => {
	const list = { id: "news.example", name: "News", oneClick: false };
	const message = (status, direction = "inbound") => ({ status, direction, fromAddr: "News <n@news.example>" });
	assert.equal(lists.shouldOfferMailingListNotice(message("received"), list), true);
	assert.equal(lists.shouldOfferMailingListNotice(message("archived"), list), true);
	for (const status of ["spam", "trash", "screening"])
		assert.equal(lists.shouldOfferMailingListNotice(message(status), list), false, status);
	assert.equal(lists.shouldOfferMailingListNotice(message("sent", "outbound"), list), false);
	assert.equal(lists.shouldOfferMailingListNotice(message("received"), null), false);
	assert.equal(lists.shouldOfferMailingListNotice(null, list), false);
});

test("a dismissal is per list, else per sender, and the stored list stays bounded", () => {
	assert.equal(lists.mailingListDismissKey({ id: "news.example" }, "n@news.example"), "list:news.example");
	assert.equal(lists.mailingListDismissKey({ id: null }, "News <N@News.Example>"), "sender:n@news.example");
	assert.equal(lists.mailingListDismissKey({ id: null }, ""), null);
	assert.deepEqual(lists.parseDismissedKeys(["list:a", 3, null, "sender:b"]), ["list:a", "sender:b"]);
	assert.deepEqual(lists.parseDismissedKeys({ "list:a": true }), []);
	assert.deepEqual(lists.parseDismissedKeys(null), []);
	assert.deepEqual(lists.updateDismissedKeys(["list:a", "list:b"], "list:a", true), ["list:b", "list:a"]);
	assert.deepEqual(lists.updateDismissedKeys(["list:a", "list:b"], "list:a", false), ["list:b"]);
	const full = Array.from({ length: 500 }, (_, index) => `list:${index}`);
	const next = lists.updateDismissedKeys(full, "list:new", true);
	assert.equal(next.length, 500);
	assert.equal(next.at(-1), "list:new");
	assert.equal(next[0], "list:1");
});
