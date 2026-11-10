"use client";

import { useCallback, useEffect, useState } from "react";
import { DriveRequestError } from "./drive-api";
import { listMountItems, type MountListing } from "./drive-mounts-api";
import { DRIVE_REFRESH_EVENT } from "./drive-utils";

export type MountListingState = {
	listing: MountListing | null;
	loading: boolean;
	error: { message: string; code: string | null } | null;
};

/** One folder of a linked folder, reloaded on the Drive refresh event; a failure keeps its code for the banner. */
export function useMountListing(mountId: string, path: string) {
	const [state, setState] = useState<MountListingState & { key: string }>({
		key: "",
		listing: null,
		loading: true,
		error: null,
	});
	const key = `${mountId}\u0000${path}`;
	const load = useCallback(() => {
		let cancelled = false;
		listMountItems(mountId, path)
			.then((listing) => {
				if (!cancelled) setState({ key, listing, loading: false, error: null });
			})
			.catch((failure: unknown) => {
				if (cancelled) return;
				const message = failure instanceof Error ? failure.message : "Could not open this folder";
				const code = failure instanceof DriveRequestError ? failure.code : null;
				setState({ key, listing: null, loading: false, error: { message, code } });
			});
		return () => {
			cancelled = true;
		};
	}, [key, mountId, path]);

	useEffect(() => {
		let cancel = load();
		const reload = () => {
			cancel();
			cancel = load();
		};
		window.addEventListener(DRIVE_REFRESH_EVENT, reload);
		return () => {
			cancel();
			window.removeEventListener(DRIVE_REFRESH_EVENT, reload);
		};
	}, [load]);

	return state.key === key ? state : { listing: null, loading: true, error: null };
}
