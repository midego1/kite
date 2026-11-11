"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ManagedAccount } from "../types";
import { fetchManagedAccount } from "../utils";
import { resetAccountSecondFactors, saveAccountPassword } from "./utils";
import { PageHeader } from "@/components/ui/page";

export default function AccountPasswordPage() {
	const { id } = useParams<{ id: string }>();
	const [account, setAccount] = useState<ManagedAccount | null>(null);
	const [password, setPassword] = useState("");
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [confirmingReset, setConfirmingReset] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [resetMessage, setResetMessage] = useState<string | null>(null);

	async function resetSecondFactors() {
		if (!account) return;
		setResetting(true);
		setResetMessage(null);
		try {
			const removed = await resetAccountSecondFactors(account.id);
			setResetMessage(
				`Two-factor sign-in reset${removed ? ` and ${removed} passkey${removed === 1 ? "" : "s"} removed` : ""}. This account has been signed out everywhere.`,
			);
		} catch (error) {
			setResetMessage(error instanceof Error ? error.message : "Unable to reset two-factor sign-in");
		} finally {
			setResetting(false);
			setConfirmingReset(false);
		}
	}

	useEffect(() => {
		void fetchManagedAccount(id)
			.then(setAccount)
			.catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load account"));
	}, [id]);

	return (
		<div className="space-y-6">
			<PageHeader title="Password" description={<>Reset the password for {account?.name ?? "this account"}.</>} />
			<form
				onSubmit={(event) => void saveAccountPassword({ event, account, password, setPassword, setSaving, setMessage })}
				className="space-y-5 rounded-xl border border-neutral-200 bg-white p-5"
			>
				{account && !account.editable ? (
					<p className="text-sm text-neutral-500">Only the primary admin can reset an admin account password.</p>
				) : (
					<>
						<div className="space-y-2">
							<Label htmlFor="account-new-password">New password</Label>
							<Input
								id="account-new-password"
								type="password"
								autoComplete="new-password"
								minLength={8}
								maxLength={128}
								required
								value={password}
								disabled={!account || saving}
								onChange={(event) => setPassword(event.target.value)}
								placeholder="Enter at least 8 characters"
							/>
							<p className="text-xs leading-5 text-neutral-500">
								Setting a password signs this account out everywhere. Share it with the user through another channel.
							</p>
						</div>
						<Button type="submit" disabled={!account || saving || password.trim().length < 8}>
							{saving ? "Resetting..." : "Reset password"}
						</Button>
					</>
				)}
			</form>
			{message && (
				<p role="status" className="text-sm text-neutral-500">
					{message}
				</p>
			)}
			{account?.editable && (
				<section
					aria-labelledby="account-mfa-reset"
					className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5"
				>
					<h2 id="account-mfa-reset" className="text-sm font-semibold text-neutral-900">
						Two-factor sign-in and passkeys
					</h2>
					<p className="text-sm text-neutral-500">
						For someone who lost their phone or security key: turns off their authenticator app, deletes their recovery
						codes and passkeys, and signs them out everywhere. They sign in with their password and can set things up
						again.
					</p>
					{confirmingReset ? (
						<div className="flex flex-wrap gap-3">
							<Button variant="destructive" disabled={resetting} onClick={() => void resetSecondFactors()}>
								{resetting ? "Resetting..." : "Confirm reset"}
							</Button>
							<Button variant="outline" disabled={resetting} onClick={() => setConfirmingReset(false)}>
								Cancel
							</Button>
						</div>
					) : (
						<Button variant="outline" onClick={() => setConfirmingReset(true)}>
							Reset two-factor and passkeys
						</Button>
					)}
					{resetMessage && (
						<p role="status" className="text-sm text-neutral-500">
							{resetMessage}
						</p>
					)}
				</section>
			)}
		</div>
	);
}
