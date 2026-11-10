import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";
import { startFakeWebdav } from "./support/fake-webdav.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const dav = await bundleModules("kite-drive-webdav-", [
	["parseXml, parseMultistatus, WebdavXmlError, XML_LIMITS, PROPFIND_BODY", "src/lib/drive/webdav-xml-utils.ts"],
	[
		"normalizeMountPath, mountPathSegments, joinMountPath, parentMountPath, mountPathName, isWithinMountPath, mountUrl, hrefToMountPath, parseWebdavUrl, webdavAddressProblem, isAllowedLocalAddress",
		"src/lib/drive/webdav-path-utils.ts",
	],
	["WebdavClient, WebdavError, WEBDAV_LIMITS, timedBody", "src/lib/drive/webdav-client.ts"],
	[
		"labelFromUrl, parseMountCredentials, webdavFailure, toMountItemDto, sortMountItems, parseMountUpload, parseMountMove, WEBDAV_MAX_UPLOAD_BYTES",
		"src/lib/drive/mount-utils.ts",
	],
	["redactBackupRow, restoredBackupRow", "src/lib/backups/external-accounts-utils.ts"],
]);

const PUBLIC = { allowInsecure: false, allowPrivate: false };
const INSECURE = { allowInsecure: true, allowPrivate: false };
const PRIVATE = { allowInsecure: false, allowPrivate: true };

/** The guard the tests run the client under: the e2e policy (http and loopback allowed). */
const guard = async (url) => {
	const problem = dav.webdavAddressProblem(url, INSECURE);
	if (problem) throw new Error(problem);
};

const servers = [];
after(() => Promise.all(servers.map((server) => server.close())));

async function fake(options) {
	const server = await startFakeWebdav(options);
	servers.push(server);
	return server;
}

function client(server, overrides = {}) {
	return new dav.WebdavClient(
		{
			url: new URL(overrides.url ?? server.url),
			username: server.username,
			password: overrides.password ?? server.password,
		},
		{ guard: overrides.guard ?? guard, timeoutMs: overrides.timeoutMs },
	);
}

async function rejectsKind(promise, kind) {
	await assert.rejects(promise, (error) => {
		assert.ok(error instanceof dav.WebdavError, `expected a WebdavError, got ${error}`);
		assert.equal(error.kind, kind, error.message);
		return true;
	});
}

const NEXTCLOUD = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns">
 <d:response>
  <d:href>/remote.php/dav/files/alice/Docs/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Tue, 03 Feb 2026 04:05:06 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/Docs/Q1%20report%20%26%20notes.pdf</d:href>
  <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>2048</d:getcontentlength><d:getcontenttype>application/pdf</d:getcontenttype><d:getetag>&quot;abc&quot;</d:getetag><oc:size>9</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

