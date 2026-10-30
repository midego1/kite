import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { spamPolicySettings } from "@/db/schema/spam-policy";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { queryDns } from "@/lib/dns-query";
import { createLogger } from "@/lib/logger.mjs";
import { dmarcRecordNames, parseDmarcRecord } from "./dmarc-policy-utils";
import type { DmarcPolicy, DmarcPolicySource } from "./types";

/** A DMARC lookup that takes longer is given up as `unknown`, so it never holds up delivery for long. */
const DMARC_LOOKUP_TIMEOUT_MS = 3000;
const FOUND_TTL_MS = 60 * 60_000;
const UNKNOWN_TTL_MS = 5 * 60_000;
const MAX_CACHED_DOMAINS = 500;

type ResolveTxt = (name: string) => Promise<string[]>;
/** `timeoutMs` and the clock `now` are for tests. */
type LookupOptions = { timeoutMs?: number; now?: () => number };

const logger = createLogger("spam");
const cache = new Map<string, { policy: DmarcPolicy; expiresAt: number }>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("DMARC lookup timed out")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

async function lookup(domain: string, resolveTxt: ResolveTxt): Promise<DmarcPolicy> {
	for (const { name, inherited } of dmarcRecordNames(domain)) {
		const policy = parseDmarcRecord(await resolveTxt(name), inherited);
		if (policy) return policy;
	}
	return "unknown";
}

/**
 * The DMARC policy `domain` publishes, read from DNS when the verifying hop's `Authentication-Results` did not carry
 * it. Answers are cached per isolate (an hour; five minutes for `unknown`), and a lookup that fails or takes longer
 * than `DMARC_LOOKUP_TIMEOUT_MS` gives `unknown`, which enforces nothing.
 */
async function lookupPublishedDmarcPolicy(
	domain: string,
	resolveTxt: ResolveTxt,
	options: LookupOptions,
): Promise<DmarcPolicy> {
	const key = domain.trim().toLowerCase();
	const now = options.now?.() ?? Date.now();
	const cached = cache.get(key);
	if (cached && cached.expiresAt > now) return cached.policy;
	let policy: DmarcPolicy;
	try {
		policy = await withTimeout(lookup(key, resolveTxt), options.timeoutMs ?? DMARC_LOOKUP_TIMEOUT_MS);
	} catch (error) {
		logger.warn("spam.dmarc_lookup_failed", { error });
		policy = "unknown";
	}
	if (cache.size >= MAX_CACHED_DOMAINS) cache.delete(cache.keys().next().value as string);
	cache.set(key, { policy, expiresAt: now + (policy === "unknown" ? UNKNOWN_TTL_MS : FOUND_TTL_MS) });
	return policy;
}

/** **Treat every DMARC failure as spam** (Admin → General); off before migration 0084 is applied. */
export async function readStrictDmarc(env: Pick<CloudflareEnv, "DB">): Promise<{
	strictDmarc: boolean;
	migrationPending: boolean;
}> {
	try {
		const [row] = await getDb(env)
			.select({ strictDmarc: spamPolicySettings.strictDmarc })
			.from(spamPolicySettings)
			.where(eq(spamPolicySettings.id, "default"))
			.limit(1);
		return { strictDmarc: row?.strictDmarc ?? false, migrationPending: false };
	} catch (error) {
		if (!missingColumnFromError(error)) throw error;
		return { strictDmarc: false, migrationPending: true };
	}
}

export async function saveStrictDmarc(env: Pick<CloudflareEnv, "DB">, strictDmarc: boolean): Promise<void> {
	const values = { strictDmarc, updatedAt: new Date() };
	await getDb(env)
		.insert(spamPolicySettings)
		.values({ id: "default", ...values })
		.onConflictDoUpdate({ target: spamPolicySettings.id, set: values });
}

/**
 * The owner's switch and published policies for inbound mail. TXT records come from the system resolver on Node
 * (`RESOLVE_TXT`) and over DNS-over-HTTPS on Workers. Both are read only for mail whose DMARC check failed.
 */
export function dmarcPolicySource(
	env: Pick<CloudflareEnv, "DB" | "RESOLVE_TXT">,
	options: LookupOptions = {},
): DmarcPolicySource {
	const resolveTxt: ResolveTxt = env.RESOLVE_TXT ?? ((name) => queryDns(name, "TXT"));
	return {
		strict: async () => (await readStrictDmarc(env)).strictDmarc,
		published: (domain) => lookupPublishedDmarcPolicy(domain, resolveTxt, options),
	};
}
