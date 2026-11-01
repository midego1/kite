export type ModuleSearchItem = {
	ref: { kind: string; id: string };
	label: string;
	sublabel: string;
	href: string;
};

export type ModuleSearchResult = { moduleId: string; section: string; items: ModuleSearchItem[] };

/** `moduleId` names the module whose manifest labels the section, so a client can group results by module. */
export type ModuleSearchSection = { id: string; moduleId: string; label: string; items: ModuleSearchItem[] };
