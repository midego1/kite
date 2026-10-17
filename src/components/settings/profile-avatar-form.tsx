"use client";

import { useRef, useState } from "react";
import { useAuthMe } from "@/hooks/use-auth-me";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { dispatchProfileAvatarChanged, getProfileAvatarUrl } from "@/lib/profile/avatar-client";
import { dispatchMailboxAvatarChanged } from "@/lib/mailboxes/avatar-client";
import { Input } from "@/components/ui/input";
import { AvatarPickerButton } from "@/components/avatar-picker-button";
import type { ProfileAvatarFormProps } from "./types";
import {
	getMailboxProfileAvatarUrl,
	PROFILE_AVATAR_ACCEPT,
	uploadMailboxProfileAvatar,
	uploadProfileAvatar,
	validateProfileAvatar,
} from "./profile-avatar-form-utils";

export function ProfileAvatarForm({
	mailboxId,
	initialHasAvatar = false,
	name = "Profile",
	colorSeed,
}: ProfileAvatarFormProps) {
	const session = useAuthMe(!mailboxId);
	const sessionHasAvatar = session.data?.user?.hasAvatar;
	const sessionSettled = !session.isPending;
	const [hasAvatar, setHasAvatar] = useState(() =>
		!mailboxId && sessionSettled ? !!sessionHasAvatar : initialHasAvatar,
	);
	const [avatarUrl, setAvatarUrl] = useState(mailboxId ? `/api/mailboxes/${mailboxId}/avatar` : "/api/profile/avatar");
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	if (useKeyChanged(`${mailboxId}|${initialHasAvatar}|${sessionHasAvatar}|${sessionSettled}`)) {
		if (mailboxId) {
			setHasAvatar(initialHasAvatar);
			setAvatarUrl(`/api/mailboxes/${mailboxId}/avatar`);
		} else if (sessionSettled) {
			setHasAvatar(!!sessionHasAvatar);
		}
	}

	async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
		const picked = event.target.files?.[0] ?? null;
		event.target.value = "";
		if (!picked) return;

		const validationError = validateProfileAvatar(picked);
		if (validationError) {
			setStatus(validationError);
			return;
		}

		setBusy(true);
		setStatus(null);
		try {
			if (mailboxId) {
				await uploadMailboxProfileAvatar(mailboxId, picked);
			} else {
				await uploadProfileAvatar(picked);
			}
			const nextAvatarUrl = mailboxId ? getMailboxProfileAvatarUrl(mailboxId) : getProfileAvatarUrl();
			setAvatarUrl(nextAvatarUrl);
			setHasAvatar(true);
			setBusy(false);
			if (mailboxId) {
				dispatchMailboxAvatarChanged(mailboxId, nextAvatarUrl);
			} else {
				dispatchProfileAvatarChanged(nextAvatarUrl);
			}
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Upload failed");
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col items-start gap-2">
			<Input ref={inputRef} type="file" accept={PROFILE_AVATAR_ACCEPT} className="hidden" onChange={onPick} />
			<AvatarPickerButton
				name={name}
				hasAvatar={hasAvatar}
				avatarUrl={avatarUrl}
				busy={busy}
				error={status}
				style={getAvatarColorStyle(colorSeed ?? mailboxId ?? name)}
				onPick={() => inputRef.current?.click()}
				onImageError={() => setHasAvatar(false)}
			/>
		</div>
	);
}
