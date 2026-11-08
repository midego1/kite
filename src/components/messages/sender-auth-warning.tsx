"use client";

import { Notice } from "@/components/ui/notice";
import { useT } from "@/lib/i18n/use-t";
import type { Translate } from "@/lib/i18n/i18n-types";
import type { SenderAuthConcern, SenderAuthWarning } from "./sender-auth-warning-types";

function concernText(t: Translate, concern: SenderAuthConcern, spoofedContact: string | null): string {
	switch (concern) {
		case "dmarc_failed":
			return t("This message failed DMARC, the check that ties it to the sender's domain.");
		case "display_name_spoof":
			return t("The sender's name matches a contact you know ({contact}), but this address is different.", {
				contact: spoofedContact ?? "",
			});
		case "spf_failed":
			return t("This message failed SPF, the check that confirms the sending server for this domain.");
		case "dkim_failed":
			return t("This message failed DKIM, the signature that proves it wasn't changed on its way here.");
		case "dkim_unaligned":
			return t("This message has a valid signature, but not one issued for the sender's own domain.");
		case "reply_to_mismatch":
			return t("Replies to this message would go to a different domain than it was sent from.");
	}
}

/**
 * Reader banner for a message whose stored authentication signals (or display-name match) have
 * something to flag — nothing is re-checked here, `warning` is read straight from the message.
 * `null` renders nothing, including every clean message from a known contact.
 */
export function SenderAuthWarningNotice({
	warning,
	alignWide,
}: {
	warning: SenderAuthWarning | null;
	alignWide: boolean;
}) {
	const t = useT();
	if (!warning) return null;
	return (
		<div className={alignWide ? "px-3 sm:px-6 sm:ps-16" : "px-3 sm:px-6 sm:ps-10"}>
			<Notice
				tone="warning"
				title={t("This sender couldn't be fully verified")}
				className="my-2"
				data-sender-auth-warning
			>
				<ul className="list-disc space-y-0.5 ps-5">
					{warning.concerns.map((concern) => (
						<li key={concern}>{concernText(t, concern, warning.spoofedContact)}</li>
					))}
				</ul>
			</Notice>
		</div>
	);
}
