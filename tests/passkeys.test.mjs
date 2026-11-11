import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-passkeys-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { decodeCbor, decodeCborItem } from "./src/lib/auth/webauthn/cbor-utils.ts";
			export { base64UrlToBytes, bytesToBase64Url, timingSafeEqualStrings } from "./src/lib/auth/webauthn/base64url-utils.ts";
			export { verifyAssertion, verifyRegistration, WebAuthnError } from "./src/lib/auth/webauthn/verify-utils.ts";
			export {
				defaultPasskeyName,
				normalizePasskeyName,
				passkeyErrorMessage,
				relyingParty,
				sanitizeTransports,
				userHandleFor,
			} from "./src/lib/auth/passkey-utils.ts";
			export { consumePasskeyChallenge, createPasskeyChallenge } from "./src/lib/auth/passkey-challenges.ts";
			export {
				beginPasskeyRegistration,
				beginPasskeySignIn,
				deleteUserPasskeys,
				finishPasskeyRegistration,
				finishPasskeySignIn,
				listPasskeys,
				PasskeysUnavailableError,
				removePasskey,
			} from "./src/lib/auth/passkeys.ts";
			export { resetUserSecondFactors } from "./src/lib/auth/mfa.ts";
			export { verifyReauthentication } from "./src/lib/auth/reauth.ts";
			export { hashPassword } from "./src/lib/auth/password.ts";
			export { totp } from "./src/lib/auth/totp.ts";
			export { assertBackupTablesCoverDatabase } from "./src/lib/backups/export.ts";
			export { BACKUP_TABLE_GROUPS } from "./src/lib/backups/table-groups.ts";
		`,
		resolveDir: root,
		sourcefile: "passkeys-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const kite = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { base64UrlToBytes: fromB64u, bytesToBase64Url: b64u, WebAuthnError } = kite;

/** Real `navigator.credentials` output from Chromium's virtual authenticator, see the fixture's `_comment`. */
const vectors = JSON.parse(
	readFileSync(join(root, "tests/fixtures/webauthn/chromium-virtual-authenticator.json"), "utf8"),
);
const ALGORITHMS = { es256: -7, rs256: -257, eddsa: -8 };

function registrationInput(vector, overrides = {}) {
	return {
		clientDataJSON: fromB64u(vector.registration.clientDataJSON),
		attestationObject: fromB64u(vector.registration.attestationObject),
		expectedChallenge: vector.registration.challenge,
		expectedOrigin: vector.origin,
		expectedRpId: vector.rpId,
		...overrides,
	};
}

function assertionInput(vector, registered, index, overrides = {}) {
	const assertion = vector.assertions[index];
	return {
		clientDataJSON: fromB64u(assertion.clientDataJSON),
		authenticatorData: fromB64u(assertion.authenticatorData),
		signature: fromB64u(assertion.signature),
		publicKey: registered.publicKey,
		storedSignCount: registered.signCount,
		expectedChallenge: assertion.challenge,
		expectedOrigin: vector.origin,
		expectedRpId: vector.rpId,
		...overrides,
	};
}

async function rejectsWith(promise, code) {
	await assert.rejects(promise, (error) => error instanceof WebAuthnError && error.code === code);
}

// --- A tiny CBOR encoder and a software authenticator, for responses a browser would never send. ---

function cborHead(major, length) {
	if (length < 24) return [(major << 5) | length];
	if (length < 0x100) return [(major << 5) | 24, length];
	if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
	return [(major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
}

function cbor(value) {
	if (typeof value === "number") return Uint8Array.from(value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value));
	if (typeof value === "string") {
		const bytes = new TextEncoder().encode(value);
		return Uint8Array.from([...cborHead(3, bytes.length), ...bytes]);
	}
	if (value instanceof Uint8Array) return Uint8Array.from([...cborHead(2, value.length), ...value]);
	if (value instanceof Map) {
		const parts = [Uint8Array.from(cborHead(5, value.size))];
		for (const [key, item] of value) parts.push(cbor(key), cbor(item));
		return concat(...parts);
	}
	throw new Error("unsupported");
}

function concat(...parts) {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

async function sha256(bytes) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function rawToDer(raw) {
	const integer = (bytes) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let body = bytes.slice(start);
		if (body[0] & 0x80) body = concat(Uint8Array.of(0), body);
		return concat(Uint8Array.of(0x02, body.length), body);
	};
	const sequence = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return concat(Uint8Array.of(0x30, sequence.length), sequence);
}

async function softwareAuthenticator() {
	const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
	const cose = cbor(
		new Map([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, fromB64u(jwk.x)],
			[-3, fromB64u(jwk.y)],
		]),
	);
	const credentialId = crypto.getRandomValues(new Uint8Array(32));
	const clientData = (type, challenge, origin) =>
		new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	const authData = async (rpId, flags, signCount, attested) => {
		const head = new Uint8Array(37);
		head.set(await sha256(new TextEncoder().encode(rpId)), 0);
		head[32] = flags;
		new DataView(head.buffer).setUint32(33, signCount);
		return attested ? concat(head, attested) : head;
	};
	return {
		id: b64u(credentialId),
		async register({
			challenge,
			origin,
			rpId,
			flags = 0x45,
			signCount = 0,
			fmt = "none",
			attStmt = new Map(),
			publicKey = cose,
		}) {
			const attested = concat(new Uint8Array(16), Uint8Array.of(0, credentialId.length), credentialId, publicKey);
			const data = await authData(rpId, flags, signCount, attested);
			return {
				id: b64u(credentialId),
				rawId: b64u(credentialId),
				type: "public-key",
				response: {
					clientDataJSON: b64u(clientData("webauthn.create", challenge, origin)),
					attestationObject: b64u(
						cbor(
							new Map([
								["fmt", fmt],
								["attStmt", attStmt],
								["authData", data],
							]),
						),
					),
					transports: ["internal", "bogus"],
				},
			};
		},
		async assert({ challenge, origin, rpId, flags = 0x05, signCount = 0, userHandle }) {
			const data = await authData(rpId, flags, signCount);
			const client = clientData("webauthn.get", challenge, origin);
			const raw = new Uint8Array(
				await crypto.subtle.sign(
					{ name: "ECDSA", hash: "SHA-256" },
					keys.privateKey,
					concat(data, await sha256(client)),
				),
			);
			return {
				id: b64u(credentialId),
				rawId: b64u(credentialId),
				type: "public-key",
				response: {
					clientDataJSON: b64u(client),
					authenticatorData: b64u(data),
					signature: b64u(rawToDer(raw)),
					userHandle,
				},
			};
		},
	};
}

// --- Real browser vectors ---

for (const [name, algorithm] of Object.entries(ALGORITHMS)) {
	test(`${name}: a real "none" attestation registers and its assertions verify`, async () => {
		const vector = vectors[name];
		const registered = await kite.verifyRegistration(registrationInput(vector));
		assert.equal(registered.algorithm, algorithm);
		assert.equal(registered.attestationFormat, "none");
		assert.equal(registered.credentialId, vector.registration.id);
		const first = await kite.verifyAssertion(assertionInput(vector, registered, 0));
		assert.ok(first.signCount > registered.signCount);
		const second = await kite.verifyAssertion(
			assertionInput(vector, registered, 1, { storedSignCount: first.signCount }),
		);
		assert.ok(second.signCount > first.signCount);
		assert.equal(vector.assertions[0].userHandle, kite.userHandleFor("usr_test"));
	});

	test(`${name}: a counter that does not grow is refused`, async () => {
		const vector = vectors[name];
		const registered = await kite.verifyRegistration(registrationInput(vector));
		const second = fromB64u(vector.assertions[1].authenticatorData);
		const count = new DataView(second.buffer, second.byteOffset).getUint32(33);
		await rejectsWith(
			kite.verifyAssertion(assertionInput(vector, registered, 0, { storedSignCount: count })),
			"counter_regression",
		);
		await rejectsWith(
			kite.verifyAssertion(assertionInput(vector, registered, 1, { storedSignCount: count })),
			"counter_regression",
		);
	});

	test(`${name}: a tampered signature or signed data is refused`, async () => {
		const vector = vectors[name];
		const registered = await kite.verifyRegistration(registrationInput(vector));
		const signature = fromB64u(vector.assertions[0].signature);
		signature[signature.length - 1] ^= 0x01;
		await rejectsWith(kite.verifyAssertion(assertionInput(vector, registered, 0, { signature })), "bad_signature");
		// The other assertion's signature does not cover this one's data.
		await rejectsWith(
			kite.verifyAssertion(
				assertionInput(vector, registered, 0, { signature: fromB64u(vector.assertions[1].signature) }),
			),
			"bad_signature",
		);
	});
}

test("registration refuses the wrong origin, RP ID, challenge or ceremony type", async () => {
	const vector = vectors.es256;
	await rejectsWith(
		kite.verifyRegistration(registrationInput(vector, { expectedOrigin: "https://evil.example" })),
		"origin_mismatch",
	);
	await rejectsWith(
		kite.verifyRegistration(registrationInput(vector, { expectedOrigin: vector.origin.replace("http:", "https:") })),
		"origin_mismatch",
	);
	await rejectsWith(
		kite.verifyRegistration(registrationInput(vector, { expectedRpId: "example.com" })),
		"rp_id_mismatch",
	);
	await rejectsWith(
		kite.verifyRegistration(registrationInput(vector, { expectedChallenge: vectors.rs256.registration.challenge })),
		"challenge_mismatch",
	);
	await rejectsWith(
		kite.verifyRegistration(
			registrationInput(vector, {
				clientDataJSON: fromB64u(vector.assertions[0].clientDataJSON),
				expectedChallenge: vector.assertions[0].challenge,
			}),
		),
		"wrong_type",
	);
});

test("assertions refuse the wrong origin, RP ID, challenge, a missing UV flag and a registration's client data", async () => {
	const vector = vectors.es256;
	const registered = await kite.verifyRegistration(registrationInput(vector));
	await rejectsWith(
		kite.verifyAssertion(assertionInput(vector, registered, 0, { expectedOrigin: "http://localhost:1" })),
		"origin_mismatch",
	);
	await rejectsWith(
		kite.verifyAssertion(assertionInput(vector, registered, 0, { expectedRpId: "evil.localhost" })),
		"rp_id_mismatch",
	);
	// A replayed assertion answers an earlier challenge, never the one issued now.
	await rejectsWith(
		kite.verifyAssertion(assertionInput(vector, registered, 0, { expectedChallenge: vector.assertions[1].challenge })),
		"challenge_mismatch",
	);
	const withoutUv = fromB64u(vector.assertions[0].authenticatorData);
	withoutUv[32] &= ~0x04;
	await rejectsWith(
		kite.verifyAssertion(assertionInput(vector, registered, 0, { authenticatorData: withoutUv })),
		"user_not_verified",
	);
	const withoutUp = fromB64u(vector.assertions[0].authenticatorData);
	withoutUp[32] &= ~0x01;
	await rejectsWith(
		kite.verifyAssertion(assertionInput(vector, registered, 0, { authenticatorData: withoutUp })),
		"user_not_present",
	);
	await rejectsWith(
		kite.verifyAssertion(
			assertionInput(vector, registered, 0, {
				clientDataJSON: fromB64u(vector.registration.clientDataJSON),
				expectedChallenge: vector.registration.challenge,
			}),
		),
		"wrong_type",
	);
});

test("registration refuses missing user verification, a non-empty 'none' statement and an unsupported key", async () => {
	const authenticator = await softwareAuthenticator();
	const ceremony = {
		challenge: b64u(crypto.getRandomValues(new Uint8Array(32))),
		origin: "https://mail.example.com",
		rpId: "mail.example.com",
	};
	const verify = (credential) =>
		kite.verifyRegistration({
			clientDataJSON: fromB64u(credential.response.clientDataJSON),
			attestationObject: fromB64u(credential.response.attestationObject),
			expectedChallenge: ceremony.challenge,
			expectedOrigin: ceremony.origin,
			expectedRpId: ceremony.rpId,
		});
	assert.equal((await verify(await authenticator.register(ceremony))).algorithm, -7);
	await rejectsWith(verify(await authenticator.register({ ...ceremony, flags: 0x41 })), "user_not_verified");
	await rejectsWith(
		verify(await authenticator.register({ ...ceremony, attStmt: new Map([["alg", -7]]) })),
		"malformed",
	);
	// Backed up without being backup eligible is impossible.
	await rejectsWith(verify(await authenticator.register({ ...ceremony, flags: 0x55 })), "malformed");
	const es256 = await kite.verifyRegistration(registrationInput(vectors.es256));
	await rejectsWith(
		kite.verifyRegistration({ ...registrationInput(vectors.eddsa), allowedAlgorithms: [-7] }),
		"unsupported_algorithm",
	);
	assert.equal(es256.algorithm, -7);
});

test("a counter of 0 on both sides is accepted, as synced passkeys report", async () => {
	const authenticator = await softwareAuthenticator();
	const ceremony = { origin: "https://mail.example.com", rpId: "mail.example.com" };
	const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
	const credential = await authenticator.register({ ...ceremony, challenge });
	const registered = await kite.verifyRegistration({
		clientDataJSON: fromB64u(credential.response.clientDataJSON),
		attestationObject: fromB64u(credential.response.attestationObject),
		expectedChallenge: challenge,
		expectedOrigin: ceremony.origin,
		expectedRpId: ceremony.rpId,
	});
	assert.equal(registered.signCount, 0);
	for (const storedSignCount of [0, 0]) {
		const next = b64u(crypto.getRandomValues(new Uint8Array(32)));
		const assertion = await authenticator.assert({ ...ceremony, challenge: next });
		const result = await kite.verifyAssertion({
			clientDataJSON: fromB64u(assertion.response.clientDataJSON),
			authenticatorData: fromB64u(assertion.response.authenticatorData),
			signature: fromB64u(assertion.response.signature),
			publicKey: registered.publicKey,
			storedSignCount,
			expectedChallenge: next,
			expectedOrigin: ceremony.origin,
			expectedRpId: ceremony.rpId,
		});
		assert.equal(result.signCount, 0);
	}
	// A counter that drops back to 0 after counting is a regression.
	const last = b64u(crypto.getRandomValues(new Uint8Array(32)));
	const assertion = await authenticator.assert({ ...ceremony, challenge: last });
	await rejectsWith(
		kite.verifyAssertion({
			clientDataJSON: fromB64u(assertion.response.clientDataJSON),
			authenticatorData: fromB64u(assertion.response.authenticatorData),
			signature: fromB64u(assertion.response.signature),
			publicKey: registered.publicKey,
			storedSignCount: 5,
			expectedChallenge: last,
			expectedOrigin: ceremony.origin,
			expectedRpId: ceremony.rpId,
		}),
		"counter_regression",
	);
});

// --- Parsers ---

test("the CBOR decoder reads WebAuthn's subset and refuses everything else", () => {
	assert.deepEqual(kite.decodeCbor(Uint8Array.of(0x83, 0x01, 0x20, 0x41, 0xff)), [1, -1, Uint8Array.of(0xff)]);
	assert.equal(kite.decodeCbor(Uint8Array.of(0x19, 0x01, 0x00)), 256);
	assert.equal(kite.decodeCbor(Uint8Array.of(0x39, 0x01, 0x00)), -257);
	assert.equal(kite.decodeCbor(Uint8Array.of(0x63, 0x61, 0x62, 0x63)), "abc");
	const map = kite.decodeCbor(Uint8Array.of(0xa2, 0x01, 0x02, 0x61, 0x6b, 0xf5));
	assert.equal(map.get(1), 2);
	assert.equal(map.get("k"), true);
	for (const bad of [
		Uint8Array.of(0x9f, 0x01, 0xff), // indefinite array
		Uint8Array.of(0xc1, 0x01), // tag
		Uint8Array.of(0xf9, 0x3c, 0x00), // half float
		Uint8Array.of(0x01, 0x02), // trailing byte
		Uint8Array.of(0x42, 0x01), // short byte string
		Uint8Array.of(0xa2, 0x01, 0x01, 0x01, 0x02), // duplicate key
		Uint8Array.of(0xa1, 0x41, 0x00, 0x01), // byte-string key
		Uint8Array.of(0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), // beyond safe integers
	]) {
		assert.throws(() => kite.decodeCbor(bad), /CBOR/);
	}
	const deep = new Uint8Array(40).fill(0x81);
	assert.throws(() => kite.decodeCbor(concat(deep, Uint8Array.of(0x01))), /deeply/);
});

async function softwareAssertion(authenticator, site) {
	const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
	const credential = await authenticator.register({ ...site, challenge });
	const registered = await kite.verifyRegistration({
		clientDataJSON: fromB64u(credential.response.clientDataJSON),
		attestationObject: fromB64u(credential.response.attestationObject),
		expectedChallenge: challenge,
		expectedOrigin: site.origin,
		expectedRpId: site.rpId,
	});
	const next = b64u(crypto.getRandomValues(new Uint8Array(32)));
	const assertion = await authenticator.assert({ ...site, challenge: next, signCount: 1 });
	return (overrides = {}) =>
		kite.verifyAssertion({
			clientDataJSON: fromB64u(assertion.response.clientDataJSON),
			authenticatorData: fromB64u(assertion.response.authenticatorData),
			signature: fromB64u(assertion.response.signature),
			publicKey: registered.publicKey,
			storedSignCount: 0,
			expectedChallenge: next,
			expectedOrigin: site.origin,
			expectedRpId: site.rpId,
			...overrides,
		});
}

test("DER ECDSA signatures with padding verify and malformed DER is a bad signature", async () => {
	const site = { origin: "https://mail.example.com", rpId: "mail.example.com" };
	// Enough signatures that r or s with a high bit (a 0x00 pad in DER) and shorter values both come up.
	for (let round = 0; round < 8; round++) {
		const verify = await softwareAssertion(await softwareAuthenticator(), site);
		assert.equal((await verify()).signCount, 1);
	}
	const real = fromB64u(vectors.es256.assertions[0].signature);
	const registered = await kite.verifyRegistration(registrationInput(vectors.es256));
	for (const broken of [
		concat(real, Uint8Array.of(0)), // trailing byte
		real.slice(0, real.length - 1), // truncated
		Uint8Array.of(0x31, ...real.slice(1)), // not a SEQUENCE
		Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01), // tiny r and s, wrong value
	]) {
		await rejectsWith(
			kite.verifyAssertion(assertionInput(vectors.es256, registered, 0, { signature: broken })),
			"bad_signature",
		);
	}
});

test("authenticator data that is short, has trailing bytes or a bad credential length is malformed", async () => {
	const vector = vectors.es256;
	const registered = await kite.verifyRegistration(registrationInput(vector));
	const data = fromB64u(vector.assertions[0].authenticatorData);
	const attested = concat(data, new Uint8Array(16), Uint8Array.of(0x04, 0x00));
	attested[32] |= 0x40;
	for (const authenticatorData of [concat(data, Uint8Array.of(0)), data.slice(0, 36), attested]) {
		await rejectsWith(kite.verifyAssertion(assertionInput(vector, registered, 0, { authenticatorData })), "malformed");
	}
});

test("COSE keys: RSA under 2048 bits, other curves, missing coordinates and unknown algorithms are refused", async () => {
	const authenticator = await softwareAuthenticator();
	const site = { origin: "https://mail.example.com", rpId: "mail.example.com" };
	const register = async (publicKey) => {
		const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
		const credential = await authenticator.register({ ...site, challenge, publicKey: cbor(publicKey) });
		return kite.verifyRegistration({
			clientDataJSON: fromB64u(credential.response.clientDataJSON),
			attestationObject: fromB64u(credential.response.attestationObject),
			expectedChallenge: challenge,
			expectedOrigin: site.origin,
			expectedRpId: site.rpId,
		});
	};
	const rsaKey = async (bits) => {
		const keys = await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: bits, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
			true,
			["sign", "verify"],
		);
		const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
		return new Map([
			[1, 3],
			[3, -257],
			[-1, fromB64u(jwk.n)],
			[-2, fromB64u(jwk.e)],
		]);
	};
	assert.equal((await register(await rsaKey(2048))).algorithm, -257);
	await rejectsWith(register(await rsaKey(1024)), "unsupported_algorithm");
	const xy = new Uint8Array(32).fill(1);
	await rejectsWith(
		register(
			new Map([
				[1, 2],
				[3, -7],
				[-1, 2],
				[-2, xy],
				[-3, xy],
			]),
		),
		"unsupported_algorithm",
	);
	await rejectsWith(
		register(
			new Map([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, xy],
			]),
		),
		"unsupported_algorithm",
	);
	await rejectsWith(
		register(
			new Map([
				[1, 2],
				[3, -36],
				[-1, 1],
				[-2, xy],
				[-3, xy],
			]),
		),
		"unsupported_algorithm",
	);
	// A point that is not on the curve cannot be imported, so it is never stored.
	await rejectsWith(
		register(
			new Map([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, xy],
				[-3, xy],
			]),
		),
		"unsupported_algorithm",
	);
});

test("the relying party is APP_URL's host, else the request's; transports and names are sanitized", () => {
	assert.deepEqual(kite.relyingParty("https://mail.example.com/app", "http://10.0.0.2:3000/api"), {
		id: "mail.example.com",
		origin: "https://mail.example.com",
	});
	assert.deepEqual(kite.relyingParty(undefined, "http://localhost:3200/api/auth/passkey/options"), {
		id: "localhost",
		origin: "http://localhost:3200",
	});
	assert.deepEqual(kite.relyingParty("not a url", "http://localhost:3200/x"), {
		id: "localhost",
		origin: "http://localhost:3200",
	});
	assert.deepEqual(kite.sanitizeTransports(["internal", "bogus", "hybrid", "internal", 3]), ["internal", "hybrid"]);
	assert.equal(kite.normalizePasskeyName("  Work \n laptop  "), "Work laptop");
	assert.equal(kite.normalizePasskeyName("   "), null);
});

test("passkey names, error messages and base64url decoding", () => {
	const names = [
		["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone or iPad passkey"],
		["Mozilla/5.0 (Linux; Android 15; Pixel 9)", "Android passkey"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "Mac passkey"],
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Windows passkey"],
		["Mozilla/5.0 (X11; Linux x86_64)", "Linux passkey"],
		["curl/8.0", "Passkey"],
		[null, "Passkey"],
	];
	for (const [agent, name] of names) assert.equal(kite.defaultPasskeyName(agent), name);
	assert.equal(kite.normalizePasskeyName(42), null);
	assert.equal(kite.normalizePasskeyName("x".repeat(100)).length, 64);
	const messages = new Set(
		[
			"challenge_mismatch",
			"origin_mismatch",
			"rp_id_mismatch",
			"user_not_verified",
			"user_not_present",
			"unsupported_algorithm",
			"counter_regression",
			"bad_signature",
		].map((code) => kite.passkeyErrorMessage(code)),
	);
	assert.equal(messages.size, 6);
	assert.deepEqual(kite.sanitizeTransports("usb"), []);

	assert.deepEqual(fromB64u("AQID"), Uint8Array.of(1, 2, 3));
	assert.deepEqual(fromB64u("_-8"), Uint8Array.of(0xff, 0xef));
	assert.equal(b64u(Uint8Array.of(0xff, 0xef)), "_-8");
	assert.equal(b64u(new Uint8Array(70_000)).length, 93_334);
	for (const bad of ["AQ==", "A", "AQ+/", "a b"]) assert.throws(() => fromB64u(bad), TypeError);
	assert.equal(kite.timingSafeEqualStrings("abc", "abc"), true);
	assert.equal(kite.timingSafeEqualStrings("abc", "abd"), false);
	assert.equal(kite.timingSafeEqualStrings("abc", "abcd"), false);
});

// --- Database: challenges, the full ceremony, pre-migration behaviour ---

async function database(t, { migrated = true } = {}) {
	const db = new kite.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await kite.applyMigrations(db, join(root, "drizzle/migrations"));
	if (!migrated) db.db.exec("DROP TABLE passkeys; DROP TABLE passkey_challenges;");
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('usr_a', 'a@example.com', '${kite.hashPassword("correct horse")}', 'A', 1),
			('usr_b', 'b@example.com', 'x', 'B', 1);
	`);
	return { env: { DB: db }, db: db.db };
}

