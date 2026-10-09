"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson } from "./api";
import { StatusRow } from "./status-row";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";

type Props = {
	configured: boolean | null;
	/** Called after the key was saved (true) or removed (false). */
	onChanged: (configured: boolean) => void;
	onError: (message: string) => void;
};

/** The shared Resend API key, used by both the sending and receiving setup. */
export default function ResendKeyRow({ configured, onChanged, onError }: Props) {
	const [apiKey, setApiKey] = useState("");
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const showForm = configured === false || editing;

	async function run(action: () => Promise<void>) {
		setBusy(true);
		onError("");
		try {
			await action();
		} catch (error) {
			onError(error instanceof Error ? error.message : "Request failed");
		} finally {
			setBusy(false);
		}
	}

	const save = () =>
		run(async () => {
			await postJson("/api/admin/resend-key", "PUT", { apiKey });
			setApiKey("");
			setEditing(false);
			onChanged(true);
		});
	const remove = () =>
		run(async () => {
			if (
				!(await requestConfirmation({
					title: "Remove the Resend API key?",
					description: "Every domain using Resend will stop sending and receiving.",
					confirmLabel: "Remove key",
				}))
			)
				return;
			await postJson("/api/admin/resend-key", "DELETE", {});
			onChanged(false);
		});

	return (
		<>
			<StatusRow
				ok={!!configured && !editing}
				title="API key"
				hint="Shared by every domain using Resend"
				action={
					configured && !editing ? (
						<>
							<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => setEditing(true)}>
								Replace
							</Button>
							<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => void remove()}>
								Remove
							</Button>
						</>
					) : undefined
				}
			>
				{showForm ? (
					<form
						className="flex flex-wrap gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<Input
							type="password"
							autoComplete="off"
							placeholder="re_..."
							value={apiKey}
							onChange={(event) => setApiKey(event.target.value)}
							className="max-w-xs bg-white"
						/>
						<Button type="submit" size="sm" disabled={!apiKey.trim() || busy}>
							{busy ? "Checking…" : "Save key"}
						</Button>
						{editing && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="bg-white"
								onClick={() => {
									setEditing(false);
									setApiKey("");
								}}
							>
								Cancel
							</Button>
						)}
					</form>
				) : configured ? (
					"API key saved"
				) : (
					"Checking…"
				)}
			</StatusRow>
			{showForm && (
				<li className="list-none px-1 text-xs text-neutral-500">
					Create a key at resend.com/api-keys. A full-access key lets Kite add the domain, its DNS and the receiving
					webhook for you; a sending-only key works for sending, but you add the domain in Resend yourself.
				</li>
			)}
		</>
	);
}
