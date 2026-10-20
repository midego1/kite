import { Suspense } from "react";
import { DriveBrowser } from "@/components/drive/drive-browser";

export default async function DriveFolderPage({ params }: { params: Promise<{ folderId: string }> }) {
	const { folderId } = await params;
	return (
		<Suspense>
			<DriveBrowser key={folderId} view="my" folderId={folderId} />
		</Suspense>
	);
}
