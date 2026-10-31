"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addIdentity, resendIdentityCode, verifyIdentity } from "./account-addresses-utils";

/** What the dialog starts with: an address to mail a code to, or one whose code was already sent (`identityId`). */
export type VerifyTarget = { address: string; identityId: string | null; locked: boolean };

/**
 * Verifies an address with a code (spec §7.2): first Kite mails a 6-digit code to the address, then the owner enters
 * it. A new code can be asked for at any time; it replaces the earlier one.
 */
export function IdentityVerifyDialog({
	accountId,
	target,
	onClose,
	onChanged,
}: {
	accountId: string;
	target: VerifyTarget;
	onClose: (message: string | null) => void;
	onChanged: () => void;
}) {
	const [address, setAddress] = useState(target.address);
	const [identityId, setIdentityId] = useState(target.identityId);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sentTo, setSentTo] = useState<string | null>(null);

	async function run(task: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await task();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	}

	const sendCode = () =>
		run(async () => {
			if (identityId) await resendIdentityCode(accountId, identityId);
			else setIdentityId(await addIdentity(accountId, address.trim()));
			setSentTo(address.trim());
			setCode("");
			onChanged();
		});

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!identityId) return void sendCode();
		void run(async () => {
			await verifyIdentity(accountId, identityId, code);
			onChanged();
			onClose(`You can now send as ${address.trim()}.`);
		});
	}

	const codeStep = !!identityId;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose(null)}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(480px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{target.locked ? `Verify ${target.address}` : "Send from another address"}</DialogTitle>
					<DialogDescription>
						Kite mails a 6-digit code to the address. Entering it shows that you receive its mail, and lets this account
						send as it.
					</DialogDescription>
				</DialogHeader>
				<form className="space-y-4" onSubmit={submit}>
					<div className="space-y-1.5">
						<Label htmlFor="identity-address">Email address</Label>
						<Input
							id="identity-address"
							type="email"
							value={address}
							onChange={(event) => setAddress(event.target.value)}
							readOnly={target.locked || codeStep}
							autoComplete="off"
							required
						/>
					</div>
					{codeStep && (
						<div className="space-y-1.5">
							<Label htmlFor="identity-code">Verification code</Label>
							<Input
								id="identity-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={7}
								value={code}
								onChange={(event) => setCode(event.target.value)}
								autoFocus
							/>
							<p className="text-xs text-neutral-500">
								{sentTo
									? `Kite sent a code to ${sentTo}. It works for 30 minutes.`
									: "Enter the code from the email Kite sent. It works for 30 minutes."}{" "}
								<button
									type="button"
									className="underline underline-offset-2"
									onClick={() => void sendCode()}
									disabled={busy}
								>
									Send a new code
								</button>
							</p>
						</div>
					)}
					{error && (
						<p
							role="alert"
							className="rounded-lg border border-[#ef4444]/25 bg-[#ef4444]/10 px-4 py-3 text-sm text-[#b91c1c] dark:text-[#f19999]"
						>
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={() => onClose(null)} disabled={busy}>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || (codeStep ? code.replace(/[\s-]/g, "").length !== 6 : !address.includes("@"))}
						>
							{codeStep ? "Verify" : busy ? "Sending…" : "Send code"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
