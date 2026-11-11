import { Suspense } from "react";
import { DriveMountBrowser } from "@/components/drive/drive-mount-browser";

export default async function DriveMountPage({ params }: { params: Promise<{ mountId: string }> }) {
	const { mountId } = await params;
	return (
		<Suspense>
			<DriveMountBrowser key={mountId} mountId={mountId} />
		</Suspense>
	);
}