test("multistatus answers are read with any DAV: prefix, successful propstats only", () => {
	const entries = dav.parseMultistatus(NEXTCLOUD);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0], {
		href: "/remote.php/dav/files/alice/Docs/",
		collection: true,
		size: null,
		contentType: null,
		lastModified: "2026-02-03T04:05:06.000Z",
		etag: null,
		displayName: null,
	});
	assert.equal(entries[1].collection, false);
	assert.equal(entries[1].size, 2048);
	assert.equal(entries[1].contentType, "application/pdf");
	assert.equal(entries[1].etag, '"abc"');

	const defaultNs = `<multistatus xmlns="DAV:"><response><href>/a/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
	assert.equal(dav.parseMultistatus(defaultNs)[0].collection, true);
	const oddPrefix = `<Z:multistatus xmlns:Z="DAV:"><Z:response><Z:href>/f</Z:href><Z:propstat><Z:prop><Z:getcontentlength>7</Z:getcontentlength></Z:prop></Z:propstat></Z:response></Z:multistatus>`;
	assert.equal(dav.parseMultistatus(oddPrefix)[0].size, 7, "a propstat without status counts as success");
	const unqualified = `<multistatus><response><href>/g</href><propstat><prop><getcontentlength>3</getcontentlength></prop></propstat></response></multistatus>`;
	assert.equal(dav.parseMultistatus(unqualified)[0].size, 3);
});

test("elements of other namespaces, failed responses and bad values are ignored", () => {
	const xml = `<d:multistatus xmlns:d="DAV:" xmlns:x="urn:evil">
		<d:response><x:href>/evil</x:href><d:href>/real</d:href><d:propstat><d:prop><x:resourcetype><d:collection/></x:resourcetype><d:getcontentlength>-5</d:getcontentlength><d:getlastmodified>not a date</d:getlastmodified></d:prop></d:propstat></d:response>
		<d:response><d:href>/gone</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
		<d:response><d:propstat><d:prop/></d:propstat></d:response>
		<d:response><d:href>/huge</d:href><d:propstat><d:prop><d:getcontentlength>99999999999999999</d:getcontentlength></d:prop><d:status>garbage</d:status></d:propstat></d:response>
	</d:multistatus>`;
	const entries = dav.parseMultistatus(xml);
	assert.deepEqual(
		entries.map((entry) => entry.href),
		["/real", "/huge"],
	);
	assert.equal(entries[0].collection, false);
	assert.equal(entries[0].size, null);
	assert.equal(entries[0].lastModified, null);
	assert.equal(entries[1].size, null, "a propstat with an unreadable status is not a success");
	assert.throws(() => dav.parseMultistatus("<d:prop xmlns:d='DAV:'/>"), dav.WebdavXmlError);
});

test("document type declarations and entities are refused, so nothing can expand or fetch", () => {
	const hostile = [
		`<?xml version="1.0"?><!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"><d:response><d:href>&xxe;</d:href></d:response></d:multistatus>`,
		`<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><multistatus xmlns="DAV:">&lol2;</multistatus>`,
		`<!ENTITY x "y"><multistatus xmlns="DAV:"/>`,
		`<multistatus xmlns="DAV:"><response><href>&xxe;</href></response></multistatus>`,
		`<multistatus xmlns="DAV:"><response><href>&#0;</href></response></multistatus>`,
		`<multistatus xmlns="DAV:"><response><href>&#xD800;</href></response></multistatus>`,
		`<multistatus xmlns="DAV:" a="&ext;"/>`,
	];
	for (const xml of hostile) assert.throws(() => dav.parseXml(xml), dav.WebdavXmlError, xml.slice(0, 60));
});

test("text, CDATA, comments and character references decode as plain text", () => {
	const root = dav.parseXml(
		`﻿<?xml version="1.0"?><!-- hi --><a xmlns="urn:a" b='1 &amp; 2'><c>&lt;x&gt; &#65;&#x42; &apos;&quot;</c><c><![CDATA[<not> &markup;]]></c><?pi data?></a>`,
	);
	assert.equal(root.ns, "urn:a");
	assert.equal(root.children[0].text, `<x> AB '"`);
	assert.equal(root.children[1].text, "<not> &markup;");
});

test("malformed documents and oversized ones are refused", () => {
	const bad = [
		"",
		"just text",
		"<a><b></a></b>",
		"<a></a><b></b>",
		"<a>",
		"<a></a>trailing",
		"<a><!-- never ends",
		"<a><![CDATA[ never ends",
		"<a b=1></a>",
		"<1a/>",
		"</a>",
	];
	for (const xml of bad) assert.throws(() => dav.parseXml(xml), dav.WebdavXmlError, JSON.stringify(xml));
	const deep = `${"<a>".repeat(dav.XML_LIMITS.maxDepth + 1)}${"</a>".repeat(dav.XML_LIMITS.maxDepth + 1)}`;
	assert.throws(() => dav.parseXml(deep), /deeply/);
	const many = `<r>${"<a/>".repeat(dav.XML_LIMITS.maxElements)}</r>`;
	assert.throws(() => dav.parseXml(many), /Too many/);
	assert.throws(() => dav.parseXml(`<a>${"x".repeat(dav.XML_LIMITS.maxChars)}</a>`), /too large/);
	assert.match(dav.PROPFIND_BODY, /<d:propfind xmlns:d="DAV:">/);
	assert.ok(dav.parseXml(dav.PROPFIND_BODY));
});

