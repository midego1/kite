import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-one-time-code-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/email/one-time-code-utils.ts")],
	outfile: join(outDir, "one-time-code-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
await build({
	entryPoints: [join(root, "src/hooks/message-realtime-utils.ts")],
	outfile: join(outDir, "message-realtime-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	external: ["react", "react-dom", "next", "next/*"],
});
await build({
	entryPoints: [join(root, "src/hooks/new-message-notification-utils.ts")],
	outfile: join(outDir, "new-message-notification-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { extractOneTimeCode } = await import(pathToFileURL(join(outDir, "one-time-code-utils.mjs")).href);
const { buildNewMessageNotificationParts, buildTestCodeNotificationParts, makeTestOneTimeCode } = await import(
	pathToFileURL(join(outDir, "new-message-notification-utils.mjs")).href
);
const { parseNewMessageEvent } = await import(pathToFileURL(join(outDir, "message-realtime-utils.mjs")).href);

/** Every example below is invented; brand names are fictional. */
test("extracts a plain code after a keyword", () => {
	assert.equal(
		extractOneTimeCode({
			subject: "Your sign-in code",
			text: "Hello,\n\nYour verification code is 481923. It expires in 10 minutes.",
		}),
		"481923",
	);
});

test("extracts a code from the subject before the body", () => {
	assert.equal(
		extractOneTimeCode({ subject: "482 911 is your login code", text: "Open the app and confirm." }),
		"482911",
	);
	assert.equal(
		extractOneTimeCode({ subject: "Confirm your email", text: "Enter 554108 to finish signing up at Zurple." }),
		"554108",
	);
});

test("strips a single space or dash separator", () => {
	assert.equal(extractOneTimeCode({ subject: null, text: "Use code 293 518 to sign in." }), "293518");
	assert.equal(extractOneTimeCode({ subject: null, text: "Use code 293-518 to sign in." }), "293518");
});

test("accepts 4 to 8 digit codes", () => {
	assert.equal(extractOneTimeCode({ subject: null, text: "Your security code is 4821. Do not share it." }), "4821");
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Your security code is 48212345. Do not share it." }),
		"48212345",
	);
});

test("accepts uppercase alphanumeric codes with a digit and a letter", () => {
	assert.equal(extractOneTimeCode({ subject: null, text: "Your one-time passcode is G7H2K9." }), "G7H2K9");
	assert.equal(extractOneTimeCode({ subject: "Verification", text: "Enter 7QM4W2 in the app." }), "7QM4W2");
});

test("accepts a keyword after the code", () => {
	assert.equal(extractOneTimeCode({ subject: null, text: "820341 is your verification code." }), "820341");
});

test("uses a subject keyword for a body that is only the code", () => {
	assert.equal(extractOneTimeCode({ subject: "Your verification code", text: "554108" }), "554108");
	assert.equal(extractOneTimeCode({ subject: "Your sign-in code", text: "Enter 554 108" }), "554108");
});

test("accepts Dutch keywords", () => {
	assert.equal(extractOneTimeCode({ subject: "Inlogcode", text: "Jouw inlogcode is 331408." }), "331408");
	assert.equal(extractOneTimeCode({ subject: null, text: "Voer deze eenmalige code in: 512 990." }), "512990");
	assert.equal(extractOneTimeCode({ subject: null, text: "Uw verificatiecode is 990045." }), "990045");
});

test("returns the same code repeated in the body once", () => {
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Your code is 771243. Enter 771243 in the app to continue." }),
		"771243",
	);
});

test("returns null without a keyword near the number", () => {
	assert.equal(
		extractOneTimeCode({ subject: "Your weekly update", text: "Report 123456 is ready. See the dashboard." }),
		null,
	);
	assert.equal(extractOneTimeCode({ subject: null, text: "Invoice attached. Number 4481029." }), null);
});

test("returns null when two different candidates are valid (ambiguous)", () => {
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Your verification code is 445566. Your second code is 778899." }),
		null,
	);
	assert.equal(extractOneTimeCode({ subject: "Code 112233 and code 445566", text: null }), null);
});

test("rejects plausible years, even with a keyword nearby", () => {
	assert.equal(
		extractOneTimeCode({
			subject: null,
			text: "You have been with Nodsoft since 2019. Your verification code is 654321.",
		}),
		"654321",
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Thank you for joining in March 2024. Please verify your account." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Copyright 2026 Nodsoft Ltd. All rights reserved. See our terms." }),
		null,
	);
	assert.equal(extractOneTimeCode({ subject: null, text: "Renewed on 12 March 2025. Your code is 881172." }), "881172");
});

