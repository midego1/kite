"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OAuthProviderId } from "@/lib/external-accounts/oauth-provider-utils";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import type { AccountFormState } from "./connected-accounts-types";
import { OAUTH_LABELS } from "./connected-accounts-utils";

/** Microsoft's four squares, for the sign-in button. */
function MicrosoftLogo() {
	return (
		<svg viewBox="0 0 21 21" aria-hidden="true" className="h-4 w-4 shrink-0">
			<rect x="1" y="1" width="9" height="9" fill="#f25022" />
			<rect x="11" y="1" width="9" height="9" fill="#7fba00" />
			<rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
			<rect x="11" y="11" width="9" height="9" fill="#ffb900" />
		</svg>
	);
}

/** Google's "G", for the sign-in button. */
function GoogleLogo() {
	return (
		<svg viewBox="0 0 48 48" aria-hidden="true" className="h-4 w-4 shrink-0">
			<path
				fill="#EA4335"
				d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
			/>
			<path
				fill="#4285F4"
				d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
			/>
			<path
				fill="#FBBC05"
				d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
			/>
			<path
				fill="#34A853"
				d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
			/>
		</svg>
	);
}

/** The provider's logo, for its sign-in buttons. */
export function ProviderLogo({ provider }: { provider: OAuthProviderId }) {
	return provider === "google" ? <GoogleLogo /> : <MicrosoftLogo />;
}

const INTRO: Record<OAuthProviderId, { connect: string; reconnect: string }> = {
	microsoft: {
		connect:
			"Kite opens Microsoft's sign-in page. Sign in as this account and accept: Kite gets access to its mail over IMAP and SMTP, never your Microsoft password.",
		reconnect: "To renew Kite's access, sign in with Microsoft again as this account.",
	},
	google: {
		connect:
			"Kite opens Google's sign-in page. Sign in as this account and allow Kite to read, compose, send and delete its Gmail mail: Kite gets access over IMAP and SMTP, never your Google password, and needs no app password.",
		reconnect: "To renew Kite's access, sign in with Google again as this account.",
	},
};

/**
 * The provider part of the connect dialog (spec §15): no password field, only the Kite password, which is asked again
 * because Kite keeps the sign-in. With `reconnect` (an edit of a connected account) it also offers **Sign in with …
 * again**, which replaces the saved sign-in. `onUsePassword` (Google) switches the dialog to an app password.
 */
function OAuthSignInFields({
	provider,
	form,
	setForm,
	reconnect,
	onUsePassword,
}: {
	provider: OAuthProviderId;
	form: AccountFormState;
	setForm: (form: AccountFormState) => void;
	reconnect: { busy: boolean; onClick: () => void } | null;
	onUsePassword?: () => void;
}) {
	return (
		<div className="space-y-3 rounded-lg bg-neutral-50 p-3 text-sm" {...{ [`data-${provider}-sign-in`]: "" }}>
			<p className="text-neutral-700">{reconnect ? INTRO[provider].reconnect : INTRO[provider].connect}</p>
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
					<ProviderLogo provider={provider} />
					Sign in with {OAUTH_LABELS[provider]} again
				</Button>
			)}
			{onUsePassword && (
				<p className="text-xs text-neutral-500">
					<button type="button" className="font-medium underline underline-offset-2" onClick={onUsePassword}>
						Use an app password instead
					</button>
				</p>
			)}
		</div>
	);
}

/**
 * Next to the password fields of a Gmail or Workspace account: **Sign in with Google** switches a saved app-password
 * account to Google sign-in (`startNow`); otherwise a link goes back to the Google view (a new account, or a saved
 * Google account whose person had chosen an app password instead).
 */
function GoogleSignInOffer({
	startNow,
	keepGoogle,
	busy,
	canStart,
	onSignIn,
	onChoose,
}: {
	startNow: boolean;
	/** A saved Google sign-in account: the link keeps it rather than starting a new sign-in. */
	keepGoogle: boolean;
	busy: boolean;
	canStart: boolean;
	/** A saved account: start the sign-in right away (it needs the Kite password above). */
	onSignIn?: () => void;
	/** Back to the Google view, without starting a sign-in. */
	onChoose?: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500" data-google-sign-in-offer>
			{startNow ? (
				<>
					<span>Or stop using an app password:</span>
					<Button type="button" variant="outline" size="sm" disabled={busy || !canStart} onClick={onSignIn}>
						<ProviderLogo provider="google" />
						Sign in with Google
					</Button>
				</>
			) : (
				<button type="button" className="font-medium underline underline-offset-2" onClick={onChoose}>
					{keepGoogle ? "Keep signing in with Google" : "Sign in with Google instead"}
				</button>
			)}
		</div>
	);
}

/**
 * The provider part of the dialog's sign-in: the provider's fields when the dialog signs in with one (`oauth`), with
 * **Sign in with … again** for a saved account; otherwise, for a Gmail or Workspace account on a Kite with Google
 * sign-in, the offer to use it instead of an app password.
 */
export function OAuthChoice({
	form,
	setForm,
	account,
	oauth,
	googleSetUp,
	busy,
	onSignIn,
	onPreferPassword,
}: {
	form: AccountFormState;
	setForm: (form: AccountFormState) => void;
	account: ExternalAccountView | null;
	oauth: OAuthProviderId | null;
	googleSetUp: boolean;
	busy: boolean;
	onSignIn: (provider: OAuthProviderId, accountId?: string) => void;
	onPreferPassword: (prefer: boolean) => void;
}) {
	if (oauth) {
		const reconnect =
			account && account.authKind !== "password" ? { busy, onClick: () => onSignIn(oauth, account.id) } : null;
		// An app password instead of Google sign-in: for a new account, or one that signs in with Google now.
		const usePassword = oauth === "google" && account?.authKind !== "password";
		return (
			<OAuthSignInFields
				provider={oauth}
				form={form}
				setForm={setForm}
				reconnect={reconnect}
				onUsePassword={usePassword ? () => onPreferPassword(true) : undefined}
			/>
		);
	}
	// A saved Google account can always go back to its sign-in; others need Google sign-in set up, at a Google preset.
	const savedGoogle = account?.authKind === "oauth_google";
	if (!savedGoogle && (!googleSetUp || (form.preset !== "gmail" && form.preset !== "google_workspace"))) return null;
	return (
		<GoogleSignInOffer
			startNow={!!account && !savedGoogle}
			keepGoogle={savedGoogle}
			busy={busy}
			canStart={!!form.kitePassword}
			onSignIn={account ? () => onSignIn("google", account.id) : undefined}
			onChoose={() => onPreferPassword(false)}
		/>
	);
}
