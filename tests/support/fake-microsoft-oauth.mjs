import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

/**
 * A stand-in for Microsoft's sign-in (`/{tenant}/oauth2/v2.0/authorize`) and token (`/{tenant}/oauth2/v2.0/token`)
 * endpoints, for `EXTERNAL_OAUTH_TEST_ORIGIN` (spec §14.3). The authorize page consents at once and redirects back
 * with a code (or `error=access_denied` after `denyNext()`); the token endpoint checks the client, the code, the PKCE
 * verifier and the redirect URI, issues an access token, a rotating refresh token and an unsigned ID token, and
 * answers `invalid_grant` for a revoked or unknown one. Every access token it issues is passed to `onAccessToken`, so
 * the fake IMAP and SMTP servers accept it. Never point it at, or copy it from, Microsoft.
 *
 * Options: `port` (default any free one), `clientId`, `clientSecret`, `account` (`{ address, oid, tid? }`, who signs in), `expiresIn` (seconds),
 * `scope` (granted scopes), `omitRefreshToken`, `onAccessToken(address, token)`.
 */
/** The tenant the fake's accounts belong to unless an account names another (`tid`). */
const TENANT_ID = "7f3c1a2b-0000-4000-8000-00000000fa4e";

export async function startFakeMicrosoftOAuth(options = {}) {
	const clientId = options.clientId ?? "11111111-2222-3333-4444-555555555555";
	const clientSecret = options.clientSecret ?? "fake-client-secret~value";
	let account = options.account ?? { address: "someone@outlook.test", oid: "00000000-0000-0000-0000-0000000000aa" };
	const codes = new Map();
	const refreshTokens = new Map();
	const requests = [];
	let deny = null;
	let failTokenWith = null;

	const json = (response, status, body) => {
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(JSON.stringify(body));
	};
	const base64Url = (value) => Buffer.from(value).toString("base64url");
	const idToken = (who) =>
		`${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(
			JSON.stringify({
				aud: clientId,
				iss: `https://login.microsoftonline.com/${who.tid ?? TENANT_ID}/v2.0`,
				tid: who.tid ?? TENANT_ID,
				preferred_username: who.address,
				oid: who.oid,
			}),
		)}.`;
	const issue = (who, withIdToken) => {
		const accessToken = `at-${randomBytes(12).toString("hex")}`;
		const refreshToken = `rt-${randomBytes(12).toString("hex")}`;
		refreshTokens.set(refreshToken, who);
		options.onAccessToken?.(who.address, accessToken);
		return {
			token_type: "Bearer",
			scope:
				options.scope ??
				"https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send openid email",
			expires_in: options.expiresIn ?? 3600,
			access_token: accessToken,
			...(options.omitRefreshToken ? {} : { refresh_token: refreshToken }),
			...(withIdToken ? { id_token: idToken(who) } : {}),
		};
	};

	const readBody = (request) =>
		new Promise((resolve) => {
			const chunks = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
		});

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://fake");
		const path = /^\/([^/]+)\/oauth2\/v2\.0\/(authorize|token)$/.exec(url.pathname);
		if (!path) return json(response, 404, { error: "not_found" });
		if (path[2] === "authorize") {
			requests.push({ kind: "authorize", tenant: path[1], params: Object.fromEntries(url.searchParams) });
			const redirect = new URL(url.searchParams.get("redirect_uri") ?? "http://invalid/");
			redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
			if (deny) {
				redirect.searchParams.set("error", deny.error);
				redirect.searchParams.set("error_description", deny.description);
				deny = null;
			} else {
				const code = `code-${randomBytes(12).toString("hex")}`;
				codes.set(code, {
					challenge: url.searchParams.get("code_challenge"),
					method: url.searchParams.get("code_challenge_method"),
					redirectUri: url.searchParams.get("redirect_uri"),
					clientId: url.searchParams.get("client_id"),
					who: account,
				});
				redirect.searchParams.set("code", code);
			}
			response.writeHead(302, { Location: redirect.toString() });
			return response.end();
		}
		const body = await readBody(request);
		const grant = body.get("grant_type");
		requests.push({ kind: "token", tenant: path[1], grant });
		if (failTokenWith) {
			const failure = failTokenWith;
			failTokenWith = null;
			return json(response, failure.status, failure.body);
		}
		if (body.get("client_id") !== clientId)
			return json(response, 400, {
				error: "unauthorized_client",
				error_description: "AADSTS700016: Application not found in the directory.",
			});
		if (body.get("client_secret") !== clientSecret)
			return json(response, 401, {
				error: "invalid_client",
				error_description: "AADSTS7000215: Invalid client secret provided.",
			});
		if (grant === "authorization_code") {
			const entry = codes.get(body.get("code") ?? "");
			codes.delete(body.get("code") ?? "");
			const verifier = body.get("code_verifier") ?? "";
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (
				!entry ||
				entry.method !== "S256" ||
				entry.challenge !== challenge ||
				entry.redirectUri !== body.get("redirect_uri") ||
				entry.clientId !== clientId
			)
				return json(response, 400, {
					error: "invalid_grant",
					error_description: "AADSTS9002313: Invalid request. Request is malformed or invalid.",
				});
			return json(response, 200, issue(entry.who, true));
		}
		if (grant === "refresh_token") {
			const who = refreshTokens.get(body.get("refresh_token") ?? "");
			// Microsoft rotates refresh tokens; the old one keeps working until it expires, unless revoked.
			if (!who)
				return json(response, 400, {
					error: "invalid_grant",
					error_description: "AADSTS70008: The provided authorization code or refresh token has expired.",
				});
			return json(response, 200, issue(who, false));
		}
		return json(response, 400, { error: "unsupported_grant_type" });
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	return {
		port,
		origin: `http://127.0.0.1:${port}`,
		clientId,
		clientSecret,
		requests,
		/** Who signs in at the next authorize. */
		setAccount(next) {
			account = next;
		},
		/** The next authorize answers this error instead of a code. */
		denyNext(error = "access_denied", description = "AADSTS65004: User declined to consent to access the app.") {
			deny = { error, description };
		},
		/** The next token request gets this answer. */
		failNextToken(status, body) {
			failTokenWith = { status, body };
		},
		/** Revokes every refresh token issued so far (a password change or a revoked consent). */
		revokeAll() {
			refreshTokens.clear();
		},
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
