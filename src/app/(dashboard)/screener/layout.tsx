"use client";

import { screenerFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";

export default function ScreenerLayout({ children }: { children: React.ReactNode }) {
	return <MessageSplitLayout config={screenerFolderConfig}>{children}</MessageSplitLayout>;
}