test("paths stay inside the linked folder", () => {
	assert.equal(dav.normalizeMountPath(""), "/");
	assert.equal(dav.normalizeMountPath("/"), "/");
	assert.equal(dav.normalizeMountPath("Photos/2026/"), "/Photos/2026");
	assert.equal(dav.normalizeMountPath("//a"), "/a");
	for (const bad of ["/a//b", "/..", "/a/../b", "/./a", "/a\\b", "/a\u0000", "/a\nb", 7, null, `/${"x".repeat(256)}`])
		assert.equal(dav.normalizeMountPath(bad), null, JSON.stringify(bad));
	assert.equal(dav.normalizeMountPath(`/${Array(65).fill("a").join("/")}`), null);
	assert.equal(dav.normalizeMountPath(`/${"a/".repeat(2100)}`), null);
	assert.deepEqual(dav.mountPathSegments("/a/b"), ["a", "b"]);
	assert.equal(dav.joinMountPath("/", "a"), "/a");
	assert.equal(dav.joinMountPath("/a", "b"), "/a/b");
	assert.equal(dav.parentMountPath("/a/b"), "/a");
	assert.equal(dav.parentMountPath("/a"), "/");
	assert.equal(dav.mountPathName("/a/b c"), "b c");
	assert.equal(dav.isWithinMountPath("/a/b", "/a"), true);
	assert.equal(dav.isWithinMountPath("/ab", "/a"), false);
	assert.equal(dav.isWithinMountPath("/x", "/"), true);
});

test("server URLs encode every segment, and hrefs map back only from inside the folder", () => {
	const base = new URL("https://cloud.example.com/remote.php/dav/files/alice/My%20Docs/");
	assert.equal(
		dav.mountUrl(base, "/Q1 #1?/100% ü.txt").href,
		"https://cloud.example.com/remote.php/dav/files/alice/My%20Docs/Q1%20%231%3F/100%25%20%C3%BC.txt",
	);
	assert.equal(dav.mountUrl(base, "/sub", true).href, `${base.href}sub/`);
	assert.equal(dav.mountUrl(base, "/", true).href, base.href);
	assert.throws(() => dav.mountUrl(base, "/../x"));

	const path = (href) => dav.hrefToMountPath(href, base);
	assert.equal(path("/remote.php/dav/files/alice/My%20Docs/"), "/");
	assert.equal(path("/remote.php/dav/files/alice/My Docs/a%2fb"), "/a/b");
	assert.equal(path("/remote.php/dav/files/alice/My%20docs/x"), null, "segments compare case-sensitively");
	assert.equal(path("https://cloud.example.com/remote.php/dav/files/alice/My%20Docs/Q1%20%c3%bc.txt"), "/Q1 ü.txt");
	assert.equal(path("https://evil.example/remote.php/dav/files/alice/My%20Docs/x"), null);
	assert.equal(path("/remote.php/dav/files/alice/My%20Docs/../../bob/secret"), null);
	assert.equal(path("/remote.php/dav/files/alice/"), null);
	assert.equal(path("/remote.php/dav/files/alice/My%20Docs/%E0%A4%A"), null);
	assert.equal(path("/remote.php/dav/files/alice/My%20Docs/a%00b"), null);
	assert.equal(path("http://[bad"), null);
});

test("folder addresses are full http(s) URLs without credentials or a query", () => {
	assert.equal(
		dav.parseWebdavUrl(" https://cloud.example.com/dav/files/a ").url.href,
		"https://cloud.example.com/dav/files/a/",
	);
	assert.equal(
		dav.parseWebdavUrl("https://nas.example.com:5006/home#x").url.href,
		"https://nas.example.com:5006/home/",
	);
	for (const [value, error] of [
		["", /Enter/],
		[undefined, /Enter/],
		["cloud.example.com", /full address/],
		["ftp://cloud.example.com/", /https/],
		["https://alice:pw@cloud.example.com/", /username and password out/],
		["https://cloud.example.com/?x=1", /query/],
		["https://cloud.example.com/%E0%A4%A/", /not valid/],
		[`https://cloud.example.com/${"a".repeat(2100)}`, /too long/],
	])
		assert.match(dav.parseWebdavUrl(value).error, error, String(value));
});

