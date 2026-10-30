"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Zap } from "lucide-react";
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
		<p data-direct-uploads-tip className="flex items-start gap-2 rounded-xl bg-blue-50 p-4 text-sm text-blue-900">
			<Zap aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
			<span>
				<span className="font-medium">Recommended: turn on direct uploads.</span> Large Drive uploads then go straight
				to R2: faster, and less load on the Worker.{" "}
				<Link href="/storage?setup=direct" className="font-medium underline underline-offset-2">
					Set up in Storage
				</Link>
			</span>
		</p>
	);
}
