"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { ExternalAccountView, ExternalIdentityView } from "@/lib/external-accounts/types";
import { aliasesOf, IDENTITY_STATE_LABELS, ownAddressVerification, removeIdentity } from "./account-addresses-utils";
import { IdentityVerifyDialog, type VerifyTarget } from "./identity-verify-dialog";

/** Where the dialog starts for an address that already has a row: at the code while one can still be entered. */
const targetFor = (identity: ExternalIdentityView): VerifyTarget => ({
	address: identity.address,
	identityId: identity.state === "pending" ? identity.id : null,
	locked: true,
});

/**
 * The addresses an account sends as besides the one its sign-in proves (spec §7.2): **Verify** for its own address when
 * the sign-in does not prove it, and aliases, each verified with a code mailed to it, with **Remove**.
 */
export function AccountAddresses({
	account,
	usable,
	onChanged,
}: {
	account: ExternalAccountView;
	usable: boolean;
	onChanged: () => void;
}) {
	const confirm = useConfirm();
	const [target, setTarget] = useState<VerifyTarget | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const own = ownAddressVerification(account);
	const aliases = aliasesOf(account);

	async function remove(identity: ExternalIdentityView) {
		const confirmed = await confirm({
			title: `Stop sending as ${identity.address}?`,
			description: "Kite removes the address from the From menu. Sending as it again needs a new code.",
			confirmLabel: "Remove",
		});
		if (!confirmed) return;
		setMessage(null);
		try {
			await removeIdentity(account.id, identity.id);
			onChanged();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not remove the address");
		}
	}

	if (!usable && !aliases.length) return null;
	return (
		<div className="space-y-2" data-account-addresses={account.address}>
			{own && usable && (
				<Button
					size="sm"
					variant="outline"
					onClick={() =>
						setTarget(
							own.identity ? targetFor(own.identity) : { address: account.address, identityId: null, locked: true },
						)
					}
				>
					Verify {account.address}
				</Button>
			)}
			{aliases.length > 0 && (
				<ul className="space-y-1" aria-label={`Other addresses of ${account.address}`}>
					{aliases.map((identity) => (
						<li
							key={identity.id}
							className="flex flex-wrap items-center gap-2 text-xs"
							data-identity={identity.address}
						>
							<span className="text-neutral-700">{identity.address}</span>
							<Badge variant={identity.state === "verified" ? "success" : "outline"}>
								{IDENTITY_STATE_LABELS[identity.state]}
							</Badge>
							{usable && identity.state !== "verified" && (
								<Button size="sm" variant="ghost" onClick={() => setTarget(targetFor(identity))}>
									Enter code
								</Button>
							)}
							<Button size="sm" variant="ghost" onClick={() => void remove(identity)}>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			{usable && (
				<Button size="sm" variant="ghost" onClick={() => setTarget({ address: "", identityId: null, locked: false })}>
					Send from another address
				</Button>
			)}
			{message && (
				<p role="status" className="text-xs text-neutral-700">
					{message}
				</p>
			)}
			{target && (
				<IdentityVerifyDialog
					accountId={account.id}
					target={target}
					onChanged={onChanged}
					onClose={(text) => {
						setTarget(null);
						setMessage(text);
					}}
				/>
			)}
		</div>
	);
}