test("the address guard refuses private hosts and plain http unless a flag allows them", () => {
	const problem = (url, policy) => dav.webdavAddressProblem(new URL(url), policy);
	assert.equal(problem("https://cloud.example.com/", PUBLIC), null);
	assert.match(problem("http://cloud.example.com/", PUBLIC), /https/);
	for (const host of [
		"127.0.0.1",
		"localhost",
		"10.0.0.5",
		"192.168.1.10",
		"172.16.0.1",
		"169.254.169.254",
		"[::1]",
		"[fd00::1]",
		"0.0.0.0",
		"nas",
		"127.1",
		"metadata.google.internal",
	])
		assert.match(problem(`https://${host}/`, PUBLIC), /Private and local/, host);
	assert.equal(problem("http://localhost:8080/", INSECURE), null);
	assert.equal(problem("http://127.0.0.1/", INSECURE), null);
	assert.match(problem("http://10.0.0.5/", INSECURE), /Private and local/);
	assert.equal(problem("http://cloud.example.com/", INSECURE), null);
	assert.equal(problem("http://192.168.1.10:5005/", PRIVATE), null);
	assert.match(
		problem("http://cloud.example.com/", PRIVATE),
		/https/,
		"the private flag never allows http to a public host",
	);
	assert.equal(dav.isAllowedLocalAddress(new URL("http://localhost/"), INSECURE), true);
	assert.equal(dav.isAllowedLocalAddress(new URL("https://cloud.example.com/"), INSECURE), false);
	assert.equal(dav.isAllowedLocalAddress(new URL("http://10.0.0.1/"), PRIVATE), true);
	assert.equal(dav.isAllowedLocalAddress(new URL("https://cloud.example.com/"), PUBLIC), false);
});

test("the link form is parsed into credentials, keeping saved values on an edit", () => {
	const fresh = dav.parseMountCredentials(
		{ url: "https://cloud.example.com/remote.php/dav/files/alice/Shared%20Docs", username: " alice ", password: "p w" },
		null,
	);
	assert.equal(fresh.label, "Shared Docs");
	assert.equal(fresh.username, "alice");
	assert.equal(fresh.password, "p w");
	assert.equal(fresh.url.href, "https://cloud.example.com/remote.php/dav/files/alice/Shared%20Docs/");
	assert.equal(dav.labelFromUrl(new URL("https://nas.example.com/")), "nas.example.com");
	assert.equal(dav.labelFromUrl(new URL("https://nas.example.com/%E0%A4%A/")), "%E0%A4%A");

	const saved = { label: "Work", baseUrl: "https://cloud.example.com/dav/", username: "alice", password: "old" };
	const edit = dav.parseMountCredentials({ label: "Team" }, saved);
	assert.deepEqual([edit.label, edit.url.href, edit.username, edit.password], ["Team", saved.baseUrl, "alice", "old"]);
	assert.equal(dav.parseMountCredentials({ password: "new" }, saved).password, "new");
	// The saved password never goes to another address or user: any change there needs it typed again.
	for (const change of [
		{ url: "https://attacker.example/" },
		{ url: "https://cloud.example.com/dav/other/" },
		{ url: "http://cloud.example.com/dav/" },
		{ username: "bob" },
		{ url: "https://cloud.example.com/dav/", username: "bob", password: "" },
	])
		assert.match(dav.parseMountCredentials(change, saved).error, /again/, JSON.stringify(change));
	assert.equal(
		dav.parseMountCredentials({ url: "https://attacker.example/", password: "typed" }, saved).password,
		"typed",
	);
	assert.equal(
		dav.parseMountCredentials({ url: "https://cloud.example.com/dav", username: "alice" }, saved).password,
		"old",
	);

	for (const [body, error] of [
		[null, /Invalid/],
		[{ url: "https://x.example/", password: "p" }, /username/],
		[{ url: "https://x.example/", username: "a" }, /app password/],
		[{ url: "https://x.example/", username: "a\nb", password: "p" }, /username is not valid/],
		[{ url: "https://x.example/", username: "a", password: "p\r\n" }, /paste only/],
		[{ url: "https://x.example/", username: "a", password: "x".repeat(1025) }, /paste only/],
		[{ url: "https://x.example/", username: "a", password: "p", label: "/" }, /name/],
		[{ url: "nope", username: "a", password: "p" }, /full address/],
	])
		assert.match(dav.parseMountCredentials(body, null).error, error, JSON.stringify(body));
	assert.match(dav.parseMountCredentials({ password: "" }, { ...saved, password: null }).error, /app password/);
});