test("accepts a plausible year only when directly introduced by a keyword", () => {
	assert.equal(extractOneTimeCode({ subject: null, text: "Your code is 2024. Use it within 5 minutes." }), "2024");
});

test("rejects ISO and slashed dates", () => {
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Planned maintenance on 2025-04-12. Reply CODE to confirm nothing." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Session booked for 03/12/2024 at noon. Verify to proceed." }),
		null,
	);
});

test("rejects prices and currency amounts", () => {
	assert.equal(
		extractOneTimeCode({ subject: null, text: "You paid $49.99. Order confirmed. Code available on request." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Your total was EUR 12 345,00 and your receipt is attached." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Amount due: €1.234,56. Please verify your bank details." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "That will be 12 345 USD, charged to your verified card." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Your verification code is 554108. Total $0 due." }),
		"554108",
	);
});

test("rejects a phone word or a hash right in front of the digits", () => {
	assert.equal(
		extractOneTimeCode({ subject: null, text: "tel: 06123456, bereikbaar tot 18:00 om te verifiëren." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Call 402 918 to speak to support and confirm the change." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Add pass #582914 to your account. Please confirm the top-up." }),
		null,
	);
});

test("rejects phone number shapes", () => {
	assert.equal(
		extractOneTimeCode({
			subject: null,
			text: "Questions? Call our support line on +31 20 123 4567 to verify your identity.",
		}),
		null,
	);
	assert.equal(
		extractOneTimeCode({
			subject: null,
			text: "You can reach us at (020) 1234 567 any working day to confirm details.",
		}),
		null,
	);
	assert.equal(extractOneTimeCode({ subject: null, text: "Bel 0900 1234 om je account te bevestigen." }), null);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "US support: 1-800-555-0199, please confirm we may call you." }),
		null,
	);
});

test("rejects long digit runs and digit fragments of longer tokens", () => {
	assert.equal(
		extractOneTimeCode({
			subject: null,
			text: "Your confirmation reference is 123456789012. Verify at portal.example.",
		}),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Firmware v2.4021 shipped. Please confirm the upgrade." }),
		null,
	);
});

test("rejects candidates inside URLs", () => {
	assert.equal(
		extractOneTimeCode({
			subject: null,
			text: "Verify your account at https://verify.example.com/confirm?token=12345678 today.",
		}),
		null,
	);
});

test("rejects order, invoice and reference numbers", () => {
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Your order 12345678 has shipped. Thanks for buying from Nodsoft." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Order number 4481029 confirmed. Track it on our site." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Factuur 2024-118 is verzonden. Bevestig ontvangst a.u.b." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Please confirm your order 582914 so we can start packing it." }),
		null,
	);
	assert.equal(
		extractOneTimeCode({ subject: null, text: "Your booking reference is 991827. See you at the hotel!" }),
		null,
	);
});

test("keeps a real code when an order number is farther away", () => {
	assert.equal(
		extractOneTimeCode({
			subject: null,
			text: "Order 33445566 confirmed. Your verification code is 718290. It expires in 10 minutes.",
		}),
		"718290",
	);
});

test("keeps a code when a label word sits behind a keyword", () => {
	assert.equal(
		extractOneTimeCode({ subject: null, text: "To verify your account, use code 530918 within 15 minutes." }),
		"530918",
	);
});

test("rejects lowercase alphanumerics and short or letter-only tokens", () => {
	assert.equal(extractOneTimeCode({ subject: null, text: "Your code is g7h2k9. Enter it soon." }), null);
	assert.equal(extractOneTimeCode({ subject: null, text: "Your code is 482." }), null);
	assert.equal(extractOneTimeCode({ subject: null, text: "Your code is 482123459." }), null);
	assert.equal(extractOneTimeCode({ subject: null, text: "The code word is ORCHID." }), null);
});

