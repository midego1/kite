import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

/**
 * A stand-in for Google's sign-in (`/google/o/oauth2/v2/auth`) and token (`/google/token`) endpoints under
 * `EXTERNAL_OAUTH_TEST_ORIGIN` (spec §14.3, §15.7). The authorize page consents at once and redirects back with a code
 * (or `error=access_denied` after `denyNext()`); the token endpoint checks the client, the code, the PKCE verifier and
 * the redirect URI, issues an access token, a refresh token (Google does not rotate it on refresh) and an unsigned ID
 * token, and answers `invalid_grant` for a revoked or unknown one. Every access token it issues is passed to
 * `onAccessToken`, so the fake IMAP and SMTP servers accept it. Never point it at, or copy it from, Google.
 *
 * Options: `port` (default any free one), `clientId`, `clientSecret`, `account` (`{ address, sub, hd?,
 * emailVerified? }`, who signs in), `expiresIn` (seconds), `scope` (granted scopes), `omitRefreshToken`,
 * `idTokenClaims(claims)` (changes the ID token's claims before it is issued), `onAccessToken(address, token)`.
 */
export async function startFakeGoogleOAuth(options = {}) {
	const clientId = options.clientId ?? "123456789012-kitefakeclient0000000000000000.apps.googleusercontent.com";
	const clientSecret = options.clientSecret ?? "GOCSPX-fake-client-secret";
	let account = options.account ?? { address: "someone@gmail.com", sub: "110000000000000000001" };
	let idTokenClaims = options.idTokenClaims ?? ((claims) => claims);
	let scope = options.scope ?? "https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email";
	let omitRefreshToken = !!options.omitRefreshToken;
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
	const idToken = (who) => {
		const now = Math.floor(Date.now() / 1000);
		const claims = idTokenClaims({
			iss: "https://accounts.google.com",
			azp: clientId,
			aud: clientId,
			sub: who.sub,
			email: who.address,
			email_verified: who.emailVerified ?? true,
			...(who.hd ? { hd: who.hd } : {}),
			iat: now,
			exp: now + 3600,
		});
		return `${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(JSON.stringify(claims))}.`;
	};
	const issue = (who, firstSignIn) => {
		const accessToken = `ya29.${randomBytes(12).toString("hex")}`;
		options.onAccessToken?.(who.address, accessToken);
		const answer = {
			token_type: "Bearer",
			scope,
			expires_in: options.expiresIn ?? 3599,
			access_token: accessToken,
		};
		if (!firstSignIn) return answer;
		const refreshToken = `1//${randomBytes(12).toString("hex")}`;
		refreshTokens.set(refreshToken, who);
		return { ...answer, ...(omitRefreshToken ? {} : { refresh_token: refreshToken }), id_token: idToken(who) };
	};

	const readBody = (request) =>
		new Promise((resolve) => {
			const chunks = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
		});

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://fake");
		if (url.pathname === "/google/o/oauth2/v2/auth") {
			requests.push({ kind: "authorize", params: Object.fromEntries(url.searchParams) });
			const redirect = new URL(url.searchParams.get("redirect_uri") ?? "http://invalid/");
			redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
			if (deny) {
				redirect.searchParams.set("error", deny);
				deny = null;
			} else {
				const code = `4/${randomBytes(12).toString("hex")}`;
				codes.set(code, {
					challenge: url.searchParams.get("code_challenge"),
					method: url.searchParams.get("code_challenge_method"),
					redirectUri: url.searchParams.get("redirect_uri"),
					clientId: url.searchParams.get("client_id"),
					who: account,
				});
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("scope", scope);
				redirect.searchParams.set("authuser", "0");
				redirect.searchParams.set("prompt", "consent");
			}
			response.writeHead(302, { Location: redirect.toString() });
			return response.end();
		}
		if (url.pathname !== "/google/token") return json(response, 404, { error: "not_found" });
		const body = await readBody(request);
		const grant = body.get("grant_type");
		requests.push({ kind: "token", grant, scope: body.get("scope") });
		if (failTokenWith) {
			const failure = failTokenWith;
			failTokenWith = null;
			return json(response, failure.status, failure.body);
		}
		if (body.get("client_id") !== clientId)
			return json(response, 401, { error: "invalid_client", error_description: "The OAuth client was not found." });
		if (body.get("client_secret") !== clientSecret)
			return json(response, 401, { error: "invalid_client", error_description: "Unauthorized" });
		if (grant === "authorization_code") {
			const entry = codes.get(body.get("code") ?? "");
			codes.delete(body.get("code") ?? "");
			const verifier = body.get("code_verifier") ?? "";
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (!entry) return json(response, 400, { error: "invalid_grant", error_description: "Malformed auth code." });
			if (
				entry.method !== "S256" ||
				entry.challenge !== challenge ||
				entry.redirectUri !== body.get("redirect_uri") ||
				entry.clientId !== clientId
			)
				return json(response, 400, { error: "invalid_grant", error_description: "Bad Request" });
			return json(response, 200, issue(entry.who, true));
		}
		if (grant === "refresh_token") {
			const who = refreshTokens.get(body.get("refresh_token") ?? "");
			if (!who)
				return json(response, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
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
		/** Changes the claims of the ID tokens issued from now on (a wrong issuer or audience). */
		setIdTokenClaims(change) {
			idTokenClaims = change;
		},
		/** The scopes granted from now on (the user unticked Gmail on the consent screen). */
		setScope(next) {
			scope = next;
		},
		/** Whether the next code redemptions leave out the refresh token. */
		setOmitRefreshToken(value) {
			omitRefreshToken = value;
		},
		/** The next authorize answers this error instead of a code. */
		denyNext(error = "access_denied") {
			deny = error;
		},
		/** The next token request gets this answer. */
		failNextToken(status, body) {
			failTokenWith = { status, body };
		},
		/** Revokes every refresh token issued so far (the user removed Kite at myaccount.google.com/permissions). */
		revokeAll() {
			refreshTokens.clear();
		},
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
