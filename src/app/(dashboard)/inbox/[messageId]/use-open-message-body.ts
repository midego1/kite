"use client";

import { useMemo, useState } from "react";
import { mailboxSendableAddresses } from "@/components/compose/sender-options-utils";
import type { MailboxOption } from "@/components/mailbox-provider";
import { useLoadRemoteImages } from "@/components/messages/use-load-remote-images";
import { useReaderBody } from "@/components/messages/use-reader-body";
import { useReaderFont } from "@/components/messages/use-reader-font";
import { extractOneTimeCode } from "@/lib/email/one-time-code-utils";
import { extractCloudAttachments } from "./cloud-attachment-utils";
import type { MessageDetailResponse } from "./types";
import { getOwnAddressForMessage } from "./utils";

/**
 * The open message's body with everything the reader derives from it. It runs before the reader's early returns, so
 * the sanitizing, the cloud file links and the one-time code are worked out once per message and setting instead of
 * on every render while Kite starts.
 */
export function useOpenMessageBody(data: MessageDetailResponse | null, mailbox: MailboxOption | null | undefined) {
	const [alwaysLoadRemoteImages] = useLoadRemoteImages();
	const readerFont = useReaderFont();
	const [remoteImagesShownFor, setRemoteImagesShownFor] = useState<string | null>(null);
	const message = data?.message;
	// Connected addresses count as the mailbox's own, so a reply goes out from the address the mail came to.
	const ownAddresses = mailbox ? mailboxSendableAddresses(mailbox) : [];
	const ownAddress = message ? getOwnAddressForMessage(message, ownAddresses) : "";
	const blockRemoteImages = !alwaysLoadRemoteImages && remoteImagesShownFor !== message?.id;
	const body = useReaderBody(
		message
			? {
					messageId: message.id,
					textBody: data.body?.textBody,
					htmlBody: data.body?.htmlBody,
					snippet: message.snippet,
					ownAddress,
					attachments: data.attachments ?? [],
					blockRemoteImages,
					dropFontFamily: readerFont !== undefined,
				}
			: null,
	);
	const latestContent = body?.display.latestContent ?? "";
	const subject = message?.subject;
	const cloudAttachmentResult = useMemo(() => extractCloudAttachments(latestContent), [latestContent]);
	// The same conservative extractor the server used for the notification, run
	// on the displayed text so a code that slipped through delivery still copies.
	const oneTimeCode = useMemo(() => extractOneTimeCode({ subject, text: latestContent }), [subject, latestContent]);
	return {
		body,
		ownAddress,
		ownAddresses,
		cloudAttachmentResult,
		oneTimeCode,
		/** Whether the open message's remote images are hidden; other messages follow `alwaysLoadRemoteImages`. */
		blockRemoteImages,
		alwaysLoadRemoteImages,
		showRemoteImages: () => setRemoteImagesShownFor(message?.id ?? null),
	};
}
