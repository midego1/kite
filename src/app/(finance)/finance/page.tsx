import { WalletCards } from "lucide-react";

export default function FinancePage() {
	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 md:px-8" data-finance-page>
			<div className="flex items-center gap-3">
				<WalletCards className="size-6 text-blue-600" aria-hidden />
				<h1 className="text-2xl font-semibold text-neutral-900 md:text-3xl">Subscriptions</h1>
			</div>
			<section className="rounded-3xl bg-white p-6">
				<p className="text-sm text-neutral-500">
					Money Watch lists the subscriptions you track here, with their renewals and documents.
				</p>
			</section>
		</div>
	);
}
