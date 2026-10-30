import type { S3Provider } from "./types";

export type CredentialField = "accessKeyId" | "secretAccessKey";

const MAX_CREDENTIAL_LENGTH = 256;

const NAMES: Record<CredentialField, string> = { accessKeyId: "access key ID", secretAccessKey: "secret access key" };

/** R2 S3 keys: the access key ID is the token id (32 hex), the secret its SHA-256 (64 hex). */
const R2_SHAPE: Record<CredentialField, { plural: string; length: number; pattern: RegExp }> = {
	accessKeyId: { plural: "access key IDs", length: 32, pattern: /^[0-9a-f]{32}$/i },
	secretAccessKey: { plural: "secret access keys", length: 64, pattern: /^[0-9a-f]{64}$/i },
};

/**
 * What is wrong with one typed key, naming the field and how to fix it; null when it looks right. `shape` also
 * checks R2's fixed length and alphabet, which the form does as a hint; the server leaves that to the store.
 */
export function credentialProblem(
	field: CredentialField,
	value: string,
	provider: S3Provider | string,
	{ shape = false }: { shape?: boolean } = {},
): string | null {
	const name = NAMES[field];
	if (!value) return `Enter the ${name}`;
	if (/\s/.test(value)) return `The ${name} contains a space or line break; paste only the key itself`;
	const r2 = provider === "r2" ? R2_SHAPE[field] : null;
	if (value.length > MAX_CREDENTIAL_LENGTH)
		return `The ${name} is too long (${value.length} characters)${r2 ? `; R2 ${r2.plural} are ${r2.length} characters` : ""}. Paste only the key itself`;
	if (shape && r2 && !r2.pattern.test(value))
		return value.length === r2.length
			? `R2 ${r2.plural} use only digits and the letters a to f; check that this is the ${name}`
			: `R2 ${r2.plural} are ${r2.length} characters; this one has ${value.length}. Check that you copied the ${name}`;
	return null;
}
