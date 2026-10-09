import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { routingRules } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { domainRoutingRuleSchema } from "@/lib/validators";
import {
	assertAdminRuleMailbox,
	DOMAIN_RULES_ADMIN_ONLY,
	getAdminDomain,
	toRuleColumns,
} from "@/lib/domains/routing-rules";
import type { DomainRoutingRuleRouteParams } from "./types";

/** Loads a domain-scope rule on a domain the caller administers. */
async function loadRule(request: Request, id: string) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { error: auth.error } as const;
	const db = getDb(env);
	const [rule] = await db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.id, id), eq(routingRules.scope, "domain")))
		.limit(1);
	if (!rule) {
		return { error: NextResponse.json({ error: "Rule not found" }, { status: 404 }) } as const;
	}
	if (!(await getAdminDomain(db, auth.user, rule.domainId))) {
		return { error: NextResponse.json({ error: DOMAIN_RULES_ADMIN_ONLY }, { status: 403 }) } as const;
	}

	return { db, rule, error: null } as const;
}

export async function PATCH(request: Request, { params }: DomainRoutingRuleRouteParams) {
	const { id } = await params;
	const loaded = await loadRule(request, id);
	if (loaded.error) return loaded.error;

	const body = (await request.json()) as Record<string, unknown>;
	// The rule's own domain always wins, so a request cannot move a rule to another domain.
	const parsed = domainRoutingRuleSchema.safeParse({ ...body, domainId: loaded.rule.domainId });
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}
	if (
		parsed.data.mailboxId &&
		!(await assertAdminRuleMailbox(loaded.db, parsed.data.mailboxId, loaded.rule.domainId))
	) {
		return NextResponse.json({ error: "The destination mailbox is not on this domain" }, { status: 403 });
	}

	await loaded.db.update(routingRules).set(toRuleColumns(parsed.data)).where(eq(routingRules.id, id));
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: DomainRoutingRuleRouteParams) {
	const { id } = await params;
	const loaded = await loadRule(request, id);
	if (loaded.error) return loaded.error;

	await loaded.db.delete(routingRules).where(eq(routingRules.id, id));
	return NextResponse.json({ ok: true });
}
