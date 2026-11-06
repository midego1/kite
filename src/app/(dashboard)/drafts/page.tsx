"use client";

import { FileText } from "lucide-react";
import { MessageFolderPage } from "@/components/messages/message-folder-page";
import { msg } from "@/lib/i18n/translator";

export default function DraftsPage() {
	return (
		<MessageFolderPage
			config={{
				folder: "drafts",
				title: msg("Drafts"),
				emptyText: msg("No drafts"),
				hrefPrefix: "/drafts",
				icon: FileText,
				badgeVariant: "outline",
			}}
		/>
	);
}
