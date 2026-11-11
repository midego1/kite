"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SETTING_ROW_CLASS } from "@/components/ui/page-utils";
import { passkeysSupported } from "@/lib/auth/passkey-client-utils";
import type { PasskeySummary } from "@/lib/auth/passkeys-types";
import { formatUserDate } from "@/lib/time/utils";
import type { PasskeyList, PasskeyReauth } from "./passkey-settings-types";
import { addPasskey, loadPasskeys, loadTotpEnabled, removePasskey } from "./passkey-settings-utils";

const subscribeNever = () => () => {};

function formatDate(value: string): string {
	return formatUserDate(value, { dateStyle: "medium" });
}

/**
 * Settings > Security card for passkeys: the list (name, added, last used, remove) and the add dialog. Adding or
 * removing one asks for the password again, or a code from the authenticator app when two-factor is on.
 */
export function PasskeySettings() {
	const [list, setList] = useState<PasskeyList | null>(null);
	const [totpEnabled, setTotpEnabled] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<PasskeySummary | null>(null);
	const supported = useSyncExternalStore(subscribeNever, passkeysSupported, () => true);

	useEffect(() => {
		loadPasskeys()
			.then(setList)
			.catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
		void loadTotpEnabled().then(setTotpEnabled);
	}, []);

	async function refresh() {
		setList(await loadPasskeys());
	}

	if (!list) return <p className="text-sm text-neutral-500">{error ?? "Loading passkeys..."}</p>;
	if (!list.available)
		return <p className="text-sm text-neutral-500">Passkeys become available after the next database update.</p>;

	return (
		<div className="space-y-4">
			{list.appUrlWarning && (
				<p
					role="note"
					className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
				>
					{list.appUrlWarning}
				</p>
			)}
			{list.passkeys.length === 0 ? (
				<p className="text-sm text-neutral-500">
					Sign in with your fingerprint, face or device PIN instead of your password. A passkey also counts as your
					second step, so no code is asked for.
				</p>
			) : (
				<ul className="space-y-2" aria-label="Your passkeys">
					{list.passkeys.map((passkey) => (
						<li key={passkey.id} className={SETTING_ROW_CLASS}>
							<KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-neutral-500" aria-hidden="true" />
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium text-neutral-900">{passkey.name}</p>
								<p className="mt-1 text-sm text-neutral-500">
									Added {formatDate(passkey.createdAt)} ·{" "}
									{passkey.lastUsedAt ? `Last used ${formatDate(passkey.lastUsedAt)}` : "Not used yet"}
									{passkey.backedUp ? " · Synced" : ""}
								</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								aria-label={`Remove ${passkey.name}`}
								onClick={() => setRemoving(passkey)}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			{supported ? (
				<Button onClick={() => setAdding(true)}>Add a passkey</Button>
			) : (
				<p className="text-sm text-neutral-500">This browser cannot create passkeys.</p>
			)}

			<AddPasskeyDialog open={adding} onOpenChange={setAdding} totpEnabled={totpEnabled} onDone={refresh} />
			<RemovePasskeyDialog
				passkey={removing}
				onOpenChange={(open) => !open && setRemoving(null)}
				totpEnabled={totpEnabled}
				onDone={refresh}
			/>
		</div>
	);
}

/** Password, or a code from the authenticator app when two-factor is on. */
function ReauthFields({
	idPrefix,
	totpEnabled,
	value,
	onChange,
}: {
	idPrefix: string;
	totpEnabled: boolean;
	value: PasskeyReauth;
	onChange: (value: PasskeyReauth) => void;
}) {
	const usingCode = "code" in value;
	return (
		<div className="space-y-2">
			{usingCode ? (
				<>
					<Label htmlFor={`${idPrefix}-code`}>Code from your authenticator app</Label>
					<Input
						id={`${idPrefix}-code`}
						inputMode="numeric"
						autoComplete="one-time-code"
						value={value.code}
						onChange={(event) => onChange({ code: event.target.value })}
						required
					/>
				</>
			) : (
				<>
					<Label htmlFor={`${idPrefix}-password`}>Password</Label>
					<Input
						id={`${idPrefix}-password`}
						type="password"
						autoComplete="current-password"
						value={value.password}
						onChange={(event) => onChange({ password: event.target.value })}
						required
					/>
				</>
			)}
			{totpEnabled && (
				<button
					type="button"
					className="text-xs font-medium text-blue-600 hover:underline [@media(pointer:coarse)]:min-h-11"
					onClick={() => onChange(usingCode ? { password: "" } : { code: "" })}
				>
					{usingCode ? "Use your password instead" : "Use an authenticator code instead"}
				</button>
			)}
		</div>
	);
}

function DialogError({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<p role="alert" className="text-sm text-red-600">
			{error}
		</p>
	);
}

function AddPasskeyDialog({
	open,
	onOpenChange,
	totpEnabled,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	totpEnabled: boolean;
	onDone: () => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [reauth, setReauth] = useState<PasskeyReauth>({ password: "" });
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setName("");
			setReauth({ password: "" });
			setError(null);
		}
	}

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const passkey = await addPasskey(reauth, name);
			if (!passkey) {
				setError("The passkey was not created. Try again when you are ready.");
				return;
			}
			await onDone();
			close(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not add the passkey");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-[480px]">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Add a passkey</DialogTitle>
						<DialogDescription>
							Confirm it is you, then follow your browser&apos;s prompt to save the passkey on this device or in your
							password manager.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="passkey-name">Name (optional)</Label>
						<Input
							id="passkey-name"
							value={name}
							maxLength={64}
							placeholder="For example: Work laptop"
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<ReauthFields idPrefix="passkey-add" totpEnabled={totpEnabled} value={reauth} onChange={setReauth} />
					<DialogError error={error} />
					<Button type="submit" disabled={busy}>
						{busy ? "Waiting for your device..." : "Continue"}
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function RemovePasskeyDialog({
	passkey,
	onOpenChange,
	totpEnabled,
	onDone,
}: {
	passkey: PasskeySummary | null;
	onOpenChange: (open: boolean) => void;
	totpEnabled: boolean;
	onDone: () => Promise<void>;
}) {
	const [reauth, setReauth] = useState<PasskeyReauth>({ password: "" });
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setReauth({ password: "" });
			setError(null);
		}
	}

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!passkey) return;
		setBusy(true);
		setError(null);
		try {
			await removePasskey(passkey.id, reauth);
			await onDone();
			close(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not remove the passkey");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={passkey !== null} onOpenChange={close}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-[480px]">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Remove {passkey?.name ?? "passkey"}</DialogTitle>
						<DialogDescription>
							It will no longer sign you in. Also delete it from your device or password manager.
						</DialogDescription>
					</DialogHeader>
					<ReauthFields idPrefix="passkey-remove" totpEnabled={totpEnabled} value={reauth} onChange={setReauth} />
					<DialogError error={error} />
					<Button type="submit" variant="destructive" disabled={busy}>
						{busy ? "Please wait..." : "Remove passkey"}
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}
