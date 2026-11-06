import type { SpamScoreDetailsProps } from "./spam-score-details-types";
import { parseSpamSignals } from "./spam-score-details-utils";
import { useT } from "@/lib/i18n/use-t";

export function SpamScoreDetails({ score, verdict, signals, analysisError }: SpamScoreDetailsProps) {
	const t = useT();
	if (score == null && !analysisError) return null;
	const parsedSignals = parseSpamSignals(signals);
	return (
		<details className="mb-2 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3">
			<summary className="cursor-pointer text-sm font-medium text-neutral-800">
				{score == null
					? t("Spam analysis unavailable")
					: t("Spam score: {score} · {verdict}", {
							score,
							verdict: verdict === "spam" ? t("spam") : verdict === "suspicious" ? t("suspicious") : t("inbox"),
						})}
			</summary>
			{analysisError ? (
				<p className="mt-2 text-sm text-neutral-600">
					{t("The filter could not analyze this message. It was delivered normally.")}
				</p>
			) : parsedSignals.length > 0 ? (
				<div className="mt-3 space-y-1.5 text-sm text-neutral-600">
					<p className="font-medium text-neutral-800">{t("Why Kite gave this score")}</p>
					{parsedSignals.map((signal) => (
						<p key={signal.id}>
							<span className={signal.score > 0 ? "text-red-600" : "text-green-700"}>
								{signal.score > 0 ? "+" : ""}
								{signal.score}
							</span>{" "}
							{signal.reason}
						</p>
					))}
				</div>
			) : (
				<p className="mt-2 text-sm text-neutral-600">{t("No significant spam signals were found.")}</p>
			)}
		</details>
	);
}
