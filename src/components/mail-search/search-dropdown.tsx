import clsx from "clsx";
import type { ModuleSearchItem, ModuleSearchSection } from "@/lib/search/module-search-types";
import { searchItemKey } from "./search-dropdown-utils";

type SearchDropdownProps = {
	sections: readonly ModuleSearchSection[];
	activeKey: string | null;
	onPick: (item: ModuleSearchItem) => void;
};

/** Results from the modules under the mail search field, one block per section. */
export function SearchDropdown({ sections, activeKey, onPick }: SearchDropdownProps) {
	return (
		<div
			role="listbox"
			aria-label="Search results"
			data-testid="search-dropdown"
			className="absolute inset-x-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 text-neutral-800 shadow-lg"
		>
			{sections.map((section) => (
				<div key={section.id} role="group" aria-label={section.label} data-search-section={section.id}>
					<div className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">{section.label}</div>
					{section.items.map((item) => {
						const key = searchItemKey(item);
						return (
							<button
								key={key}
								type="button"
								role="option"
								aria-selected={key === activeKey}
								data-search-item={key}
								// Keeps focus in the field, so picking a row does not blur it first.
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => onPick(item)}
								className={clsx(
									"flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-blue-50",
									key === activeKey && "bg-blue-50",
								)}
							>
								<span className="truncate text-sm font-medium">{item.label}</span>
								<span className="truncate text-xs text-neutral-500">{item.sublabel}</span>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}
