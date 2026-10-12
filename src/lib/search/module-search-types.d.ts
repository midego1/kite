export type ModuleSearchItem = {
	ref: { kind: string; id: string };
	label: string;
	sublabel: string;
	href: string;
};

export type ModuleSearchResult = { moduleId: string; section: string; items: ModuleSearchItem[] };

export type ModuleSearchSection = { id: string; label: string; items: ModuleSearchItem[] };
