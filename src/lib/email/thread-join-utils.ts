import { getEmailAddressList, normalizeEmailAddress } from "@/lib/email/address";
import { parseAuthenticationResults } from "@/lib/spam/authentication-results-utils";

/**
 * Whether the trusted `Authentication-Results` (the intake hop's, never the message's own) says the message passed
 * DMARC for the domain of its From address. A DMARC pass means SPF or DKIM aligned with that domain; when the result
 * names `header.from`, it has to be the From domain, so a pass for some other domain the message mentions does not
 * count. SES names no `header.from`, and its verdict is for the From header it saw.
 */
export function dmarcAlignedPass(trusted: string | null | undefined, fromAddress: string): boolean {
	if (!trusted) return false;
	const fromDomain = domainOf(fromAddress);
	if (!fromDomain) return false;
	const dmarc = parseAuthenticationResults(trusted).results.find((entry) => entry.method === "dmarc");
	if (dmarc?.result !== "pass") return false;
	const headerFrom = dmarc.properties["header.from"]?.trim().toLowerCase().replace(/\.$/, "");
	return !headerFrom || headerFrom === fromDomain;
}

function domainOf(address: string): string {
	const bare = normalizeEmailAddress(address);
	const at = bare.lastIndexOf("@");
	return at > 0 ? bare.slice(at + 1).replace(/\.$/, "") : "";
}

/** The address columns of a stored message that name the people in its conversation. */
export type ThreadParticipantRow = {
	fromAddr: string | null;
	toAddr: string | null;
	ccAddr: string | null;
	bccAddr: string | null;
};

/**
 * Whether `address` already takes part in a conversation: it sent, received or was copied on one of its messages.
 * Whole addresses are compared, never substrings.
 */
export function isThreadParticipant(address: string, rows: readonly ThreadParticipantRow[]): boolean {
	const sender = normalizeEmailAddress(address);
	if (!sender) return false;
	return rows.some((row) =>
		[row.fromAddr, row.toAddr, row.ccAddr, row.bccAddr].some((field) => getEmailAddressList(field).includes(sender)),
	);
}
