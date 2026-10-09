export type ProgressToast = {
	update: (done: number, total?: number) => void;
	succeed: (message: string) => void;
	fail: (message: string) => void;
};
