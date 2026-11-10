"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DriveMountDto } from "@/lib/drive/types";
import { linkMount, refreshMounts, updateMount, type MountForm } from "./drive-mounts-api";

function Field({
	id,
	label,
	hint,
	...input
}: { id: string; label: string; hint?: string } & React.ComponentProps<typeof Input>) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input id={id} {...input} aria-describedby={hint ? `${id}-hint` : undefined} />
			{hint && (
				<p id={`${id}-hint`} className="text-xs text-neutral-500">
					{hint}
				</p>
			)}
		</div>
	);
}

/**
 * Link a WebDAV folder (Nextcloud, ownCloud, a NAS), or with `mount` change its name, address or app password.
 * The server checks the folder before saving; the password is never shown again, and leaving it empty on an
 * edit keeps the saved one.
 */
export function DriveMountDialog({
	mount,
	encryptionReady = true,
	onClose,
	onSaved,
}: {
	mount?: DriveMountDto;
	encryptionReady?: boolean;
	onClose: () => void;
	onSaved?: (mount: DriveMountDto) => void;
}) {
	const [form, setForm] = useState<MountForm>({
		label: mount?.label ?? "",
		url: mount?.url ?? "",
		username: mount?.username ?? "",
		password: "",
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = (field: keyof MountForm) => (event: React.ChangeEvent<HTMLInputElement>) =>
		setForm((current) => ({ ...current, [field]: event.target.value }));
	const needsPassword = !mount || mount.status === "auth_failed";

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const { mount: saved } = mount ? await updateMount(mount.id, form) : await linkMount(form);
			refreshMounts();
			onSaved?.(saved);
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
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-lg" data-drive-mount-dialog>
				<DialogHeader>
					<DialogTitle>{mount ? "Linked folder" : "Link a folder"}</DialogTitle>
					<DialogDescription>
						Show a folder from Nextcloud, ownCloud or a NAS in Drive over WebDAV. Files stay on that server; Kite only
						passes them through.
					</DialogDescription>
				</DialogHeader>
				{!encryptionReady ? (
					<p role="alert" className="text-sm text-red-600">
						Linked folders need APP_ENCRYPTION_KEY, so app passwords are only ever saved encrypted. Ask your admin.
					</p>
				) : (
					<form onSubmit={(event) => void submit(event)} className="space-y-4">
						<Field
							id="drive-mount-url"
							label="WebDAV address"
							type="url"
							required
							autoFocus={!mount}
							placeholder="https://cloud.example.com/remote.php/dav/files/you/"
							hint="The folder's full address. For Nextcloud, find it under Files → Files settings → WebDAV."
							value={form.url}
							onChange={set("url")}
						/>
						<Field
							id="drive-mount-username"
							label="Username"
							required
							autoComplete="off"
							value={form.username}
							onChange={set("username")}
						/>
						<Field
							id="drive-mount-password"
							label="App password"
							type="password"
							required={needsPassword}
							autoComplete="new-password"
							autoFocus={!!mount && needsPassword}
							placeholder={needsPassword ? undefined : "Saved; leave empty to keep it"}
							hint="Create one for Kite in the server's security settings, so your own password stays private."
							value={form.password}
							onChange={set("password")}
						/>
						<Field
							id="drive-mount-label"
							label="Name in Drive"
							placeholder="The folder's own name"
							maxLength={255}
							value={form.label}
							onChange={set("label")}
						/>
						{error && (
							<p role="alert" className="text-sm text-red-600">
								{error}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
								Cancel
							</Button>
							<Button type="submit" disabled={busy}>
								{busy ? "Checking…" : mount ? "Save" : "Link folder"}
							</Button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
