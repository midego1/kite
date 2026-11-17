import type { Message } from "@/hooks/types";
import type { MailingListInfo } from "@/lib/email/mailing-list-types";

export type CachedMessageDetail = {
	message?: Message;
	body?: { htmlBody: string | null; textBody: string | null } | null;
	attachments?: Array<{
		contentId: string | null;
		disposition: "attachment" | "inline";
		filename: string;
		id: string;
		messageId: string;
		size: number;
		type: string;
	}>;
	unsubscribeUrl?: string | null;
	/** The list an inbound message came from; null or absent when it is not from one. */
	mailingList?: MailingListInfo | null;
	error?: string;
};
