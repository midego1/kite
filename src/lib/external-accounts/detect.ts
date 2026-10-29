import { queryDns } from "@/lib/dns-query";
import { addressDomain, findPreset, isReservedMailDomain, mxHost, presetForDomain, presetForMx } from "./presets-utils";
import type { ExternalAccountPreset } from "./types";

type MxLookup = (domain: string) => Promise<string[]>;

const lookupMx: MxLookup = (domain) => queryDns(domain, "MX");

/**
 * The preset for an address: by its domain (`gmail.com`, `icloud.com`), else by where the domain's MX records point
 * (Google Workspace, Microsoft 365, iCloud+ custom domains, Fastmail). A failed lookup is not an error: the user picks
 * the provider or enters the servers. Reserved test domains are never looked up.
 */
export async function detectPreset(address: string, lookup: MxLookup = lookupMx): Promise<ExternalAccountPreset> {
	const other = findPreset("other")!;
	const domain = addressDomain(address);
	if (!domain) return other;
	const known = presetForDomain(domain);
	if (known) return known;
	if (isReservedMailDomain(domain)) return other;
	try {
		const hosts = (await lookup(domain)).map(mxHost).filter((host): host is string => !!host);
		return presetForMx(hosts) ?? other;
	} catch {
		return other;
	}
}
