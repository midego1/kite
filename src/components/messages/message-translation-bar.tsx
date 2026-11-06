"use client";

import { Languages, X } from "lucide-react";
import { AiErrorNotice } from "@/components/agent/ai-error-notice";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { UNKNOWN_LANGUAGE } from "@/lib/agent/summaries/summary-utils";
import { useT } from "@/lib/i18n/use-t";
import type { MessageTranslationController } from "./message-translation-types";
import { shownLanguageName, translatedFromLabel, translationTargets } from "./message-translation-utils";

const LINK = "font-medium text-blue-700 hover:text-blue-900 disabled:text-neutral-400";

function browserLanguage(): string | undefined {
	return typeof navigator === "undefined" ? undefined : navigator.language;
}

function TargetPicker({ controller }: { controller: MessageTranslationController }) {
	const t = useT();
	return (
		<Select
			aria-label={t("Language to translate into")}
			value={controller.pickerTarget}
			disabled={controller.busy !== null}
			containerClassName="border-0 px-0 text-xs font-medium text-blue-700"
			onChange={(event) => controller.chooseTarget(event.target.value)}
		>
			{translationTargets(browserLanguage(), controller.pickerTarget).map((language) => (
				<option key={language.code} value={language.code}>
					{language.name}
				</option>
			))}
		</Select>
	);
}

/** Right after a language was taken off the offer, the way back, since the bar is about to stop appearing. */
function Stopped({ controller }: { controller: MessageTranslationController }) {
	const t = useT();
	return (
		<>
			<span>
				{t("Translation won't be offered for {language}.", { language: shownLanguageName(controller.detected ?? "") })}
			</span>
			<button type="button" className={LINK} onClick={controller.toggleNeverOffered}>
				{t("Undo")}
			</button>
		</>
	);
}

/** "This message is in Thai. Translate to English", with the language to choose and a way to wave it off. */
function Offer({ controller }: { controller: MessageTranslationController }) {
	const t = useT();
	const { detected, busy } = controller;
	return (
		<>
			{detected && <span>{t("This message is in {language}.", { language: shownLanguageName(detected) })}</span>}
			<button
				type="button"
				className={LINK}
				aria-label={t("Translate to {languageName}", { languageName: shownLanguageName(controller.target) })}
				disabled={busy !== null || controller.blocked}
				onClick={controller.translate}
			>
				{busy ? t("Translating…") : t("Translate to")}
			</button>
			{!busy && <TargetPicker controller={controller} />}
			<span className="flex-1" />
			{detected && (
				<button
					type="button"
					className="text-neutral-500 hover:text-neutral-900"
					onClick={controller.toggleNeverOffered}
				>
					{t("Don't offer for {language}", { language: shownLanguageName(detected) })}
				</button>
			)}
			<Tooltip label={t("Don't offer for this message")}>
				<button
					type="button"
					aria-label={t("Don't offer for this message")}
					onClick={controller.dismiss}
					className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
				>
					<X aria-hidden className="h-3.5 w-3.5" />
				</button>
			</Tooltip>
		</>
	);
}

function Translated({ controller }: { controller: MessageTranslationController }) {
	const t = useT();
	const { shown, translation, busy, detected } = controller;
	if (!translation) return null;
	if (!shown)
		return (
			<>
				<span>{t("Showing the original")}</span>
				<span aria-hidden>·</span>
				<button type="button" className={LINK} onClick={controller.translate}>
					{t("Show translation")}
				</button>
			</>
		);
	const from = shown.sourceLanguage === UNKNOWN_LANGUAGE ? (detected ?? UNKNOWN_LANGUAGE) : shown.sourceLanguage;
	return (
		<>
			<span>{busy === "translate" ? t("Translating…") : translatedFromLabel(from)}</span>
			<span aria-hidden>·</span>
			<button type="button" className={LINK} onClick={controller.showOriginal}>
				{t("Show original")}
			</button>
			<span aria-hidden>·</span>
			<TargetPicker controller={controller} />
		</>
	);
}

/** What the translation leaves out, and that it is the model's reading, not the sender's words. */
function Notes({ controller }: { controller: MessageTranslationController }) {
	const t = useT();
	const { shown, busy } = controller;
	if (!shown) return null;
	return (
		<div className="w-full space-y-1 text-neutral-500" data-translation-notes>
			<p>
				{shown.model
					? t("Written by AI ({model}), may be wrong. Links stay as the sender wrote them.", { model: shown.model })
					: t("Written by AI, may be wrong. Links stay as the sender wrote them.")}
			</p>
			{shown.cut && (
				<p data-translation-cut>{t("This message is long, so not all of it was translated. The rest is unchanged.")}</p>
			)}
			{controller.neverOffered && controller.detected && (
				<button type="button" className={`${LINK} me-3`} onClick={controller.toggleNeverOffered}>
					{t("Offer for {language} again", { language: shownLanguageName(controller.detected) })}
				</button>
			)}
			{shown.quotedPending && (
				<button
					type="button"
					className={LINK}
					disabled={busy !== null || controller.blocked}
					onClick={controller.translateQuoted}
				>
					{busy === "quoted" ? t("Translating…") : t("Translate the quoted text too")}
				</button>
			)}
		</div>
	);
}

/**
 * The quiet line above a message's body: the offer when Kite is sure the message is in a language the reader does
 * not read, then what was translated and the way back. Nothing while there is nothing to say.
 */
export function MessageTranslationBar({ controller }: { controller: MessageTranslationController }) {
	const t = useT();
	const { translation, offered, busy, error, justStopped } = controller;
	if (!translation && !offered && !busy && !error && !justStopped) return null;
	const offer = justStopped ? <Stopped controller={controller} /> : <Offer controller={controller} />;
	return (
		<section
			aria-label={t("Translation")}
			data-testid="translation-bar"
			className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600"
		>
			<Languages className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			{translation ? <Translated controller={controller} /> : offer}
			<Notes controller={controller} />
			{error && (
				<AiErrorNotice className="w-full" message={error} error={controller.failure} onRetry={controller.retry} />
			)}
		</section>
	);
}
