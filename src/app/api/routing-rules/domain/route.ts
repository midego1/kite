import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { routingRules } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { domainRoutingRuleSchema } from "@/lib/validators";
import {
	assertAdminRuleMailbox,
	DOMAIN_RULES_ADMIN_ONLY,
	getAdminDomain,
	listAdminDomainMailboxes,
	listAdminRoutingDomains,
	listDomainRules,
	toRuleColumns,
} from "@/lib/domains/routing-rules";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const searchParams = new URL(request.url).searchParams;
	const db = getDb(env);
	if (searchParams.get("list") === "true") {
		const domains = await listAdminRoutingDomains(db, auth.user);
		if (!domains) return NextResponse.json({ error: DOMAIN_RULES_ADMIN_ONLY }, { status: 403 });
		return NextResponse.json({ domains });
	}
	const domainId = searchParams.get("domainId");
	if (!domainId) {
		return NextResponse.json({ error: "domainId is required" }, { status: 400 });
	}

	if (!(await getAdminDomain(db, auth.user, domainId))) {
		return NextResponse.json({ error: DOMAIN_RULES_ADMIN_ONLY }, { status: 403 });
	}

	return NextResponse.json({
		rules: await listDomainRules(db, domainId),
		mailboxes: await listAdminDomainMailboxes(db, domainId),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const user = auth.user;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = domainRoutingRuleSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	if (!(await getAdminDomain(db, user, parsed.data.domainId))) {
		return NextResponse.json({ error: DOMAIN_RULES_ADMIN_ONLY }, { status: 403 });
	}
	if (parsed.data.mailboxId && !(await assertAdminRuleMailbox(db, parsed.data.mailboxId, parsed.data.domainId))) {
		return NextResponse.json({ error: "The destination mailbox is not on this domain" }, { status: 403 });
	}

	const id = newId("rule");
	await db.insert(routingRules).values({
		id,
		userId: user.id,
		domainId: parsed.data.domainId,
		...toRuleColumns(parsed.data),
	});

	return NextResponse.json({ id });
}
