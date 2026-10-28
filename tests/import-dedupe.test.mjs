import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { importDedupeKey, storedIdVariants, dedupeKeyOfStored, threadSeed, decodeHostImportMessage } =
	await bundleModules("kite-import-dedupe-", [
		["importDedupeKey, storedIdVariants, dedupeKeyOfStored", "src/lib/import/dedupe-utils.ts"],
		["threadSeed", "src/lib/email/threading.ts"],
		["decodeHostImportMessage", "src/lib/email/module-import-utils.ts"],
	]);

const bytes = (text) => new TextEncoder().encode(text).buffer;

test("a Message-ID is stored as written and compared without its angle brackets", async () => {
	assert.deepEqual(await importDedupeKey("<abc@example.org>", bytes("x")), {
		stored: "<abc@example.org>",
		key: "abc@example.org",
	});
	assert.deepEqual(await importDedupeKey(" abc@example.org ", bytes("x")), {
		stored: "abc@example.org",
		key: "abc@example.org",
	});
	assert.deepEqual(storedIdVariants("abc@example.org"), ["abc@example.org", "<abc@example.org>"]);
	assert.equal(dedupeKeyOfStored("<abc@example.org>"), "abc@example.org");
	assert.equal(dedupeKeyOfStored("abc@example.org"), "abc@example.org");
	assert.equal(dedupeKeyOfStored(null), null);
});

test("a message without a Message-ID is keyed by the SHA-256 of its bytes, whatever its file name", async () => {
	const raw = "From: a@example.org\r\nSubject: no id\r\n\r\nbody\r\n";
	const hex = createHash("sha256").update(raw).digest("hex");
	for (const messageId of [null, "", "  ", "<>"]) {
		assert.deepEqual(await importDedupeKey(messageId, bytes(raw)), {
			stored: `import:sha256:${hex}`,
			key: `import:sha256:${hex}`,
		});
	}
	assert.notEqual((await importDedupeKey(null, bytes(`${raw}!`))).key, `import:sha256:${hex}`);
	assert.deepEqual(storedIdVariants(`import:sha256:${hex}`), [`import:sha256:${hex}`]);
});

test("imports seed a thread with the conversation root; received mail keeps its own Message-ID", () => {
	const reply = { mailboxId: "m", messageId: "<c@x>", inReplyTo: "b@x", references: ["a@x", "b@x"] };
	assert.equal(threadSeed(reply), "c@x");
	assert.equal(threadSeed({ ...reply, fallback: "references-root" }), "a@x");
	assert.equal(threadSeed({ ...reply, references: [], fallback: "references-root" }), "b@x");
	assert.equal(threadSeed({ mailboxId: "m", messageId: "<a@x>", fallback: "references-root" }), "a@x");
	assert.equal(threadSeed({ mailboxId: "m", messageId: null, fallback: "references-root" }), null);
	// The root and every reply meet on the same key, whatever order they are imported in.
	const parent = {
		mailboxId: "m",
		messageId: "<b@x>",
		inReplyTo: "a@x",
		references: ["a@x"],
		fallback: "references-root",
	};
	const root = { mailboxId: "m", messageId: "<a@x>", fallback: "references-root" };
	assert.equal(
		new Set([reply, parent, root].map((input) => threadSeed({ ...input, fallback: "references-root" }))).size,
		1,
	);
});

test("host import messages keep only real read, starred and receivedAt values", () => {
	const base = { raw: "Subject: x\r\n\r\nbody" };
	const kept = decodeHostImportMessage({ ...base, read: true, starred: false, receivedAt: "2026-10-27T10:00:00Z" }, 0);
	assert.equal(kept.read, true);
	assert.equal(kept.starred, false);
	assert.equal(kept.receivedAt.toISOString(), "2026-10-27T10:00:00.000Z");
	const plain = decodeHostImportMessage(base, 0);
	assert.deepEqual(Object.keys(plain).sort(), ["filename", "raw"]);
	const junk = decodeHostImportMessage({ ...base, read: "yes", starred: 1, receivedAt: "yesterday" }, 0);
	assert.deepEqual(Object.keys(junk).sort(), ["filename", "raw"]);
});
