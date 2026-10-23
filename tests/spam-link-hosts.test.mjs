import assert from "node:assert/strict";
import test from "node:test";
import {
	decodePunycode,
	displayedHost,
	hostAndParents,
	isClickTracker,
	isIpHost,
	isLookalikeHost,
	isUrlShortener,
	linkHostsOf,
	linkTextMismatch,
	registrableDomain,
	sameRegistrableDomain,
	summarizeLinks,
	unicodeHost,
} from "../src/lib/spam/analyzers/link-host-utils.ts";

test("registrable domains drop subdomains and keep country second levels and shared hosting names", () => {
	assert.equal(registrableDomain("example.com"), "example.com");
	assert.equal(registrableDomain("WWW.Example.COM."), "example.com");
	assert.equal(registrableDomain("a.b.mail.example.com"), "example.com");
	assert.equal(registrableDomain("mail.example.co.uk"), "example.co.uk");
	assert.equal(registrableDomain("shop.example.com.au"), "example.com.au");
	assert.equal(registrableDomain("example.co.jp"), "example.co.jp");
	assert.equal(registrableDomain("x.y.example.de"), "example.de");
	assert.equal(registrableDomain("tracking.co.example.com"), "example.com", "a co label below a gTLD is a plain label");
	assert.equal(registrableDomain("attacker.github.io"), "attacker.github.io");
	assert.equal(registrableDomain("deep.site.pages.dev"), "site.pages.dev");
	assert.equal(registrableDomain("github.io"), "github.io");
	assert.equal(registrableDomain("localhost"), "localhost");
	assert.equal(registrableDomain("192.168.1.1"), "192.168.1.1");
	assert.equal(registrableDomain("[2001:db8::1]"), "[2001:db8::1]");
	assert.equal(sameRegistrableDomain("click.example.com", "www.example.com"), true);
	assert.equal(sameRegistrableDomain("example.com", "example.net"), false);
	assert.equal(sameRegistrableDomain("a.github.io", "b.github.io"), false);
});

test("IP hosts: dotted IPv4 and bracketed IPv6, not names made of digits", () => {
	for (const host of ["127.0.0.1", "192.168.1.1", "[::1]", "[2001:db8::1]", "[::ffff:192.0.2.1]"])
		assert.equal(isIpHost(host), true, host);
	for (const host of ["example.com", "1.2.3", "1.2.3.4.example.com", "123.example", "[nope]"])
		assert.equal(isIpHost(host), false, host);
	// The URL parser already turns decimal and hex forms into dotted ones.
	assert.equal(isIpHost(new URL("http://3232235777/").hostname), true);
	assert.equal(isIpHost(new URL("http://0x7f.1/").hostname), true);
});

test("URL shorteners and click trackers are recognised by name", () => {
	for (const host of ["bit.ly", "www.bit.ly", "tinyurl.com", "t.co", "rb.gy"])
		assert.equal(isUrlShortener(host), true, host);
	for (const host of ["example.com", "bit.ly.example.com", "notbit.ly"])
		assert.equal(isUrlShortener(host), false, host);
	assert.equal(isClickTracker("abc.r.us-east-1.awstrack.me"), true);
	assert.equal(isClickTracker("example.us12.list-manage.com"), true);
	assert.equal(isClickTracker("awstrack.me.example.com"), false);
});

test("Punycode decodes RFC 3492 labels and refuses invalid ones", () => {
	assert.equal(decodePunycode("mnchen-3ya"), "münchen");
	assert.equal(decodePunycode("bcher-kva"), "bücher");
	assert.equal(decodePunycode("pple-43d"), "аpple");
	assert.equal(decodePunycode("80ak6aa92e"), "аррӏе");
	assert.equal(decodePunycode("fsqu00a"), "例子");
	assert.equal(decodePunycode("hxajbheg2az3al"), "παράδειγμα");
	assert.equal(decodePunycode("abc-"), "abc");
	for (const invalid of ["zz-!", "999999999999", "ü-abc", "-99999999", "abc-9"])
		assert.equal(decodePunycode(invalid), null, invalid);
	assert.equal(unicodeHost("xn--mnchen-3ya.de"), "münchen.de");
	assert.equal(unicodeHost("www.xn--zz-!.test"), "www.xn--zz-!.test", "a label that does not decode stays");
});

test("look-alike hosts mix alphabets or spell a Latin name in Cyrillic or Greek", () => {
	assert.equal(isLookalikeHost("xn--pple-43d.com"), true, "Cyrillic а in apple");
	assert.equal(isLookalikeHost("xn--80ak6aa92e.com"), true, "apple spelled in Cyrillic");
	assert.equal(isLookalikeHost("login.xn--ypal-43d9g.com"), true, "раypal");
	assert.equal(isLookalikeHost("xn--zz-!.test"), true, "invalid Punycode");
	assert.equal(isLookalikeHost("xn--mnchen-3ya.de"), false, "Latin with an umlaut");
	assert.equal(isLookalikeHost("xn--r8jz45g.jp"), false, "Japanese");
	assert.equal(isLookalikeHost("xn--hxajbheg2az3al.xn--jxalpdlp"), false, "Greek words");
	assert.equal(isLookalikeHost("xn--80aswg.xn--p1ai"), false, "Cyrillic words");
	assert.equal(isLookalikeHost("xn--123-4b0a.test"), false, "digits only around one letter");
	assert.equal(isLookalikeHost("example.com"), false);
});