const request = (url = "http://localhost:3200/api/x") =>
	new Request(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh)" } });

test("a challenge is single-use and bound to its purpose, user and session", async (t) => {
	const { env, db } = await database(t);
	const issue = (input) => kite.createPasskeyChallenge(env, input);
	const one = await issue({ purpose: "register", userId: "usr_a", sessionToken: "sess_1" });
	assert.equal(
		await kite.consumePasskeyChallenge(env, one.token, {
			purpose: "register",
			userId: "usr_a",
			sessionToken: "sess_1",
		}),
		one.challenge,
	);
	assert.equal(
		await kite.consumePasskeyChallenge(env, one.token, {
			purpose: "register",
			userId: "usr_a",
			sessionToken: "sess_1",
		}),
		null,
	);

	for (const expected of [
		{ purpose: "authenticate", userId: "usr_a", sessionToken: "sess_1" },
		{ purpose: "register", userId: "usr_b", sessionToken: "sess_1" },
		{ purpose: "register", userId: "usr_a", sessionToken: "sess_2" },
	]) {
		const issued = await issue({ purpose: "register", userId: "usr_a", sessionToken: "sess_1" });
		assert.equal(await kite.consumePasskeyChallenge(env, issued.token, expected), null);
		// A refused attempt still used the challenge up.
		assert.equal(
			await kite.consumePasskeyChallenge(env, issued.token, {
				purpose: "register",
				userId: "usr_a",
				sessionToken: "sess_1",
			}),
			null,
		);
	}

	const expired = await issue({ purpose: "authenticate" });
	db.prepare("UPDATE passkey_challenges SET expires_at = ?").run(Math.floor(Date.now() / 1000) - 1);
	assert.equal(await kite.consumePasskeyChallenge(env, expired.token, { purpose: "authenticate" }), null);
	await issue({ purpose: "authenticate" });
	assert.equal(db.prepare("SELECT count(*) AS n FROM passkey_challenges").get().n, 1, "expired ceremonies are cleared");
});

