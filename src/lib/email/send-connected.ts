import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outboundJobs } from "@/db/schema";
import { messageExternalAccounts } from "@/db/schema/external-accounts";
import { runPostDeliveryStep } from "@/lib/email/post-delivery-utils";
import { enqueueAppendSent, SubmissionError } from "@/lib/external-accounts/submit";
import { submitRetryDelaySeconds } from "@/lib/external-accounts/submit-utils";

/** The parts of a send that a connected account's SMTP transport needs (spec §7.3). */
type ConnectedDelivery = {
	jobId: string;
	messageId: string;
	mailboxId: string;
	externalAccountId: string | null;
	attempt: number;
};

/** What `getOutboundProviderConfig` needs to send through the account, or null for the From domain's provider. */
export function submissionFor(delivery: ConnectedDelivery, userId: string) {
	return delivery.externalAccountId
		? {
				accountId: delivery.externalAccountId,
				userId,
				mailboxId: delivery.mailboxId,
				messageId: delivery.messageId,
				jobId: delivery.jobId,
				attempt: delivery.attempt,
			}
		: null;
}

/**
 * The account's server asked to try later (an SMTP 4xx, while attempts remain): the job waits in the queue again,
 * still undoable from Sent, and runs after a delay. False when it is not such a failure, or the send was taken back
 * meanwhile; anything that may have been delivered is never queued again.
 */
export async function requeueAfterRefusal(
	env: CloudflareEnv,
	delivery: ConnectedDelivery,
	error: unknown,
): Promise<boolean> {
	if (!(error instanceof SubmissionError) || error.action !== "retry") return false;
	const [requeued] = await getDb(env)
		.update(outboundJobs)
		.set({ status: "queued", error: error.message, updatedAt: new Date() })
		.where(and(eq(outboundJobs.id, delivery.jobId), eq(outboundJobs.status, "sending")))
		.returning({ id: outboundJobs.id });
	if (!requeued) return false;
	const delaySeconds = submitRetryDelaySeconds(delivery.attempt);
	try {
		await env.OUTBOUND_QUEUE.send(
			{
				kind: "email.scheduled",
				jobId: delivery.jobId,
				messageId: delivery.messageId,
				scheduledAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
				attempt: delivery.attempt + 1,
			},
			{ delaySeconds },
		);
	} catch (queueError) {
		// Nothing would ever run the queued job: take the claim back so the send fails like any other, with the reply.
		console.warn(`Could not queue another try of ${delivery.messageId}`, queueError);
		await getDb(env)
			.update(outboundJobs)
			.set({ status: "sending", updatedAt: new Date() })
			.where(and(eq(outboundJobs.id, delivery.jobId), eq(outboundJobs.status, "queued")));
		return false;
	}
	return true;
}

/** After a send through an account: the Sent row names the account, and the provider's Sent copy is queued. */
export async function recordConnectedSend(
	env: CloudflareEnv,
	delivery: ConnectedDelivery,
	response: { appendSent?: boolean },
): Promise<void> {
	const { externalAccountId, messageId } = delivery;
	if (!externalAccountId) return;
	await runPostDeliveryStep(`connected account of ${messageId}`, () =>
		getDb(env)
			.update(messageExternalAccounts)
			.set({ externalAccountId })
			.where(eq(messageExternalAccounts.id, messageId)),
	);
	if (response.appendSent)
		await runPostDeliveryStep(`Sent copy at the provider for ${messageId}`, () =>
			enqueueAppendSent(env, externalAccountId, messageId),
		);
}
