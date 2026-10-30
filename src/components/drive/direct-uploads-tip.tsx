"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Notice } from "@/components/ui/notice";
import { authFetch } from "@/lib/auth/client";

type Overview = {
	defaultStore?: { kind?: string; directUploads?: boolean };
	routes?: { objectClass: string; storeId: string }[];
	migrationPending?: boolean;
};

/** Drive on the default R2 bucket without its S3 keys: every upload passes through the Worker. */
function wantsDirectUploads(overview: Overview): boolean {
	const drive = overview.routes?.find((route) => route.objectClass === "drive");
	return (
		!overview.migrationPending &&
		overview.defaultStore?.kind === "r2" &&
		overview.defaultStore.directUploads === false &&
		(!drive || drive.storeId === "default")
	);
}

/**
 * A gentle pointer to Admin → Storage when Drive uploads still pass through the Worker. Only the primary admin
 * can read the storage overview; anyone else gets a 403 and sees nothing.
 */
export function DirectUploadsTip() {
	const [show, setShow] = useState(false);
	useEffect(() => {
		let live = true;
		authFetch("/api/admin/storage")
			.then((response) => (response.ok ? (response.json() as Promise<Overview>) : null))
			.then((overview) => live && setShow(!!overview && wantsDirectUploads(overview)))
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);
	if (!show) return null;
	return (
		<div data-direct-uploads-tip>
			<Notice
				title="Recommended: turn on direct uploads"
				actions={
					<Link href="/storage?setup=direct" className="font-medium underline underline-offset-2">
						Set up in Storage
					</Link>
				}
			>
				Drive uploads still pass through the Worker. With direct uploads, large files go straight to R2: faster, and
				less load on the Worker.
			</Notice>
		</div>
	);
}
