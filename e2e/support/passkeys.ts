import { createHmac } from "node:crypto";
import type { CDPSession, Page } from "@playwright/test";

/**
 * Chromium's virtual authenticator (CDP WebAuthn domain): a platform authenticator with resident keys that
 * verifies the user and confirms presence on its own, so `navigator.credentials` answers without a prompt.
 */
export async function addVirtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	return { cdp, authenticatorId };
}

export async function storedCredentials(cdp: CDPSession, authenticatorId: string) {
	const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
	return credentials;
}

function base32Decode(input: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const char of input.replace(/=+$/, "").toUpperCase())
		bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
	return Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
}

/** The current RFC 6238 code for a base32 secret, as an authenticator app would show it. */
export function totpCode(secret: string, at = Date.now()): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
	const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