test("WebDAV failures answer with Kite's own message and a code per kind", () => {
	const kinds = {
		auth: 502,
		forbidden: 403,
		not_found: 404,
		not_folder: 400,
		exists: 409,
		conflict: 409,
		too_large: 413,
		insufficient_storage: 507,
		blocked: 400,
		unreachable: 502,
		timeout: 504,
		invalid_answer: 502,
		server: 502,
	};
	for (const [kind, status] of Object.entries(kinds)) {
		const answer = dav.webdavFailure({ kind, message: "msg" });
		assert.equal(answer.status, status, kind);
		assert.deepEqual(answer.body, { error: "msg", code: `WEBDAV_${kind.toUpperCase()}` });
	}
});

test("uploads need a name, a declared length and the size limit", () => {
	const upload = (query, headers = {}) =>
		dav.parseMountUpload(new URL(`https://kite.example/x?${new URLSearchParams(query)}`), new Headers(headers));
	assert.deepEqual(
		upload({ parent: "/Docs", name: "a.txt" }, { "content-length": "5", "content-type": "Text/Plain" }),
		{
			path: "/Docs/a.txt",
			name: "a.txt",
			size: 5,
			contentType: "text/plain",
		},
	);
	assert.equal(upload({ name: "a" }, { "content-length": "0" }).path, "/a");
	assert.equal(upload({ name: "a" }).status, 411);
	assert.equal(upload({ name: "a" }, { "content-length": "-1" }).status, 411);
	assert.equal(upload({ name: "a" }, { "content-length": String(dav.WEBDAV_MAX_UPLOAD_BYTES + 1) }).status, 413);
	assert.equal(upload({ name: ".." }, { "content-length": "1" }).status, 400);
	assert.equal(upload({ parent: "/../x", name: "a" }, { "content-length": "1" }).status, 400);
});

test("moves rename, change folder or both, never into themselves", () => {
	assert.deepEqual(dav.parseMountMove({ path: "/a/b.txt", name: "c.txt" }), { from: "/a/b.txt", to: "/a/c.txt" });
	assert.deepEqual(dav.parseMountMove({ path: "/a/b.txt", parent: "/" }), { from: "/a/b.txt", to: "/b.txt" });
	assert.deepEqual(dav.parseMountMove({ path: "/a", parent: "/x", name: "y" }), { from: "/a", to: "/x/y" });
	for (const [body, error] of [
		[null, /Invalid/],
		[{ path: "/" }, /Invalid item/],
		[{ path: "/a/../b" }, /Invalid item/],
		[{ path: "/a", parent: "/../" }, /Invalid folder/],
		[{ path: "/a", name: "  " }, /Enter a name/],
		[{ path: "/a", name: "a" }, /Nothing/],
		[{ path: "/a", parent: "/a/b" }, /into itself/],
	])
		assert.match(dav.parseMountMove(body).error, error, JSON.stringify(body));
});

test("listings sort folders first and by name", () => {
	const item = (path, kind) =>
		dav.toMountItemDto({ path, kind, size: 1, contentType: null, updatedAt: null, etag: null });
	const sorted = dav.sortMountItems([
		item("/b10", "file"),
		item("/z", "folder"),
		item("/b9", "file"),
		item("/A", "folder"),
	]);
	assert.deepEqual(
		sorted.map((entry) => entry.name),
		["A", "z", "b9", "b10"],
	);
});

