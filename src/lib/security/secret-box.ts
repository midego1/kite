/**
 * AES-256-GCM for provider secrets kept in the database (app_settings). The key
 * is derived with HKDF from APP_ENCRYPTION_KEY. Values without the prefix are
 * legacy plaintext and are returned as they are, so turning encryption on never
 * breaks a stored value; they are encrypted the next time they are saved.
 */

export const SEALED_PREFIX = "enc:v1:";
// Part of the key derivation: changing it, even for the rename to Kite, makes every stored secret unreadable.
const HKDF_INFO = "mailflare app_settings secrets v1";

export class SecretBoxError extends Error {}

const keyCache = new Map<string, Promise<CryptoKey>>();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function deriveKey(secret: string): Promise<CryptoKey> {
	let key = keyCache.get(secret);
	if (!key) {
		key = crypto.subtle
			.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"])
			.then((material) =>
				crypto.subtle.deriveKey(
					{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(HKDF_INFO) },
					material,
					{ name: "AES-GCM", length: 256 },
					false,
					["encrypt", "decrypt"],
				),
			);
		keyCache.set(secret, key);
	}
	return key;
}

export function isSealed(value: string | null | undefined): boolean {
	return !!value?.startsWith(SEALED_PREFIX);
}

function usableKey(secret: string | null | undefined): string | null {
	const trimmed = secret?.trim();
	return trimmed ? trimmed : null;
}

/** Encrypts `plaintext` when a key is configured; without one the value is stored as is. */
export async function sealSecret(secret: string | null | undefined, plaintext: string): Promise<string> {
	const keySecret = usableKey(secret);
	if (!keySecret || isSealed(plaintext)) return plaintext;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(keySecret);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
	);
	return `${SEALED_PREFIX}${toBase64Url(iv)}:${toBase64Url(ciphertext)}`;
}

/** Decrypts a sealed value; legacy plaintext passes through unchanged. */
export async function openSecret(secret: string | null | undefined, stored: string): Promise<string> {
	if (!isSealed(stored)) return stored;
	const keySecret = usableKey(secret);
	if (!keySecret) throw new SecretBoxError("A stored secret is encrypted but APP_ENCRYPTION_KEY is not set");
	const [ivPart, dataPart] = stored.slice(SEALED_PREFIX.length).split(":");
	if (!ivPart || !dataPart) throw new SecretBoxError("A stored secret is malformed");
	try {
		const key = await deriveKey(keySecret);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: fromBase64Url(ivPart) as BufferSource },
			key,
			fromBase64Url(dataPart) as BufferSource,
		);
		return new TextDecoder().decode(plaintext);
	} catch {
		throw new SecretBoxError("A stored secret could not be decrypted; APP_ENCRYPTION_KEY may have changed");
	}
}

export async function sealSetting<T extends string | null>(
	env: Pick<CloudflareEnv, "APP_ENCRYPTION_KEY">,
	value: T,
): Promise<T> {
	return (value === null ? null : await sealSecret(env.APP_ENCRYPTION_KEY, value)) as T;
}

export async function openSetting(
	env: Pick<CloudflareEnv, "APP_ENCRYPTION_KEY">,
	value: string | null | undefined,
): Promise<string | null> {
	return value == null ? null : openSecret(env.APP_ENCRYPTION_KEY, value);
}
