import type { ProfileAvatarChangedDetail } from "./types";

export const PROFILE_AVATAR_CHANGED_EVENT = "kite:profile-avatar-changed";

export function getProfileAvatarUrl(): string {
	return `/api/profile/avatar?v=${Date.now()}`;
}

export function dispatchProfileAvatarChanged(url: string): void {
	window.dispatchEvent(
		new CustomEvent<ProfileAvatarChangedDetail>(PROFILE_AVATAR_CHANGED_EVENT, {
			detail: { url },
		}),
	);
}
