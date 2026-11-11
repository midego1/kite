import { decodeCbor, type CborValue } from "./cbor-utils";
import { bytesToBase64Url } from "./base64url-utils";

/**
 * COSE public keys (RFC 9052/9053) as authenticators return them, turned into Web Crypto keys. Three algorithms
 * are accepted: ES256 (ECDSA P-256 with SHA-256), RS256 (RSASSA-PKCS1-v1_5 with SHA-256, at least 2048 bits) and
 * EdDSA (Ed25519). Web Crypto runs the same on Workers and Node, so no dependency is needed.
 */

const COSE_ALG_ES256 = -7;
const COSE_ALG_RS256 = -257;
const COSE_ALG_EDDSA = -8;
export const SUPPORTED_COSE_ALGORITHMS = [COSE_ALG_ES256, COSE_ALG_EDDSA, COSE_ALG_RS256] as const;

const KTY_OKP = 1;
const KTY_EC2 = 2;
const KTY_RSA = 3;
const CRV_P256 = 1;
const CRV_ED25519 = 6;
const MIN_RSA_BITS = 2048;

export class CoseKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoseKeyError";
	}
}

type ParsedCoseKey =
	| { algorithm: typeof COSE_ALG_ES256; jwk: JsonWebKey }
	| { algorithm: typeof COSE_ALG_RS256; jwk: JsonWebKey }
	| { algorithm: typeof COSE_ALG_EDDSA; jwk: JsonWebKey };

function bytesField(map: Map<number | string, CborValue>, label: number, length?: number): Uint8Array {
	const value = map.get(label);
	if (!(value instanceof Uint8Array)) throw new CoseKeyError(`COSE key parameter ${label} is missing`);
	if (length !== undefined && value.length !== length)
		throw new CoseKeyError(`COSE key parameter ${label} has the wrong length`);
	return value;
}

/** Validates the COSE key's shape and returns its algorithm and JWK; throws on anything unsupported. */
function parseCoseKey(input: Uint8Array | CborValue): ParsedCoseKey {
	const map = input instanceof Uint8Array ? decodeCbor(input) : input;
	if (!(map instanceof Map)) throw new CoseKeyError("COSE key is not a map");
	const kty = map.get(1);
	const alg = map.get(3);
	if (kty === KTY_EC2 && alg === COSE_ALG_ES256) {
		if (map.get(-1) !== CRV_P256) throw new CoseKeyError("Only the P-256 curve is accepted for ES256");
		return {
			algorithm: COSE_ALG_ES256,
			jwk: {
				kty: "EC",
				crv: "P-256",
				x: bytesToBase64Url(bytesField(map, -2, 32)),
				y: bytesToBase64Url(bytesField(map, -3, 32)),
				ext: true,
			},
		};
	}
	if (kty === KTY_RSA && alg === COSE_ALG_RS256) {
		const modulus = bytesField(map, -1);
		const exponent = bytesField(map, -2);
		const start = modulus.findIndex((byte) => byte !== 0);
		const bits = start < 0 ? 0 : (modulus.length - start - 1) * 8 + (32 - Math.clz32(modulus[start]));
		if (bits < MIN_RSA_BITS) throw new CoseKeyError("RSA keys must have at least 2048 bits");
		// An odd public exponent of at least 3 (65537 in practice); 1 or an even one makes the key useless or weak.
		const e = exponent.reduce((value, byte) => value * 256 + byte, 0);
		if (exponent.length === 0 || exponent.length > 4 || e < 3 || e % 2 === 0)
			throw new CoseKeyError("Invalid RSA exponent");
		return {
			algorithm: COSE_ALG_RS256,
			jwk: { kty: "RSA", n: bytesToBase64Url(modulus), e: bytesToBase64Url(exponent), alg: "RS256", ext: true },
		};
	}
	if (kty === KTY_OKP && alg === COSE_ALG_EDDSA) {
		if (map.get(-1) !== CRV_ED25519) throw new CoseKeyError("Only Ed25519 is accepted for EdDSA");
		return {
			algorithm: COSE_ALG_EDDSA,
			jwk: { kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(bytesField(map, -2, 32)), ext: true },
		};
	}
	throw new CoseKeyError("Unsupported key type or algorithm");
}

async function importVerifyKey(
	key: ParsedCoseKey,
): Promise<{ cryptoKey: CryptoKey; params: AlgorithmIdentifier | EcdsaParams }> {
	if (key.algorithm === COSE_ALG_ES256) {
		const cryptoKey = await crypto.subtle.importKey("jwk", key.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
			"verify",
		]);
		return { cryptoKey, params: { name: "ECDSA", hash: "SHA-256" } };
	}
	if (key.algorithm === COSE_ALG_RS256) {
		const cryptoKey = await crypto.subtle.importKey(
			"jwk",
			key.jwk,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		return { cryptoKey, params: { name: "RSASSA-PKCS1-v1_5" } };
	}
	const cryptoKey = await crypto.subtle.importKey("jwk", key.jwk, { name: "Ed25519" }, false, ["verify"]);
	return { cryptoKey, params: { name: "Ed25519" } };
}

/**
 * WebAuthn ECDSA signatures are ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }`; Web Crypto wants the fixed-size
 * `r || s`. Anything that is not exactly that structure is refused.
 */
function derEcdsaSignatureToRaw(der: Uint8Array, size = 32): Uint8Array {
	let offset = 0;
	const fail = () => {
		throw new CoseKeyError("Malformed ECDSA signature");
	};
	if (der[offset++] !== 0x30) fail();
	const sequenceLength = der[offset++];
	if (sequenceLength === undefined || sequenceLength > 0x7f || offset + sequenceLength !== der.length) fail();
	const readInteger = () => {
		if (der[offset++] !== 0x02) fail();
		const length = der[offset++];
		if (length === undefined || length === 0 || length > size + 1 || offset + length > der.length) fail();
		let value = der.subarray(offset, offset + length);
		offset += length;
		while (value.length > 0 && value[0] === 0) value = value.subarray(1);
		if (value.length > size) fail();
		const padded = new Uint8Array(size);
		padded.set(value, size - value.length);
		return padded;
	};
	const r = readInteger();
	const s = readInteger();
	if (offset !== der.length) fail();
	const raw = new Uint8Array(size * 2);
	raw.set(r, 0);
	raw.set(s, size);
	return raw;
}

/** Verifies `signature` over `data` with a stored COSE key; false for a bad signature, throws for a bad key. */
export async function verifyCoseSignature(
	coseKey: Uint8Array,
	signature: Uint8Array,
	data: Uint8Array,
): Promise<boolean> {
	const key = parseCoseKey(coseKey);
	const { cryptoKey, params } = await importVerifyKey(key);
	let rawSignature: Uint8Array = signature;
	if (key.algorithm === COSE_ALG_ES256) {
		try {
			rawSignature = derEcdsaSignatureToRaw(signature);
		} catch {
			return false;
		}
	}
	return crypto.subtle.verify(params, cryptoKey, rawSignature as BufferSource, data as BufferSource);
}

/** Proves at registration that Web Crypto here can use the key, so a passkey is never saved that cannot sign in. */
export async function assertUsableCoseKey(coseKey: Uint8Array | CborValue): Promise<ParsedCoseKey> {
	const key = parseCoseKey(coseKey);
	try {
		await importVerifyKey(key);
	} catch {
		throw new CoseKeyError("This server cannot use the passkey's key");
	}
	return key;
}