test("register, sign in, refuse a replay and a foreign origin, then remove", async (t) => {
	const { env, db } = await database(t);
	const user = { id: "usr_a", email: "a@example.com", name: "A" };
	const authenticator = await softwareAuthenticator();
	const site = { origin: "http://localhost:3200", rpId: "localhost" };

	const started = await kite.beginPasskeyRegistration(env, request(), user, "sess_1");
	assert.equal(started.ok, true);
	const { options, ceremonyId } = started.value;
	assert.equal(options.rp.id, "localhost");
	assert.equal(options.attestation, "none");
	assert.equal(options.authenticatorSelection.userVerification, "required");
	assert.deepEqual(
		options.pubKeyCredParams.map((param) => param.alg),
		[-7, -8, -257],
	);
	assert.equal(options.user.id, kite.userHandleFor("usr_a"));

	const credential = await authenticator.register({ ...site, challenge: options.challenge });
	// Another session cannot finish this ceremony.
	const stolen = await kite.finishPasskeyRegistration(env, request(), user, "sess_2", {
		ceremonyId,
		name: null,
		credential,
	});
	assert.equal(stolen.ok, false);
	const again = await kite.beginPasskeyRegistration(env, request(), user, "sess_1");
	const credential2 = await authenticator.register({ ...site, challenge: again.value.options.challenge });
	const saved = await kite.finishPasskeyRegistration(env, request(), user, "sess_1", {
		ceremonyId: again.value.ceremonyId,
		name: "  ",
		credential: credential2,
	});
	assert.equal(saved.ok, true, JSON.stringify(saved));
	assert.equal(saved.value.name, "Mac passkey");
	assert.equal(db.prepare("SELECT transports FROM passkeys").get().transports, '["internal"]');
	const excluded = await kite.beginPasskeyRegistration(env, request(), user, "sess_1");
	assert.deepEqual(
		excluded.value.options.excludeCredentials.map((item) => item.id),
		[authenticator.id],
	);

	// Sign in.
	const signIn = await kite.beginPasskeySignIn(env, request());
	assert.deepEqual(signIn.options.allowCredentials, []);
	const assertion = await authenticator.assert({
		...site,
		challenge: signIn.options.challenge,
		userHandle: kite.userHandleFor("usr_a"),
	});
	const signedIn = await kite.finishPasskeySignIn(env, request(), signIn.token, assertion);
	assert.deepEqual(signedIn.ok && signedIn.value.userId, "usr_a");
	assert.ok(db.prepare("SELECT last_used_at FROM passkeys").get().last_used_at);

	// The same assertion again: the ceremony is used up, and a new ceremony has another challenge.
	const replay = await kite.finishPasskeySignIn(env, request(), signIn.token, assertion);
	assert.equal(replay.code, "expired");
	const fresh = await kite.beginPasskeySignIn(env, request());
	const replayFresh = await kite.finishPasskeySignIn(env, request(), fresh.token, assertion);
	assert.equal(replayFresh.code, "challenge_mismatch");

	// Signed for another origin, or naming another account.
	const other = await kite.beginPasskeySignIn(env, request());
	const phished = await authenticator.assert({
		origin: "http://localhost:9999",
		rpId: "localhost",
		challenge: other.options.challenge,
		userHandle: kite.userHandleFor("usr_a"),
	});
	assert.equal((await kite.finishPasskeySignIn(env, request(), other.token, phished)).code, "origin_mismatch");
	const swapped = await kite.beginPasskeySignIn(env, request());
	const wrongUser = await authenticator.assert({
		...site,
		challenge: swapped.options.challenge,
		userHandle: kite.userHandleFor("usr_b"),
	});
	assert.equal((await kite.finishPasskeySignIn(env, request(), swapped.token, wrongUser)).code, "user_handle_mismatch");

	// A disabled account cannot sign in with its passkey.
	db.prepare("UPDATE users SET disabled = 1 WHERE id = 'usr_a'").run();
	const disabled = await kite.beginPasskeySignIn(env, request());
	const disabledAssertion = await authenticator.assert({
		...site,
		challenge: disabled.options.challenge,
		userHandle: kite.userHandleFor("usr_a"),
	});
	assert.equal((await kite.finishPasskeySignIn(env, request(), disabled.token, disabledAssertion)).status, 403);
	db.prepare("UPDATE users SET disabled = 0 WHERE id = 'usr_a'").run();

	// Only the owner removes it.
	assert.equal(await kite.removePasskey(env, "usr_b", saved.value.id), null);
	assert.equal(await kite.removePasskey(env, "usr_a", saved.value.id), "Mac passkey");
	assert.deepEqual(await kite.listPasskeys(env, "usr_a"), []);
	const gone = await kite.beginPasskeySignIn(env, request());
	const afterRemoval = await authenticator.assert({
		...site,
		challenge: gone.options.challenge,
		userHandle: kite.userHandleFor("usr_a"),
	});
	assert.equal((await kite.finishPasskeySignIn(env, request(), gone.token, afterRemoval)).code, "unknown_credential");
});