test("the client lists, reads, writes, moves and deletes against a WebDAV server", async () => {
	const server = await fake({
		files: {
			"/Docs": null,
			"/Docs/Q1 report & notes.pdf": "pdf-bytes",
			"/hello.txt": "hello world",
			"/Ünïcode #1": null,
		},
	});
	const webdav = client(server);
	const root = await webdav.list("/");
	assert.deepEqual(root.map((item) => [item.path, item.kind, item.size]).sort(), [
		["/Docs", "folder", 0],
		["/hello.txt", "file", 11],
		["/Ünïcode #1", "folder", 0],
	]);
	assert.equal(root.find((item) => item.path === "/hello.txt").updatedAt, "2026-02-03T04:05:06.000Z");
	assert.deepEqual(
		(await webdav.list("/Docs")).map((item) => item.path),
		["/Docs/Q1 report & notes.pdf"],
	);
	assert.deepEqual(await webdav.list("/Ünïcode #1"), []);
	assert.equal((await webdav.stat("/hello.txt")).kind, "file");
	await rejectsKind(webdav.list("/hello.txt"), "not_folder");
	await rejectsKind(webdav.list("/missing"), "not_found");
	assert.equal(server.requests.at(-1).headers.depth, "1");

	const whole = await webdav.get("/hello.txt");
	assert.equal(await whole.text(), "hello world");
	const part = await webdav.get("/hello.txt", { range: "bytes=6-" });
	assert.equal(part.status, 206);
	assert.equal(part.headers.get("content-range"), "bytes 6-10/11");
	assert.equal(await part.text(), "world");
	await rejectsKind(webdav.get("/nope.txt"), "not_found");

	await webdav.put("/Docs/new.txt", new TextEncoder().encode("fresh"), 5, "text/plain");
	assert.equal(server.file("/Docs/new.txt"), "fresh");
	assert.equal(server.requests.at(-1).headers["if-none-match"], "*");
	assert.equal(server.requests.at(-1).headers["content-length"], "5");
	const stream = new Blob(["streamed"]).stream();
	await webdav.put("/streamed.txt", stream, 8, "text/plain");
	assert.equal(server.file("/streamed.txt"), "streamed");
	await rejectsKind(webdav.put("/hello.txt", new Uint8Array([1]), 1, "text/plain"), "exists");
	await rejectsKind(webdav.put("/Missing/a.txt", new Uint8Array([1]), 1, "text/plain"), "conflict");

	await webdav.mkcol("/Docs/Sub folder");
	assert.equal(server.items.get("/Docs/Sub folder").kind, "folder");
	assert.match(server.requests.at(-1).path, /Sub%20folder\/$/);
	await rejectsKind(webdav.mkcol("/Docs"), "exists");
	await rejectsKind(webdav.mkcol("/Missing/x"), "conflict");

	await webdav.move("/Docs/new.txt", "/Docs/Sub folder/renamed.txt", false);
	assert.equal(server.file("/Docs/Sub folder/renamed.txt"), "fresh");
	assert.equal(server.requests.at(-1).headers.overwrite, "F");
	assert.equal(server.requests.at(-1).headers.destination, `${server.url}Docs/Sub%20folder/renamed.txt`);
	await webdav.move("/Docs", "/Archive", true);
	assert.equal(server.file("/Archive/Sub folder/renamed.txt"), "fresh");
	await rejectsKind(webdav.move("/Archive", "/hello.txt", true), "exists");

	await webdav.delete("/Archive", true);
	assert.equal(server.items.has("/Archive/Sub folder/renamed.txt"), false);
	await rejectsKind(webdav.delete("/Archive", true), "not_found");
	assert.ok(server.requests.every((request) => request.headers["user-agent"] === "Kite-WebDAV"));
});

test("a wrong password is an auth failure, and the guard runs before anything is sent", async () => {
	const server = await fake();
	await rejectsKind(client(server, { password: "wrong" }).list("/"), "auth");
	const before = server.requests.length;
	const refuse = async () => {
		throw new Error("Private and local addresses cannot be linked");
	};
	await assert.rejects(client(server, { guard: refuse }).list("/"), (error) => {
		assert.equal(error.kind, "blocked");
		assert.match(error.message, /Private and local/);
		return true;
	});
	assert.equal(server.requests.length, before, "nothing reached the server");
});

