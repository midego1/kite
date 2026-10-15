import { Suspense } from "react";
import { SubscriptionsView } from "@/components/finance/subscriptions-view";

export default function FinancePage() {
	return (
		<Suspense>
			<SubscriptionsView />
		</Suspense>
	);
}