test("handles empty and missing input", () => {
	assert.equal(extractOneTimeCode({ subject: null, text: null }), null);
	assert.equal(extractOneTimeCode({ subject: "", text: "  " }), null);
	assert.equal(extractOneTimeCode({ subject: "Verify your email", text: "" }), null);
});

test("ignores an invalid subject and falls back to the body", () => {
	assert.equal(extractOneTimeCode({ subject: "Order 12345678 shipped", text: "Your login code is 664123." }), "664123");
});

test("notification parts lead with the code when the setting is on", () => {
	const event = {
		type: "new_message",
		messageId: "msg_1",
		mailboxId: "mbx_1",
		from: "security@nodsoft.example",
		fromName: "Nodsoft",
		subject: "Your sign-in code",
		oneTimeCode: "481923",
	};
	assert.deepEqual(buildNewMessageNotificationParts(event, true), {
		title: "481923 · Your sign-in code",
		body: "From Nodsoft · Click to copy",
		code: "481923",
	});
	const withoutName = { ...event, fromName: null };
	assert.deepEqual(buildNewMessageNotificationParts(withoutName, true), {
		title: "481923 · Your sign-in code",
		body: "From security@nodsoft.example · Click to copy",
		code: "481923",
	});
});

test("the Settings test code is six digits and shaped like a real code notification", () => {
	assert.equal(
		makeTestOneTimeCode(() => 0),
		"100000",
	);
	assert.equal(
		makeTestOneTimeCode(() => 0.999999),
		"999999",
	);
	assert.equal(
		makeTestOneTimeCode(() => 0.5),
		"550000",
	);
	for (let i = 0; i < 50; i++) assert.match(makeTestOneTimeCode(), /^[1-9]\d{5}$/);
	assert.deepEqual(buildTestCodeNotificationParts("482913"), {
		title: "482913 · Test sign-in code",
		body: "From Kite · Click to copy",
		code: "482913",
	});
});

test("notification parts keep the classic shape without a code or with the setting off", () => {
	const event = {
		type: "new_message",
		messageId: "msg_1",
		mailboxId: "mbx_1",
		from: "news@nodsoft.example",
		fromName: "Nodsoft",
		subject: "Weekly digest",
		oneTimeCode: null,
	};
	assert.deepEqual(buildNewMessageNotificationParts(event, true), {
		title: "Weekly digest",
		body: "From Nodsoft",
		code: null,
	});
	assert.deepEqual(buildNewMessageNotificationParts({ ...event, subject: null }, true), {
		title: "New email",
		body: "From Nodsoft",
		code: null,
	});
	const withCode = { ...event, subject: "Your sign-in code", oneTimeCode: "481923" };
	assert.deepEqual(buildNewMessageNotificationParts(withCode, false), {
		title: "Your sign-in code",
		body: "From Nodsoft",
		code: null,
	});
});

test("parseNewMessageEvent passes the one-time code through and rejects junk", () => {
	const parsed = parseNewMessageEvent(
		JSON.stringify({
			type: "new_message",
			messageId: "msg_1",
			mailboxId: "mbx_1",
			from: "a@b.example",
			fromName: "A",
			subject: "Your code",
			oneTimeCode: "481923",
		}),
	);
	assert.equal(parsed?.oneTimeCode, "481923");
	const withoutCode = parseNewMessageEvent(
		JSON.stringify({ type: "new_message", messageId: "m", mailboxId: "b", from: "a@b.example" }),
	);
	assert.equal(withoutCode?.oneTimeCode, null);
	const badCode = parseNewMessageEvent(
		JSON.stringify({ type: "new_message", messageId: "m", mailboxId: "b", from: "a@b.example", oneTimeCode: 42 }),
	);
	assert.equal(badCode?.oneTimeCode, null);
	assert.equal(parseNewMessageEvent("not json"), null);
	assert.equal(parseNewMessageEvent(JSON.stringify({ type: "revision", revision: "1" })), null);
});
