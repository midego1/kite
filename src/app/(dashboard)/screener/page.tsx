"use client";

import { screenerFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function ScreenerPage() {
	return <MessageFolderPage config={screenerFolderConfig} />;
}
