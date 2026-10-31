import { getEmailAddressList, normalizeEmailAddress } from "@/lib/email/address";
import { parseAuthenticationResults } from "@/lib/spam/authentication-results-utils";

/** What the trusted DMARC result says about the From address of received mail, for the thread join rule. */
export type SenderDmarc = "pass" | "fail" | "unknown";

/**
 * The DMARC verdict on the trusted `Authentication-Results` (the intake hop's, never the message's own) for the
 * domain of the From address. `pass` means SPF or DKIM aligned with that domain; when the result names `header.from`,
 * it has to be the From domain, so a pass for some other domain the message mentions is `unknown`. SES names no
 * `header.from`, and its verdict is for the From header it saw. A failed check is `fail` whatever domain it names: the
 * From may be forged. No result (`none`, `temperror`, no trusted header) is `unknown`.
 */
export function senderDmarc(trusted: string | null | undefined, fromAddress: string): SenderDmarc {
	if (!trusted) return "unknown";
	const dmarc = parseAuthenticationResults(trusted).results.find((entry) => entry.method === "dmarc");
	if (dmarc?.result === "fail") return "fail";
	const fromDomain = domainOf(fromAddress);
	if (dmarc?.result !== "pass" || !fromDomain) return "unknown";
	const headerFrom = dmarc.properties["header.from"]?.trim().toLowerCase().replace(/\.$/, "");
	return !headerFrom || headerFrom === fromDomain ? "pass" : "unknown";
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
