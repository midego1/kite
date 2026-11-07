import type { ModuleClient } from "../client-registry-types";
import { AddDocumentDialog } from "./add-document-dialog";
import { SubscriptionBlock } from "./subscription-block";
import { TrackMessageDialog } from "./track-message-dialog";
import { trackProposalCard } from "./track-proposal-card";

export const suggestionCards: NonNullable<ModuleClient["suggestionCards"]> = {
	subscription: { Block: SubscriptionBlock },
};

export const messageSlots: NonNullable<ModuleClient["messageSlots"]> = {
	"finance.track-message": { Overlay: TrackMessageDialog },
	"finance.add-document": { Overlay: AddDocumentDialog },
};

export const proposalCards: NonNullable<ModuleClient["proposalCards"]> = {
	track_subscription: trackProposalCard,
};
