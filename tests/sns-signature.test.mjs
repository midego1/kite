import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
	parseCertificate,
	snsCertificateUrl,
	snsStringToSign,
	verifySnsSignature,
} from "../src/lib/aws/sns-signature.ts";

// A synthetic key and a hand-built certificate: nothing here is AWS's, and nothing is fetched.

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
const time = (tag, text) => tlv(tag, Buffer.from(text));

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = publicKey.export({ type: "spki", format: "der" });
const SHA256_RSA = seq(tlv(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])), tlv(0x05));

function certificatePem({ notBefore = "250101000000Z", notAfter = "20991231235959Z" } = {}) {
	const tbs = seq(
		tlv(0xa0, tlv(0x02, Buffer.from([2]))),
		tlv(0x02, Buffer.from([1])),
		SHA256_RSA,
		seq(),
		seq(time(notBefore.length === 13 ? 0x17 : 0x18, notBefore), time(notAfter.length === 13 ? 0x17 : 0x18, notAfter)),
		seq(),
		spki,
		tlv(0xa3, seq()),
	);
	const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.from([0, 0])));
	return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
}

const CERT_URL = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem";

function signed(envelope, version = "1") {
	const message = { SignatureVersion: version, SigningCertURL: CERT_URL, ...envelope };
	const signer = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
	signer.update(snsStringToSign(message));
	return { ...message, Signature: signer.sign(privateKey, "base64") };
}

const notification = {
	Type: "Notification",
	MessageId: "11111111-2222-3333-4444-555555555555",
	TopicArn: "arn:aws:sns:eu-west-1:123456789012:mailflare-inbound",
	Message: '{"notificationType":"Received"}',
	Timestamp: "2026-10-26T10:00:00.000Z",
};

function fetcher(pem = certificatePem()) {
	const calls = [];
	const fetch = async (url) => {
		calls.push(url);
		return new Response(pem);
	};
	return { fetch, calls };
}

test("the string to sign lists the documented fields in order, Subject only when present", () => {
	assert.equal(
		snsStringToSign(notification),
		`Message\n${notification.Message}\nMessageId\n${notification.MessageId}\nTimestamp\n${notification.Timestamp}\nTopicArn\n${notification.TopicArn}\nType\nNotification\n`,
	);
	assert.match(snsStringToSign({ ...notification, Subject: "Hi" }), /MessageId\n[^\n]+\nSubject\nHi\nTimestamp/);
	const confirmation = { ...notification, Type: "SubscriptionConfirmation", SubscribeURL: "https://x", Token: "t" };
	assert.match(snsStringToSign(confirmation), /SubscribeURL\nhttps:\/\/x\nTimestamp\n[^\n]+\nToken\nt\nTopicArn/);
	assert.equal(snsStringToSign({ ...confirmation, Token: undefined }), null);
	assert.equal(snsStringToSign({ ...notification, Type: "Other" }), null);
	assert.equal(snsStringToSign({ ...notification, Timestamp: undefined }), null);
});

test("the certificate URL is pinned to the topic's region over HTTPS", () => {
	assert.ok(snsCertificateUrl(CERT_URL, "eu-west-1"));
	for (const url of [
		"http://sns.eu-west-1.amazonaws.com/a.pem",
		"https://sns.us-east-1.amazonaws.com/a.pem",
		"https://sns.eu-west-1.amazonaws.com.attacker.test/a.pem",
		"https://attacker.test/sns.eu-west-1.amazonaws.com/a.pem",
		"https://sns.eu-west-1.amazonaws.com:8443/a.pem",
		"https://user@sns.eu-west-1.amazonaws.com/a.pem",
		"https://sns.eu-west-1.amazonaws.com/a.txt",
		"not a url",
		undefined,
	])
		assert.equal(snsCertificateUrl(url, "eu-west-1"), null, String(url));
	assert.equal(snsCertificateUrl(CERT_URL, "eu-west-1/../x"), null);
});

test("certificates give their public key and validity", () => {
	const parsed = parseCertificate(certificatePem());
	assert.deepEqual(Buffer.from(parsed.spki), spki);
	assert.equal(parsed.notBefore, Date.UTC(2025, 0, 1));
	assert.equal(parsed.notAfter, Date.UTC(2099, 11, 31, 23, 59, 59));
	assert.throws(() => parseCertificate("nothing"));
});

test("signature versions 1 and 2 verify; tampering, other keys and bad certificates do not", async () => {
	const { fetch, calls } = fetcher();
	assert.equal(await verifySnsSignature(signed(notification, "1"), "eu-west-1", fetch), true);
	assert.equal(await verifySnsSignature(signed(notification, "2"), "eu-west-1", fetch), true);
	assert.equal(await verifySnsSignature(signed({ ...notification, Subject: "Hi" }, "2"), "eu-west-1", fetch), true);
	// The key is cached per certificate URL and hash.
	await verifySnsSignature(signed(notification, "1"), "eu-west-1", fetch);
	assert.equal(calls.length, 2);

	const tampered = { ...signed(notification, "2"), Message: '{"notificationType":"Received","x":1}' };
	assert.equal(await verifySnsSignature(tampered, "eu-west-1", fetch), false);
	assert.equal(await verifySnsSignature({ ...signed(notification), SignatureVersion: "3" }, "eu-west-1", fetch), false);
	assert.equal(await verifySnsSignature({ ...signed(notification), Signature: undefined }, "eu-west-1", fetch), false);
	assert.equal(await verifySnsSignature({ ...signed(notification), Signature: "!!" }, "eu-west-1", fetch), false);
	assert.equal(await verifySnsSignature(signed(notification), "us-east-1", fetch), false);

	const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const forged = createSign("RSA-SHA256").update(snsStringToSign(notification)).sign(other.privateKey, "base64");
	assert.equal(
		await verifySnsSignature({ ...signed(notification, "2"), Signature: forged }, "eu-west-1", fetch),
		false,
	);

	const expired = fetcher(certificatePem({ notAfter: "250601000000Z" })).fetch;
	const expiredUrl = { SigningCertURL: CERT_URL.replace("test.pem", "expired.pem") };
	assert.equal(await verifySnsSignature(signed({ ...notification, ...expiredUrl }), "eu-west-1", expired), false);
	const broken = async () => new Response("not a certificate");
	const brokenUrl = { SigningCertURL: CERT_URL.replace("test.pem", "broken.pem") };
	assert.equal(await verifySnsSignature(signed({ ...notification, ...brokenUrl }), "eu-west-1", broken), false);
	const down = async () => new Response("", { status: 503 });
	const downUrl = { SigningCertURL: CERT_URL.replace("test.pem", "down.pem") };
	assert.equal(await verifySnsSignature(signed({ ...notification, ...downUrl }), "eu-west-1", down), false);
});
