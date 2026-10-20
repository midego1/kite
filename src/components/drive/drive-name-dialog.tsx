"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** New folder and Rename: one name field. `onSubmit` throws with the message to show when it fails. */
export function DriveNameDialog({
	title,
	initial,
	submitLabel,
	onSubmit,
	onClose,
}: {
	title: string;
	initial: string;
	submitLabel: string;
	onSubmit: (name: string) => Promise<void>;
	onClose: () => void;
}) {
	const [value, setValue] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!value.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onSubmit(value.trim());
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Something went wrong");
			setBusy(false);
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				<form onSubmit={(event) => void submit(event)} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="drive-name">Name</Label>
						<Input
							id="drive-name"
							autoFocus
							value={value}
							maxLength={255}
							onChange={(event) => setValue(event.target.value)}
							onFocus={(event) => event.currentTarget.select()}
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-red-600">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
							Cancel
						</Button>
						<Button type="submit" disabled={busy || !value.trim()}>
							{submitLabel}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