test("redirects are re-checked, credentials stay on the folder's origin, and only reads follow them", async () => {
	const other = await fake({ hostname: "127.0.0.1", files: { "/x.txt": "elsewhere" } });
	const server = await fake({
		files: { "/moved": null, "/moved/inner.txt": "inner" },
		routes: {
			"/remote.php/dav/files/alice/old/": (_, response) => {
				response.writeHead(301, { Location: "/remote.php/dav/files/alice/moved/" });
				response.end();
			},
			"/remote.php/dav/files/alice/elsewhere.txt": (_, response) => {
				response.writeHead(302, { Location: `${other.url}x.txt` });
				response.end();
			},
			"/remote.php/dav/files/alice/elsewhere/": (_, response) => {
				response.writeHead(302, { Location: `${other.url}` });
				response.end();
			},
			"/remote.php/dav/files/alice/private.txt": (_, response) => {
				response.writeHead(302, { Location: "http://10.0.0.1/secret" });
				response.end();
			},
			"/remote.php/dav/files/alice/ftp.txt": (_, response) => {
				response.writeHead(302, { Location: "ftp://example.com/x" });
				response.end();
			},
			"/remote.php/dav/files/alice/loop.txt": (_, response) => {
				response.writeHead(307, { Location: "/remote.php/dav/files/alice/loop.txt" });
				response.end();
			},
			"/remote.php/dav/files/alice/put.txt": (_, response) => {
				response.writeHead(307, { Location: "/remote.php/dav/files/alice/other.txt" });
				response.end();
			},
		},
	});
	const webdav = client(server);
	assert.deepEqual(
		(await webdav.list("/old")).map((item) => item.path),
		[],
		"the moved folder's hrefs lie outside the requested path, so nothing maps under /old",
	);
	assert.ok(server.requests.at(-1).headers.authorization, "a same-origin hop keeps the credentials");

	// The other origin answers 401: it never got the credentials.
	await rejectsKind(webdav.get("/elsewhere.txt"), "auth");
	assert.equal(other.requests.at(-1).path, "/remote.php/dav/files/alice/x.txt");
	assert.equal(other.requests.at(-1).headers.authorization, undefined);
	await rejectsKind(webdav.list("/elsewhere"), "server");
	await assert.rejects(webdav.get("/private.txt"), (error) => {
		assert.equal(error.kind, "blocked");
		assert.equal(error.message, "The server redirected to an address that is not allowed", "no host is echoed");
		return true;
	});
	await rejectsKind(webdav.get("/ftp.txt"), "blocked");
	await assert.rejects(webdav.get("/loop.txt"), /too many/);
	await rejectsKind(webdav.put("/put.txt", new Uint8Array([1]), 1, "text/plain"), "server");
	assert.equal(server.items.has("/other.txt"), false);
});