test("an admin reset removes passkeys, TOTP and sessions", async (t) => {
	const { env, db } = await database(t);
	db.exec(`
		UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = 'usr_a';
		INSERT INTO passkeys (id, user_id, credential_id, public_key, algorithm, name, created_at) VALUES
			('pk_1', 'usr_a', 'cred1', 'key', -7, 'Phone', 1), ('pk_2', 'usr_b', 'cred2', 'key', -7, 'Other', 1);
		INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s1', 'usr_a', 'h', 9999999999, 1);
	`);
	assert.deepEqual(await kite.resetUserSecondFactors(env, "usr_a"), { passkeysRemoved: 1 });
	assert.equal(db.prepare("SELECT totp_enabled FROM users WHERE id = 'usr_a'").get().totp_enabled, 0);
	assert.deepEqual(
		db
			.prepare("SELECT id FROM passkeys")
			.all()
			.map((row) => row.id),
		["pk_2"],
	);
	assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
});

test("re-authentication takes the password or a TOTP code, never a recovery code", async () => {
	const user = { passwordHash: kite.hashPassword("correct horse"), totpEnabled: false, totpSecret: null };
	assert.equal(await kite.verifyReauthentication(user, { password: "correct horse" }), true);
	assert.equal(await kite.verifyReauthentication(user, { password: "wrong" }), false);
	assert.equal(await kite.verifyReauthentication(user, { code: "123456" }), false);
	const secret = "JBSWY3DPEHPK3PXP";
	const withTotp = { ...user, totpEnabled: true, totpSecret: secret };
	assert.equal(await kite.verifyReauthentication(withTotp, { code: await kite.totp(secret) }), true);
	assert.equal(await kite.verifyReauthentication(withTotp, { code: "abcd-efgh" }), false);
	// A secret that was never confirmed does not count.
	assert.equal(
		await kite.verifyReauthentication({ ...withTotp, totpEnabled: false }, { code: await kite.totp(secret) }),
		false,
	);
});

test("before migration 0112 passkeys report unavailable and resets still work", async (t) => {
	const { env } = await database(t, { migrated: false });
	await assert.rejects(kite.listPasskeys(env, "usr_a"), kite.PasskeysUnavailableError);
	await assert.rejects(kite.beginPasskeySignIn(env, request()), kite.PasskeysUnavailableError);
	assert.equal(await kite.deleteUserPasskeys(env, "usr_a"), 0);
	assert.deepEqual(await kite.resetUserSecondFactors(env, "usr_a"), { passkeysRemoved: 0 });
});

test("backups carry passkeys with the accounts, never the ceremonies", async (t) => {
	const { env } = await database(t);
	const covered = await kite.assertBackupTablesCoverDatabase(env.DB);
	assert.ok(covered.has("passkeys"));
	assert.ok(!covered.has("passkey_challenges"));
	const accounts = kite.BACKUP_TABLE_GROUPS.find((group) => group.id === "accounts");
	assert.ok(accounts.tables.includes("passkeys"));
});
