"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { LabelColorPicker } from "@/components/messages/label-color-picker";
import { accountLabelColor } from "@/components/messages/label-colors-utils";
import { LabelDot } from "@/components/messages/label-dot";
import {
	chooseLabelColor,
	pruneStoredLabelColors,
	useLabelColors,
	useMailboxLabelColor,
} from "@/components/messages/use-label-colors";
import { SettingRow, SettingRows } from "@/components/ui/page";
import { isLayoutSettled } from "@/components/layout-preferences-client";
import { LAYOUT_SETTLED_EVENT, LAYOUT_SYNC_CHANGE_EVENT } from "@/components/layout-preferences-utils";
import { useOwnAccountViews } from "@/components/use-account-views";
import { Link2 } from "lucide-react";

function subscribeToSettled(onChange: () => void) {
	window.addEventListener(LAYOUT_SETTLED_EVENT, onChange);
	window.addEventListener(LAYOUT_SYNC_CHANGE_EVENT, onChange);
	return () => {
		window.removeEventListener(LAYOUT_SETTLED_EVENT, onChange);
		window.removeEventListener(LAYOUT_SYNC_CHANGE_EVENT, onChange);
	};
}

/**
 * The colour of each mailbox's square and each connected account's icon in the message list, by the mailbox or account.
 * Only mailboxes the user can open and accounts they connected are listed; entries of ones that are gone are dropped
 * once this page has both lists and the account's layout has loaded, so a cleanup never replaces colours another
 * device saved that this browser had not seen yet.
 */
export function LabelColorsSettings() {
	const { mailboxes, isLoading } = useSelectedMailbox();
	const accounts = useOwnAccountViews();
	const colors = useLabelColors();
	const settled = useSyncExternalStore(subscribeToSettled, isLayoutSettled, () => false);
	const colorOf = useMailboxLabelColor();
	const mailboxIds = mailboxes.map((mailbox) => mailbox.id).join("\u0000");
	const accountIds = accounts?.map((account) => account.id).join("\u0000");

	useEffect(() => {
		if (!settled) return;
		// A list that is still loading, empty or failed is not "everything is gone": that kind is left as it is.
		pruneStoredLabelColors({
			mailboxes: !isLoading && mailboxIds ? mailboxIds.split("\u0000") : undefined,
			accounts: accountIds === undefined ? undefined : accountIds ? accountIds.split("\u0000") : [],
		});
	}, [settled, isLoading, mailboxIds, accountIds]);

	const known = () => ({
		mailboxes: !isLoading && mailboxes.length ? mailboxes.map((mailbox) => mailbox.id) : undefined,
		accounts: accounts?.map((account) => account.id),
	});

	return (
		<SettingRows>
			{mailboxes.map((mailbox) => {
				const address = getMailboxAddress(mailbox);
				const color = colorOf(mailbox.id);
				const name = getMailboxName(mailbox);
				return (
					<SettingRow
						key={mailbox.id}
						htmlFor={`label-color-mailbox-${mailbox.id}`}
						label={
							<span className="flex items-center gap-2">
								<LabelDot color={color.value} className="h-2.5 w-2.5" />
								{name}
							</span>
						}
						description={color.chosen ? address : `${address} · automatic colour`}
						control={
							<LabelColorPicker
								id={`label-color-mailbox-${mailbox.id}`}
								label={`Colour for ${name}`}
								value={colors.mailboxes?.[mailbox.id]}
								defaultLabel="Automatic"
								defaultGlyph="A"
								onChange={(next) => chooseLabelColor("mailboxes", mailbox.id, next, known())}
							/>
						}
					/>
				);
			})}
			{(accounts ?? []).map((account) => {
				const color = accountLabelColor(colors, account.id);
				return (
					<SettingRow
						key={account.id}
						htmlFor={`label-color-account-${account.id}`}
						label={
							<span className="flex items-center gap-2">
								<Link2 aria-hidden className="h-3.5 w-3.5 text-neutral-500" style={{ color: color ?? undefined }} />
								{account.label}
							</span>
						}
						description={`${account.address} · connected account`}
						control={
							<LabelColorPicker
								id={`label-color-account-${account.id}`}
								label={`Colour for ${account.label}`}
								value={colors.accounts?.[account.id]}
								defaultLabel="No colour"
								defaultGlyph="–"
								onChange={(next) => chooseLabelColor("accounts", account.id, next, known())}
							/>
						}
					/>
				);
			})}
		</SettingRows>
	);
}
