import type { CSSProperties } from "react";

export type AvatarPickerButtonProps = {
	name: string;
	hasAvatar: boolean;
	avatarUrl: string;
	busy: boolean;
	error: string | null;
	style?: CSSProperties;
	onPick: () => void;
	onImageError: () => void;
};
