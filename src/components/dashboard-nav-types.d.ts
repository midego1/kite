export type CustomFolder = {
	id: string;
	name: string;
	color: string;
	/** Whether someone picked the colour; the collapsed rail shows only a picked colour. */
	colorIsCustom?: boolean;
};
