"use client";

import { Camera, LoaderCircle, User } from "lucide-react";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import type { AvatarPickerButtonProps } from "./avatar-picker-button-types";

export function AvatarPickerButton({
	name,
	hasAvatar,
	avatarUrl,
	busy,
	error,
	style,
	onPick,
	onImageError,
}: AvatarPickerButtonProps) {
	return (
		<>
			<button
				type="button"
				onClick={onPick}
				disabled={busy}
				className="group relative h-24 w-24 overflow-hidden rounded-full border border-neutral-200 bg-blue-600 text-white shadow-sm outline-none ring-blue-500 transition focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-wait"
				style={style}
				aria-label={hasAvatar ? `Change ${name} profile picture` : `Upload ${name} profile picture`}
			>
				{hasAvatar ? (
					<ProgressiveAvatarImage
						src={avatarUrl}
						alt={`${name} profile picture`}
						className="h-full w-full object-cover"
						onError={onImageError}
					/>
				) : (
					<span className="flex h-full w-full items-center justify-center">
						<User className="h-9 w-9" />
					</span>
				)}
				<span className="absolute inset-0 flex items-center justify-center bg-neutral-950/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
					{busy ? (
						<LoaderCircle className="h-6 w-6 animate-spin" />
					) : (
						<span className="flex flex-col items-center gap-1 text-[11px] font-medium">
							<Camera className="h-5 w-5" />
							{hasAvatar ? "Change" : "Upload"}
						</span>
					)}
				</span>
			</button>
			{error && (
				<p role="alert" className="max-w-xs text-xs text-red-600">
					{error}
				</p>
			)}
		</>
	);
}
