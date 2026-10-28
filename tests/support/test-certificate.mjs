import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isIP } from "node:net";

/**
 * A throwaway self-signed TLS certificate for the fake mail servers, built in memory (nothing is committed, so there
 * is no key in the repository). The certificate names `names` (DNS names or IP literals) in subjectAltName; tests
 * pass `cert` to the Node connector as its test-only `ca`.
 */

function tlv(tag, ...parts) {
	const content = Buffer.concat(parts);
	const length =
		content.length < 0x80
			? Buffer.from([content.length])
			: content.length < 0x100
				? Buffer.from([0x81, content.length])
				: Buffer.from([0x82, content.length >> 8, content.length & 0xff]);
	return Buffer.concat([Buffer.from([tag]), length, content]);
}
const seq = (...parts) => tlv(0x30, ...parts);
const oid = (...bytes) => tlv(0x06, Buffer.from(bytes));
const SHA256_RSA = seq(oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), tlv(0x05));
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);

function utcTime(date) {
	const pad = (value) => String(value).padStart(2, "0");
	const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
	return tlv(0x17, Buffer.from(text));
}

function ipBytes(address) {
	if (isIP(address) === 4) return Buffer.from(address.split(".").map(Number));
	throw new Error("Only IPv4 literals are supported in test certificates");
}

export function createTestCertificate(names = ["localhost", "127.0.0.1"]) {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const name = seq(tlv(0x31, seq(COMMON_NAME, tlv(0x0c, Buffer.from(names[0])))));
	const altNames = seq(
		...names.map((value) => (isIP(value) ? tlv(0x87, ipBytes(value)) : tlv(0x82, Buffer.from(value)))),
	);
	const serial = randomBytes(8);
	serial[0] &= 0x7f;
	const now = Date.now();
	const tbs = seq(
		tlv(0xa0, tlv(0x02, Buffer.from([2]))),
		tlv(0x02, serial),
		SHA256_RSA,
		name,
		seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 30 * 86_400_000))),
		name,
		publicKey.export({ type: "spki", format: "der" }),
		tlv(0xa3, seq(seq(SUBJECT_ALT_NAME, tlv(0x04, altNames)))),
	);
	const signature = sign("sha256", tbs, privateKey);
	const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.from([0]), signature));
	const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
	return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
