import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { API_KEY_MAX_MAILBOXES } from "@/lib/api/scopes";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { readAuthorization } from "@/lib/mcp/oauth/consent";
import { createAuthorizationCode } from "@/lib/mcp/oauth/service";
import { isMcpOAuthPending } from "@/lib/mcp/oauth/store";
import {
	authorizationRedirect,
	defaultCheckedScopes,
	oauthIssuer,
	redirectUriHost,
	type AuthorizationCheck,
} from "@/lib/mcp/oauth/utils";
import { availableKeyScopes, keyScopesNeedMailbox, refuseDisabledKeyScopes } from "@/lib/modules/key-scopes";

const log = createLogger("mcp.oauth");

const decisionSchema = z.object({
	/** The authorization request's own parameters, exactly as the consent page received them. */
	params: z.record(z.string(), z.string().max(2048)),
	decision: z.enum(["allow", "deny"]),
	scopes: z.array(z.string().max(100)).max(50).default([]),
	mailboxIds: z.array(z.string().min(1).max(100)).max(API_KEY_MAX_MAILBOXES).default([]),
});

const pending = () =>
	NextResponse.json({ error: "Apply the pending database update first", code: "MIGRATION_PENDING" }, { status: 409 });

/**
 * The error a check sends back to the client, or a 400 shown in Kite when there is nowhere safe to send it. The
 * consent screen shows the error with a link back instead of following it, so an invalid request from any registered
 * client never turns Kite into an open redirector (RFC 9700 §4.11.2).
 */
function refusal(check: Exclude<AuthorizationCheck, { kind: "ok" }>, issuer: string) {
	if (check.kind === "fatal") return NextResponse.json({ error: check.message }, { status: 400 });
	return NextResponse.json({
		redirectTo: authorizationRedirect(check.redirectUri, {
			error: check.error,
			error_description: check.description,
			state: check.state,
			iss: issuer,
		}),
		description: check.description,
		redirectHost: redirectUriHost(check.redirectUri),
	});
}

/**
 * What the consent screen shows for an authorization request: the app's self-chosen name, where it returns to, the
 * permissions on offer (only reading ticked) and the user's mailboxes. A request that cannot go on answers either a
 * message to show or the URL that tells the client why.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const issuer = oauthIssuer(env.APP_URL, request.url);
	try {
		const { check, client } = await readAuthorization(env, new URL(request.url).searchParams, issuer);
		if (check.kind !== "ok") return refusal(check, issuer);
		const scopes = await availableKeyScopes(env, user, "mcp", check.request.scopes);
		const mailboxes = await listAccessibleMailboxes(getDb(env), user);
		return NextResponse.json({
			client: { name: client!.name, redirectHost: redirectUriHost(check.request.redirectUri) },
			scopes,
			checked: defaultCheckedScopes(scopes),
			mailboxes: mailboxes
				.filter((mailbox) => !mailbox.disabled)
				.map((mailbox) => ({ id: mailbox.id, address: `${mailbox.localPart}@${mailbox.hostname}` })),
		});
	} catch (cause) {
		if (isMcpOAuthPending(cause)) return pending();
		throw cause;
	}
}

/**
 * The signed-in user's answer on the consent screen. The request is validated again here, so the page's copy cannot
 * widen it: the scopes must be among those on offer and the mailboxes readable by the user. The answer is the URL the
 * browser goes back to, with a single-use code or `access_denied`.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	const { params, decision } = parsed.data;
	const issuer = oauthIssuer(env.APP_URL, request.url);
	try {
		const { check } = await readAuthorization(env, { get: (name) => params[name] ?? null }, issuer);
		if (check.kind !== "ok") return refusal(check, issuer);
		const { request: authorization } = check;
		const back = (values: Record<string, string>) =>
			NextResponse.json({
				redirectTo: authorizationRedirect(authorization.redirectUri, {
					...values,
					state: authorization.state,
					iss: issuer,
				}),
			});
		if (decision === "deny") return back({ error: "access_denied", error_description: "The user declined" });
		const scopes = [...new Set(parsed.data.scopes)];
		if (!scopes.length || scopes.some((scope) => !authorization.scopes.includes(scope)))
			return NextResponse.json({ error: "Choose at least one of the permissions on offer" }, { status: 400 });
		const disabled = await refuseDisabledKeyScopes(env, user, "mcp", scopes);
		if (disabled) return disabled;
		const mailboxIds = [...new Set(parsed.data.mailboxIds)];
		if (!mailboxIds.length && keyScopesNeedMailbox("mcp", scopes))
			return NextResponse.json({ error: "Choose a mailbox for mail permissions" }, { status: 400 });
		const db = getDb(env);
		for (const mailboxId of mailboxIds)
			if (!(await getMailboxAccessLevel(db, user, mailboxId))?.canRead)
				return NextResponse.json({ error: "Mailbox not found" }, { status: 403 });
		const code = await createAuthorizationCode(
			env,
			{
				clientId: authorization.clientId,
				userId: user.id,
				redirectUri: authorization.redirectUri,
				codeChallenge: authorization.codeChallenge,
				resource: authorization.resource,
				scopes,
				mailboxIds,
			},
			new Date(),
		);
		return back({ code });
	} catch (cause) {
		if (isMcpOAuthPending(cause)) return pending();
		log.error("mcp.oauth.consent_failed", { error: cause instanceof Error ? cause.name : "unknown" });
		return NextResponse.json({ error: "Could not complete the sign-in" }, { status: 500 });
	}
}
