/** A mailbox's saved model that the active provider does not offer, and what is used instead. */
export type UnavailableModelChoice = { saved: string; using: string | null };
export type UnavailableModels = { chat?: UnavailableModelChoice | null; triage?: UnavailableModelChoice | null };

/** Why the model select shows another model than the one saved, after the admin switched AI providers. */
export function modelFallbackText(choice: UnavailableModelChoice | null | undefined): string | null {
	if (!choice) return null;
	const using = choice.using ? `the provider's default, ${choice.using}, is used` : "the model is chosen automatically";
	return `${choice.saved} is not offered by the AI provider in use, so ${using}.`;
}
