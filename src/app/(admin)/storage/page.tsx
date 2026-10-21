"use client";

import dynamic from "next/dynamic";
import { SkeletonRows } from "@/components/ui/skeleton";

// Only the primary admin ever opens this page, so its code loads on demand rather than with the admin shell.
const StorageAdmin = dynamic(() => import("./storage-admin").then((module) => module.StorageAdmin), {
	ssr: false,
	loading: () => <SkeletonRows count={4} />,
});

export default function StoragePage() {
	return <StorageAdmin />;
}
