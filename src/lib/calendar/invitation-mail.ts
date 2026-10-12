import { buildCallContext } from "@/lib/modules/capability-utils";
import { moduleHost } from "@/lib/modules/host";
import { normalizeTimeZone } from "@/lib/time/utils";

type Sender = { id: string; role: string; isPrimaryAdmin: boolean; timeZone?: string | null };

/** Sends one invitation or update mail per attendee through the module send path, as the acting user. */
export async function sendInvitationMail(
	user: Sender,
	input: {
		mailboxId: string;
		from?: string;
		attendees: string[];
		kind: "invitation" | "update";
		event: { title: string; description?: string | null };
		file: ArrayBuffer;
	},
): Promise<void> {
	const ctx = buildCallContext({
		trigger: "api",
		viewer: { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin },
		timeZone: normalizeTimeZone(user.timeZone),
	});
	const { title, description } = input.event;
	const subject = input.kind === "update" ? `Updated invitation: ${title}` : `Invitation: ${title}`;
	const text =
		description ||
		(input.kind === "update" ? `This event has been updated: ${title}.` : `You are invited to ${title}.`);
	const content = new TextDecoder().decode(input.file);
	await Promise.all(
		input.attendees.map((to) =>
			moduleHost.mail.send(ctx, {
				mailboxId: input.mailboxId,
				from: input.from,
				to: [to],
				subject,
				text,
				calendar: { content },
			}),
		),
	);
}
