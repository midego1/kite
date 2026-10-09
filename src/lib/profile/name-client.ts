import type { ProfileNameChangedDetail } from "./types";

export const PROFILE_NAME_CHANGED_EVENT = "kite:profile-name-changed";

export function dispatchProfileNameChanged(name: string): void {
	window.dispatchEvent(
		new CustomEvent<ProfileNameChangedDetail>(PROFILE_NAME_CHANGED_EVENT, {
			detail: { name },
		}),
	);
}
