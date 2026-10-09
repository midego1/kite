import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { pruneSelection } from "./message-range-selection-utils";
import type { MessageSelectionControl, SelectedMessage } from "./types";

/**
 * Clears the selection and, when a message route is open, leaves it. Ids without a row
 * (removed by row actions, Undo or realtime refreshes) are pruned once the list has loaded,
 * or they would stay counted and be sent with the next bulk action.
 */
export function useClearSelection(
	selection: MessageSelectionControl | undefined,
	setSelectedMessages: Dispatch<SetStateAction<SelectedMessage[]>>,
	rows: Array<{ id: string }>,
	isLoading: boolean,
) {
	useEffect(() => {
		if (isLoading) return;
		setSelectedMessages((current) => pruneSelection(current, rows));
		// The setter can come from a parent's selection state and is not stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rows, isLoading]);

	const leaveOpenMessage = () => selection?.leaveOpenMessage?.();
	return {
		leaveOpenMessage,
		clearSelection() {
			setSelectedMessages([]);
			leaveOpenMessage();
		},
	};
}
