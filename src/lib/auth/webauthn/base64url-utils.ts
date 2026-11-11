/** Base64url without padding (RFC 4648 §5), the encoding WebAuthn uses for challenges and credential ids. */

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on anything that is not unpadded base64url, so a malformed field never decodes to something else. */
export function base64UrlToBytes(value: string): Uint8Array {
	if (!BASE64URL.test(value) || value.length % 4 === 1) throw new TypeError("Invalid base64url value");
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** Compares without exiting early, for challenges and other values an attacker may probe. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	let difference = left.length ^ right.length;
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}
