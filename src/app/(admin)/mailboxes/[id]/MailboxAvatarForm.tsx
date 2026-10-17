"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { dispatchMailboxAvatarChanged } from "@/lib/mailboxes/avatar-client";
import { Input } from "@/components/ui/input";
import { AvatarPickerButton } from "@/components/avatar-picker-button";
import type { MailboxAvatarFormProps } from "./types";
import { getMailboxAvatarUrl, MAILBOX_AVATAR_ACCEPT, uploadMailboxAvatar, validateMailboxAvatar } from "./avatar-utils";

export default function MailboxAvatarForm({ mailboxId, hasAvatar: initialHasAvatar, name }: MailboxAvatarFormProps) {
	const queryClient = useQueryClient();
	const [hasAvatar, setHasAvatar] = useState(initialHasAvatar);
	const [avatarUrl, setAvatarUrl] = useState(`/api/mailboxes/${mailboxId}/avatar`);
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	if (useKeyChanged(`${mailboxId}|${initialHasAvatar}`)) {
		setHasAvatar(initialHasAvatar);
		setAvatarUrl(`/api/mailboxes/${mailboxId}/avatar`);
	}

	async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
		const picked = event.target.files?.[0] ?? null;
		event.target.value = "";
		if (!picked) return;

		const validationError = validateMailboxAvatar(picked);
		if (validationError) {
			setStatus(validationError);
			return;
		}

		setBusy(true);
		setStatus(null);
		try {
			await uploadMailboxAvatar(mailboxId, picked);
			const nextAvatarUrl = getMailboxAvatarUrl(mailboxId);
			setAvatarUrl(nextAvatarUrl);
			setHasAvatar(true);
			dispatchMailboxAvatarChanged(mailboxId, nextAvatarUrl);
			await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Upload failed");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col items-start gap-2">
			<Input ref={inputRef} type="file" accept={MAILBOX_AVATAR_ACCEPT} className="hidden" onChange={onPick} />
			<AvatarPickerButton
				name={name}
				hasAvatar={hasAvatar}
				avatarUrl={avatarUrl}
				busy={busy}
				error={status}
				onPick={() => inputRef.current?.click()}
				onImageError={() => setHasAvatar(false)}
			/>
		</div>
	);
}
