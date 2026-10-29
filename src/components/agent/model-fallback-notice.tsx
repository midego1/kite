/** The note under a model select when the saved model is not offered by the provider in use. */
export function ModelFallbackNotice({ text }: { text: string | null }) {
	return text ? <span className="mt-1 block text-amber-700">{text}</span> : null;
}
