import type { ContentSecurityPolicyOptions } from "./headers-types";

/**
 * Pages get a per-request nonce from the entrypoint (worker.ts, server/index.ts),
 * so production allows no other inline script. Development keeps 'unsafe-inline'
 * and 'unsafe-eval' for Vite's injected preamble and React's dev tooling; a nonce
 * would make browsers ignore 'unsafe-inline'. `style-src` keeps 'unsafe-inline'
 * because React style attributes and sanitized email styles need it.
 */
export function buildContentSecurityPolicy({
	nonce,
	dev = false,
	connectSources = [],
}: ContentSecurityPolicyOptions = {}): string {
	const scriptSources = ["'self'", "https://challenges.cloudflare.com"];
	const connect = [
		"'self'",
		"ws:",
		"wss:",
		"https://challenges.cloudflare.com",
		...connectSources.filter(isExactOrigin),
	];
	if (dev) scriptSources.push("'unsafe-inline'", "'unsafe-eval'");
	else if (nonce) scriptSources.push(`'nonce-${nonce}'`);
	return [
		"default-src 'self'",
		`script-src ${scriptSources.join(" ")}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https:",
		"font-src 'self' data:",
		`connect-src ${[...new Set(connect)].join(" ")}`,
		"frame-src 'self' https://challenges.cloudflare.com",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		// 'self' rather than 'none': the attachment viewer frames same-origin previews.
		"frame-ancestors 'self'",
		"upgrade-insecure-requests",
	].join("; ");
}

/** `https://host[:port]` or `http://host[:port]` and nothing else, so a stored value cannot inject a directive. */
function isExactOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value && !value.includes("*");
	} catch {
		return false;
	}
}

export function createCspNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * `Cross-Origin-Opener-Policy` for documents (upstream Mailflare #221): a page Kite opens, or one that opens Kite, gets
 * no `window.opener` reference into it. Kite opens links with `noopener` and has no popup flow that needs one.
 */
export const DOCUMENT_OPENER_POLICY = "same-origin";

/** Paths whose responses are documents that need the nonce policy (everything but APIs). */
export function isDocumentPath(pathname: string): boolean {
	return !(
		pathname === "/api" ||
		pathname.startsWith("/api/") ||
		pathname.startsWith("/_next/") ||
		pathname === "/mcp" ||
		pathname.startsWith("/jmap") ||
		pathname.startsWith("/.well-known/")
	);
}

export function getSecurityHeaders() {
	return [
		{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
		{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
		{ key: "X-Content-Type-Options", value: "nosniff" },
		{ key: "X-Frame-Options", value: "SAMEORIGIN" },
		{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
		{
			key: "Permissions-Policy",
			value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
		},
	];
}

/** Static policy for non-document responses; they run no scripts, so no nonce is needed. */
export function getApiSecurityHeaders() {
	return [{ key: "Content-Security-Policy", value: buildContentSecurityPolicy() }];
}
