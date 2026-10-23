import { isIpHost, registrableDomain } from "../analyzers/link-host-utils";
import type { SpamSignal } from "../types";
import type { LookupRequest } from "./abuse-ch-types";

const API = "https://threatfox-api.abuse.ch/api/v1/";
const MAX_HOST_LOOKUPS = 5;
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const PLAIN_HOST = /^(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/;

function hostOf(value: string): { host: string; port: string } | null {
	try {
		const url = new URL(value);
		return {
			host: url.hostname.toLowerCase().replace(/\.$/, ""),
			port: url.port || DEFAULT_PORTS[url.protocol] || "80",
		};
	} catch {
		return null;
	}
}

/**
 * What to ask ThreatFox about the links: it lists domains and `ip:port` pairs, so each link is looked up
 * by its host (an IPv4 host with the link's port), then by the registrable domains of those hosts. Only
 * host names leave Kite, never paths or query strings; IPv6 and malformed hosts are left out.
 */
export function threatfoxHostTerms(urls: readonly string[]): string[] {
	const hosts: string[] = [];
	const parents: string[] = [];
	for (const parsed of urls.map(hostOf)) {
		if (!parsed) continue;
		if (isIpHost(parsed.host)) {
			if (!parsed.host.startsWith("[")) hosts.push(`${parsed.host}:${parsed.port}`);
		} else if (PLAIN_HOST.test(parsed.host)) {
			hosts.push(parsed.host);
			parents.push(registrableDomain(parsed.host));
		}
	}
	return [...new Set([...hosts, ...parents])].slice(0, MAX_HOST_LOOKUPS);
}

/** ThreatFox answers `query_status: "ok"` with a list of matching IOCs; anything else is not a match. */
function isThreatfoxListed(answer: unknown): boolean {
	if (!answer || typeof answer !== "object") return false;
	const { query_status: status, data } = answer as { query_status?: unknown; data?: unknown };
	return status === "ok" && Array.isArray(data) && data.length > 0;
}

function threatfoxRequest(
	kind: LookupRequest["kind"],
	inputs: readonly string[],
	query: Record<string, unknown>,
): LookupRequest {
	return {
		service: "threatfox",
		kind,
		inputs,
		url: API,
		contentType: "application/json",
		body: JSON.stringify(query),
		listed: isThreatfoxListed,
	};
}

/** An exact search for a domain or `ip:port` pair. */
export function threatfoxIocRequest(term: string, urls: readonly string[]): LookupRequest {
	const inputs = urls.filter((url) => threatfoxHostTerms([url]).includes(term));
	return threatfoxRequest("link", inputs, { query: "search_ioc", search_term: term, exact_match: true });
}

/** A search for IOCs of the malware sample with this SHA-256 hash. */
export function threatfoxHashRequest(sha256: string): LookupRequest {
	return threatfoxRequest("payload", [sha256], { query: "search_hash", hash: sha256 });
}

export function threatfoxSignals(listedHosts: number, listedPayloads: number): SpamSignal[] {
	const signals: SpamSignal[] = [];
	if (listedHosts > 0)
		signals.push({
			id: "threatfox_url",
			score: 40,
			reason: "A link goes to a site ThreatFox lists as malware infrastructure",
			metadata: { count: listedHosts },
		});
	if (listedPayloads > 0)
		signals.push({
			id: "threatfox_payload",
			score: 50,
			reason: "An attachment matches malware known to ThreatFox",
			metadata: { count: listedPayloads },
		});
	return signals;
}
