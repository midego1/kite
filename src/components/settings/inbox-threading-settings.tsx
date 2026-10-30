"use client";

import { Switch } from "@/components/ui/switch";
import { useConversationView } from "@/components/messages/use-conversation-view";
import { useLatestMessagesFirst } from "@/components/messages/use-latest-messages-first";
import { SettingRow, SettingRows } from "@/components/ui/page";

export function InboxThreadingSettings() {
	const [conversationView, setConversationView] = useConversationView();
	const [latestMessagesFirst, setLatestMessagesFirst] = useLatestMessagesFirst();

	return (
		<SettingRows>
			<SettingRow
				label="Group emails into conversations"
				description="Show related messages together as a single thread in message lists."
				control={<Switch checked={conversationView} onCheckedChange={setConversationView} />}
			/>
			<SettingRow
				label="Sort latest messages first"
				description="Show the newest email at the top of a conversation. Turn this off to show it last."
				control={<Switch checked={latestMessagesFirst} onCheckedChange={setLatestMessagesFirst} />}
			/>
		</SettingRows>
	);
}
