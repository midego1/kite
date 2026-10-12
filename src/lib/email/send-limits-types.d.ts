/** Messages a user may send per rolling window; 0 means that window is not limited. */
export type SendLimits = {
	perHour: number;
	perDay: number;
};

export type SendUsage = {
	lastHour: number;
	lastDay: number;
};
