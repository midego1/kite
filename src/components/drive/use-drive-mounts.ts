"use client";

import { useEffect, useState } from "react";
import type { DriveMountDto } from "@/lib/drive/types";
import { DRIVE_MOUNTS_EVENT, listMounts } from "./drive-mounts-api";

export type DriveMountsState = {
	mounts: DriveMountDto[];
	/** False until the first answer, so nothing flashes "no linked folders" while loading. */
	loaded: boolean;
	/** Linking needs APP_ENCRYPTION_KEY; without it the form explains instead of failing on save. */
	encryptionReady: boolean;
	migrationPending: boolean;
};

const EMPTY: DriveMountsState = { mounts: [], loaded: false, encryptionReady: true, migrationPending: false };

/** The caller's linked folders while `active`, reloaded whenever one is linked, edited or unlinked. */
export function useDriveMounts(active = true): DriveMountsState {
	const [state, setState] = useState<DriveMountsState>(EMPTY);
	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const load = () =>
			listMounts()
				.then((answer) => {
					if (!cancelled)
						setState({
							mounts: answer.mounts,
							loaded: true,
							encryptionReady: answer.encryptionReady,
							migrationPending: !!answer.migrationPending,
						});
				})
				.catch(() => {
					if (!cancelled) setState((current) => ({ ...current, loaded: true }));
				});
		void load();
		window.addEventListener(DRIVE_MOUNTS_EVENT, load);
		return () => {
			cancelled = true;
			window.removeEventListener(DRIVE_MOUNTS_EVENT, load);
		};
	}, [active]);
	return state;
}