test("slow, oversized and hostile answers are refused", async () => {
	const big = "x".repeat(dav.WEBDAV_LIMITS.maxPropfindBytes + 1);
	const server = await fake({
		routes: {
			"/remote.php/dav/files/alice/slow/": () => undefined,
			"/remote.php/dav/files/alice/declared/": (_, response) => {
				response.writeHead(207, { "Content-Length": String(big.length) });
				response.end(big);
			},
			"/remote.php/dav/files/alice/chunked/": (_, response) => {
				response.writeHead(207, { "Content-Type": "application/xml" });
				response.write(big.slice(0, 1024));
				response.end(big.slice(1024));
			},
			"/remote.php/dav/files/alice/xxe/": (_, response) => {
				response.writeHead(207);
				response.end(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"/>`);
			},
			"/remote.php/dav/files/alice/foreign/": (_, response) => {
				response.writeHead(207);
				response.end(
					`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/alice/foreign/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>https://evil.example/remote.php/dav/files/alice/foreign/x</d:href></d:response><d:response><d:href>/remote.php/dav/files/bob/secret</d:href></d:response><d:response><d:href>/remote.php/dav/files/alice/foreign/deep/er</d:href></d:response><d:response><d:href>/remote.php/dav/files/alice/foreign/ok.txt</d:href></d:response></d:multistatus>`,
				);
			},
			"/remote.php/dav/files/alice/many/": (_, response) => {
				const entry = (index) => `<d:response><d:href>/remote.php/dav/files/alice/many/${index}</d:href></d:response>`;
				response.writeHead(207);
				response.end(
					`<d:multistatus xmlns:d="DAV:">${Array.from({ length: 5 }, (_, index) => entry(index)).join("")}</d:multistatus>`,
				);
			},
			"/remote.php/dav/files/alice/html/": (_, response) => {
				response.writeHead(200, { "Content-Type": "text/html" });
				response.end("<html>login</html>");
			},
		},
	});
	await rejectsKind(client(server, { timeoutMs: 150 }).list("/slow"), "timeout");
	const webdav = client(server);
	await rejectsKind(webdav.list("/declared"), "invalid_answer");
	await rejectsKind(webdav.list("/chunked"), "invalid_answer");
	await rejectsKind(webdav.list("/xxe"), "invalid_answer");
	await rejectsKind(webdav.list("/html"), "server");
	assert.deepEqual(
		(await webdav.list("/foreign")).map((item) => item.path),
		["/foreign/ok.txt"],
	);
	const saved = dav.WEBDAV_LIMITS.maxEntries;
	dav.WEBDAV_LIMITS.maxEntries = 3;
	try {
		await assert.rejects(webdav.list("/many"), /more than 3 items/);
	} finally {
		dav.WEBDAV_LIMITS.maxEntries = saved;
	}
});

test("an unreachable server and server errors have plain messages", async () => {
	const closed = createServer();
	await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
	const { port } = closed.address();
	await new Promise((resolve) => closed.close(resolve));
	const webdav = new dav.WebdavClient(
		{ url: new URL(`http://127.0.0.1:${port}/dav/`), username: "a", password: "b" },
		{ guard },
	);
	await assert.rejects(
		webdav.list("/"),
		(error) => error.kind === "unreachable" && error.message === "Could not reach the server",
	);

	const statuses = {
		"/remote.php/dav/files/alice/full.txt": 507,
		"/remote.php/dav/files/alice/big.txt": 413,
		"/remote.php/dav/files/alice/no.txt": 403,
		"/remote.php/dav/files/alice/oops.txt": 500,
		"/remote.php/dav/files/alice/partial/": 207,
	};
	const routes = Object.fromEntries(
		Object.entries(statuses).map(([path, status]) => [
			path,
			(_, response) => {
				response.writeHead(status);
				response.end();
			},
		]),
	);
	const server = await fake({ routes });
	const errors = client(server);
	await rejectsKind(errors.put("/full.txt", new Uint8Array([1]), 1, "text/plain"), "insufficient_storage");
	await rejectsKind(errors.put("/big.txt", new Uint8Array([1]), 1, "text/plain"), "too_large");
	await rejectsKind(errors.delete("/no.txt", false), "forbidden");
	await assert.rejects(errors.delete("/oops.txt", false), /answered 500/);
	await assert.rejects(errors.delete("/partial", true), /could not delete everything/);
	await rejectsKind(errors.stat("/no.txt"), "forbidden");
});

test("backups carry linked folders without their app password, and a restored one asks for it again", () => {
	const row = { id: "dmt_1", owner_id: "u1", base_url: "https://cloud.example/dav/", password: "sealed", status: "ok" };
	assert.deepEqual(dav.redactBackupRow("drive_mounts", row), { ...row, password: "" });
	assert.deepEqual(dav.restoredBackupRow("drive_mounts", row), {
		...row,
		password: "",
		status: "auth_failed",
		last_error: "Enter the app password again after the restore",
	});
	assert.equal(row.password, "sealed", "the exported row is a copy");
});

test("an upload's deadline grows with its size, so a slow upload is not cut off", async () => {
	const server = await fake();
	const size = 128 * 1024;
	const chunk = new Uint8Array(size / 4).fill(7);
	let sent = 0;
	const body = new ReadableStream({
		async pull(controller) {
			if (sent === 4) return controller.close();
			await new Promise((resolve) => setTimeout(resolve, 60));
			controller.enqueue(chunk);
			sent += 1;
		},
	});
	// 240 ms of sending against a 150 ms answer deadline, plus half a second for 128 KiB at the minimum rate.
	await client(server, { timeoutMs: 150 }).put("/slow.bin", body, size, "application/octet-stream");
	assert.equal(server.items.get("/slow.bin").data.length, size);
});

test("a download that stalls or runs too long is cut off, and the upstream body is cancelled", async () => {
	const chunks = (count, delayMs) => {
		let sent = 0;
		const state = { cancelled: false };
		const stream = new ReadableStream({
			async pull(controller) {
				if (sent === count) return controller.close();
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				controller.enqueue(new Uint8Array([sent++]));
			},
			cancel() {
				state.cancelled = true;
			},
		});
		return { stream, state };
	};
	const read = (stream) => new Response(stream).arrayBuffer().then((buffer) => new Uint8Array(buffer));

	const quick = chunks(3, 5);
	assert.deepEqual([...(await read(dav.timedBody(quick.stream, { idleMs: 200, totalMs: 1000 })))], [0, 1, 2]);

	const stalled = chunks(3, 300);
	await assert.rejects(read(dav.timedBody(stalled.stream, { idleMs: 50, totalMs: 1000 })), /stopped sending/);
	const slow = chunks(10, 40);
	await assert.rejects(read(dav.timedBody(slow.stream, { idleMs: 200, totalMs: 120 })), /stopped sending/);
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.ok(stalled.state.cancelled && slow.state.cancelled, "the upstream bodies were cancelled");

	const server = await fake({ files: { "/a.txt": "hello" } });
	await client(server)
		.get("/a.txt")
		.then((response) => response.text());
	assert.equal(server.requests.at(-1).headers["accept-encoding"], "identity");
});
