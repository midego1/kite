"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountFormState } from "./connected-accounts-types";

/** Microsoft's four squares, for the sign-in button. */
export function MicrosoftLogo() {
	return (
		<svg viewBox="0 0 21 21" aria-hidden="true" className="h-4 w-4 shrink-0">
			<rect x="1" y="1" width="9" height="9" fill="#f25022" />
			<rect x="11" y="1" width="9" height="9" fill="#7fba00" />
			<rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
			<rect x="11" y="11" width="9" height="9" fill="#ffb900" />
		</svg>
	);
}

/**
 * The Microsoft part of the connect dialog (spec §15): no password field, only the Kite password, which is asked again
 * because Kite keeps the sign-in. With `reconnect` (an edit of a connected Microsoft account) it also offers **Sign in
 * with Microsoft again**, which replaces the saved sign-in.
 */
export function MicrosoftSignInFields({
	form,
	setForm,
	reconnect,
}: {
	form: AccountFormState;
	setForm: (form: AccountFormState) => void;
	reconnect: { busy: boolean; onClick: () => void } | null;
}) {
	return (
		<div className="space-y-3 rounded-lg bg-neutral-50 p-3 text-sm" data-microsoft-sign-in>
			<p className="text-neutral-700">
				{reconnect
					? "To renew Kite's access, sign in with Microsoft again as this account."
					: "Kite opens Microsoft's sign-in page. Sign in as this account and accept: Kite gets access to its mail over IMAP and SMTP, never your Microsoft password."}
			</p>
			<div className="space-y-2">
				<Label htmlFor="external-kite-password">Your Kite password</Label>
				<Input
					id="external-kite-password"
					type="password"
					value={form.kitePassword}
					onChange={(event) => setForm({ ...form, kitePassword: event.target.value })}
					autoComplete="current-password"
				/>
				<p className="text-xs text-neutral-500">Asked again because Kite keeps the account&apos;s sign-in.</p>
			</div>
			{reconnect && (
				<Button
					type="button"
					variant="outline"
					disabled={reconnect.busy || !form.kitePassword}
					onClick={reconnect.onClick}
				>
					<MicrosoftLogo />
					Sign in with Microsoft again
				</Button>
			)}
		</div>
	);
}
