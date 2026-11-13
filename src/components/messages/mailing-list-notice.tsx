"use client";

import { useState } from "react";
import { BellOff, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { showUndoToast } from "@/components/ui/undo-toast";
import { openUnsubscribeUrl } from "@/components/message-actions/utils";
import { useStoredState } from "@/hooks/use-stored-state";
import type { MailingListInfo } from "@/lib/email/mailing-list-types";
import { useT } from "@/lib/i18n/use-t";
import { t as translate } from "@/lib/i18n/translator";
import {
	MAILING_LIST_NOTICE_STORAGE_KEY,
	mailingListDismissKey,
	parseDismissedKeys,
	shouldOfferMailingListNotice,
	updateDismissedKeys,
} from "./mailing-list-notice-utils";
import { oneClickFailureText, runOneClickUnsubscribe, useUnsubscribed } from "./one-click-unsubscribe";
import type { OneClickRun } from "./one-click-unsubscribe-types";

const NO_KEYS: unknown = [];

/** After the notice goes, focus lands on the reader instead of the page body, where a keyboard user would be lost. */
function focusReader() {
	const reader = document.querySelector<HTMLElement>("[data-reader-scroll]");
	if (!reader) return;
	if (!reader.hasAttribute("tabindex")) reader.setAttribute("tabindex", "-1");
	reader.focus({ preventScroll: true });
}

function useDismissedLists(): [readonly string[], (key: string, dismissed: boolean) => void] {
	const [stored, setStored] = useStoredState<unknown>(MAILING_LIST_NOTICE_STORAGE_KEY, NO_KEYS);
	const keys = parseDismissedKeys(stored);
	return [keys, (key, dismissed) => setStored(updateDismissedKeys(keys, key, dismissed))];
}

type FailedRun = Extract<OneClickRun, { status: "failed" }>;

function failedRun(state: OneClickRun | "pending" | null): FailedRun | null {
	return state !== null && state !== "pending" && state.status === "failed" ? state : null;
}

function NoticeText({ listName }: { listName: string | null }) {
	const t = useT();
	return (
		<p dir="auto">
			{listName
				? // First-strong isolates keep a right-to-left list name from reordering the sentence around it.
					t("This message is from the mailing list {list}.", { list: `\u2068${listName}\u2069` })
				: t("This message is from a mailing list.")}
		</p>
	);
}

/** The outcome, in a live region that is always there, so the change is announced. */
function NoticeStatus({ unsubscribed, failed }: { unsubscribed: boolean; failed: FailedRun | null }) {
	const t = useT();
	let text: string | null = null;
	if (unsubscribed) text = t("You're unsubscribed. The sender may take a few days to stop.");
	else if (failed) text = oneClickFailureText(failed);
	const link = !unsubscribed && failed && failed.limited !== "rate" ? failed.url : null;
	return (
		<p aria-live="polite" dir="auto">
			{text}
			{link && (
				<>
					{" "}
					<a href={link} target="_blank" rel="noopener noreferrer">
						{t("Open the unsubscribe page")}
					</a>
				</>
			)}
		</p>
	);
}

/**
 * Reader notice for a received message from a mailing list (`List-Id` or `List-Unsubscribe`), with Unsubscribe
 * inline. One-click lists (RFC 8058, signed) are left by Kite itself; any other link opens in a new tab, as the menu
 * action does. Closing it hides it for that list (or that sender, when no list is named) in this browser, with Undo.
 * Never on spam, Trash or held mail.
 */
export function MailingListNotice({
	message,
	mailingList,
	unsubscribeUrl,
	alignWide,
}: {
	message: { id: string; direction: string; status: string; fromAddr: string };
	mailingList: MailingListInfo | null | undefined;
	unsubscribeUrl: string | null | undefined;
	alignWide: boolean;
}) {
	const t = useT();
	const [dismissed, setDismissed] = useDismissedLists();
	const unsubscribed = useUnsubscribed(message.id);
	const [run, setRun] = useState<{ messageId: string; state: OneClickRun | "pending" } | null>(null);
	if (!shouldOfferMailingListNotice(message, mailingList)) return null;
	const key = mailingListDismissKey(mailingList, message.fromAddr);
	if (key && dismissed.includes(key)) return null;
	const current = run?.messageId === message.id ? run.state : null;
	const failed = failedRun(current);
	const canUnsubscribe = !unsubscribed && (mailingList.oneClick || !!unsubscribeUrl);

	async function unsubscribe() {
		if (!mailingList?.oneClick) {
			if (unsubscribeUrl) openUnsubscribeUrl(unsubscribeUrl);
			return;
		}
		setRun({ messageId: message.id, state: "pending" });
		const result = await runOneClickUnsubscribe(message.id, unsubscribeUrl ?? null);
		setRun(result.status === "cancelled" ? null : { messageId: message.id, state: result });
	}

	function dismiss() {
		if (!key) return;
		setDismissed(key, true);
		focusReader();
		showUndoToast(
			key.startsWith("list:")
				? translate("The notice is hidden for this list")
				: translate("The notice is hidden for this sender"),
			async () => setDismissed(key, false),
		);
	}

	const hideLabel = key?.startsWith("list:")
		? t("Hide this notice for this list")
		: t("Hide this notice for this sender");
	return (
		<div className={alignWide ? "px-3 sm:px-6 sm:ps-16" : "px-3 sm:px-6 sm:ps-10"}>
			<Notice
				tone="info"
				icon={Mail}
				role="region"
				aria-label={t("Mailing list")}
				className="my-2 items-center"
				data-testid="mailing-list-notice"
				actions={
					<>
						{canUnsubscribe && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={current === "pending"}
								onClick={() => void unsubscribe()}
							>
								<BellOff className="h-4 w-4" aria-hidden="true" />
								{t("Unsubscribe")}
							</Button>
						)}
						{key && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								aria-label={hideLabel}
								title={hideLabel}
								onClick={dismiss}
							>
								<X className="h-4 w-4" aria-hidden="true" />
							</Button>
						)}
					</>
				}
			>
				<NoticeText listName={mailingList.name} />
				<NoticeStatus unsubscribed={unsubscribed} failed={failed} />
			</Notice>
		</div>
	);
}