test("displayed hosts: full URLs and bare host names, never file names, prose or addresses", () => {
	assert.equal(displayedHost("https://Accounts.Example.com/login"), "accounts.example.com");
	assert.equal(displayedHost(" http://example.com "), "example.com");
	assert.equal(displayedHost("www.paypal.com"), "www.paypal.com");
	assert.equal(displayedHost("paypal.com/login?next=1"), "paypal.com");
	assert.equal(displayedHost("example.co.uk:8443"), "example.co.uk");
	assert.equal(displayedHost("pаypal.com"), "xn--pypal-4ve.com", "Unicode text is compared in Punycode");
	for (const text of [
		"",
		"Click here",
		"README.md",
		"invoice.pdf",
		"setup.zip",
		"v1.2",
		"example.com.",
		"support@example.com",
		"example",
		"https://",
		"http://exa mple.com",
	])
		assert.equal(displayedHost(text), null, text);
});

test("link text mismatches compare registrable domains", () => {
	assert.equal(linkTextMismatch("https://evil.test/login", "paypal.com"), true);
	assert.equal(linkTextMismatch("https://evil.test/login", "https://www.paypal.com/"), true);
	assert.equal(linkTextMismatch("https://198.51.100.7/", "bank.example.com"), true);
	assert.equal(linkTextMismatch("https://attacker.github.io/", "github.io"), true);
	assert.equal(
		linkTextMismatch("https://click.example.com/r/1", "example.com"),
		false,
		"a subdomain of the shown site",
	);
	assert.equal(linkTextMismatch("https://example.com/reset", "https://www.example.com/reset"), false);
	assert.equal(linkTextMismatch("https://evil.test/", "Reset your password"), false);
	assert.equal(linkTextMismatch("mailto:help@evil.test", "example.com"), false);
	assert.equal(linkTextMismatch("javascript:alert(1)", "example.com"), false);
	assert.equal(linkTextMismatch("https://exa mple", "example.com"), false, "an unparsable destination");
});

test("a click tracker counts as the destination it carries, not as a different site", () => {
	const tracked = "https://abc.r.us-east-1.awstrack.me/L0/https:%2F%2Fexample.com%2Freset%3Ft=1/1/0100abc";
	assert.equal(linkTextMismatch(tracked, "https://example.com/reset"), false);
	assert.equal(linkTextMismatch(tracked, "example.com"), false);
	assert.equal(linkTextMismatch(tracked, "paypal.com"), true, "the carried address is another site");
	assert.equal(
		linkTextMismatch("https://abc.r.us-east-1.awstrack.me/L0/opaque-token", "example.com"),
		true,
		"nothing carried",
	);
	assert.equal(linkTextMismatch("https://abc.awstrack.me/L0/%E0%A4%A", "example.com"), true, "undecodable");
	assert.equal(
		linkTextMismatch("https://evil.test/?next=https://example.com/", "example.com"),
		true,
		"only known trackers count as carrying a destination",
	);
});

test("link hosts are distinct, without www, in order and capped", () => {
	assert.deepEqual(
		linkHostsOf("See https://www.Example.com/a and http://example.com/b, then https://cdn.example.net/x"),
		["example.com", "cdn.example.net"],
	);
	assert.deepEqual(linkHostsOf("no links here"), []);
	const many = Array.from({ length: 10 }, (_, index) => `https://h${index}.test/`).join(" ");
	assert.deepEqual(linkHostsOf(many, 3), ["h0.test", "h1.test", "h2.test"]);
	assert.deepEqual(linkHostsOf("https://[2001:db8::1]/x https://"), ["[2001:db8::1]"]);
});

test("summarized links mark hosts on the sender's registrable domain and drop anything that is not a plain name", () => {
	assert.deepEqual(
		summarizeLinks("Reset@Mail.Example.co.uk", ["accounts.example.co.uk", "EVIL.test", "a b.test", "[2001:db8::1]"]),
		{
			senderDomain: "example.co.uk",
			hosts: [
				{ host: "accounts.example.co.uk", sameAsSender: true },
				{ host: "evil.test", sameAsSender: false },
				{ host: "[2001:db8::1]", sameAsSender: false },
			],
		},
	);
	assert.deepEqual(summarizeLinks("not-an-address", ["example.com"]), {
		senderDomain: null,
		hosts: [{ host: "example.com", sameAsSender: false }],
	});
	assert.equal(summarizeLinks("a@localhost", []).senderDomain, null);
	assert.equal(summarizeLinks("a@example.com", ["h1.test", "h2.test", "h3.test"], 2).hosts.length, 2);
	assert.equal(summarizeLinks("a@example.com", [`${"a".repeat(250)}.test`]).hosts.length, 0);
});

test("a host and its parents stop at the registrable domain", () => {
	assert.deepEqual(hostAndParents("a.mail.example.com"), ["a.mail.example.com", "mail.example.com", "example.com"]);
	assert.deepEqual(hostAndParents("Mail.Example.co.uk."), ["mail.example.co.uk", "example.co.uk"]);
	assert.deepEqual(hostAndParents("example.com"), ["example.com"]);
	assert.deepEqual(hostAndParents("www.example.com"), ["www.example.com", "example.com"]);
	assert.deepEqual(hostAndParents(""), []);
});
