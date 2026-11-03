import { forwardRef, type ReactNode } from "react";
import { ArrowLeft, Link2, CornerUpLeft, Star } from "lucide-react";
import { HomeContactCard } from "./home-mailbox-contact";
import { FOCUS_RING } from "./home-mailbox-sidebar";
import { WELCOME_ID } from "./home-mailbox-state-utils";
import type { HomeEmailMeta, HomeMailboxAction, HomeMailboxState, HomePerson } from "./home-mailbox-types";

const TOOL_BUTTON = `flex h-8 items-center justify-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 text-sm text-neutral-700 hover:bg-neutral-200 ${FOCUS_RING}`;

type ReaderProps = {
	state: HomeMailboxState;
	emails: HomeEmailMeta[];
	bodies: Record<string, ReactNode>;
	people: { sender: HomePerson; me: HomePerson };
	icon: string;
	headline: string;
	dispatch: (action: HomeMailboxAction) => void;
	onCopyLink: (id: string) => void;
	onContact: (person: HomePerson, chip: HTMLElement) => void;
};

/** The headline sets its second half in the quieter tone, as the old page did. */
function Subject({ email, headline }: { email: HomeEmailMeta; headline: string }) {
	if (email.id === WELCOME_ID) {
		const split = headline.indexOf(", ") + 2;
		return (
			<h1
				id={`${email.id}-subject`}
				className="text-balance text-[clamp(1.9rem,4vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-neutral-900"
			>
				{headline.slice(0, split)}
				<span className="text-neutral-500">{headline.slice(split)}</span>
			</h1>
		);
	}
	return (
		<h2 id={`${email.id}-subject`} className="text-xl font-semibold tracking-tight text-neutral-900">
			{email.subject}
		</h2>
	);
}

/** One email: subject, the people as chips (each opens its contact card), the sender line and the body. */
export const HomeReader = forwardRef<HTMLDivElement, ReaderProps>(function HomeReader(
	{ state, emails, bodies, people, icon, headline, dispatch, onCopyLink, onContact },
	ref,
) {
	const current = emails.find((email) => email.id === state.openId);
	const starred = !!current && state.starred.includes(current.id);
	const person = (address: string) => (address === people.me.address ? people.me : people.sender);
	return (
		<section
			aria-label="Reading pane"
			className={`${state.pane === "reader" ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-col bg-white`}
		>
			<div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4 text-neutral-600">
				<button
					type="button"
					aria-label="Back to list"
					onClick={() => dispatch({ type: "back" })}
					className={`flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100 hover:bg-neutral-200 md:hidden ${FOCUS_RING}`}
				>
					<ArrowLeft className="h-4 w-4" aria-hidden="true" />
				</button>
				<span className="hidden md:block" />
				{current && (
					<span className="flex items-center gap-2">
						<button
							type="button"
							aria-pressed={starred}
							aria-label={starred ? "Unstar" : "Star"}
							onClick={() => dispatch({ type: "star", id: current.id })}
							className={`${TOOL_BUTTON} w-8 px-0`}
						>
							<Star className={`h-4 w-4 ${starred ? "fill-amber-400 text-amber-500" : ""}`} aria-hidden="true" />
						</button>
						<button type="button" onClick={() => onCopyLink(current.id)} className={TOOL_BUTTON}>
							<Link2 className="h-4 w-4" aria-hidden="true" />
							Copy link
						</button>
						<button
							type="button"
							onClick={() =>
								dispatch({ type: "compose", to: people.sender.address, subject: `Re: ${current.subject}` })
							}
							className={TOOL_BUTTON}
						>
							<CornerUpLeft className="h-4 w-4" aria-hidden="true" />
							Reply
						</button>
					</span>
				)}
			</div>
			<div
				ref={ref}
				className="home-scroll @container min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6"
			>
				{emails.map((email) => {
					const open = email.id === state.openId;
					return (
						<article
							key={email.id}
							id={email.id}
							hidden={!open}
							tabIndex={-1}
							aria-labelledby={`${email.id}-subject`}
							className="mx-auto max-w-3xl scroll-mt-5 space-y-5"
						>
							<header>
								<Subject email={email} headline={headline} />
								<ul className="relative mt-3 flex flex-wrap gap-2" aria-label="People in this conversation">
									{[people.sender, people.me].map((chipPerson) => {
										const shown = open && state.contactCard?.address === chipPerson.address;
										return (
											<li key={chipPerson.address} className="group relative">
												<button
													type="button"
													aria-haspopup="dialog"
													aria-expanded={shown}
													onClick={(event) => onContact(chipPerson, event.currentTarget)}
													className={`inline-flex cursor-pointer items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-3 text-sm text-neutral-800 hover:bg-neutral-50 ${FOCUS_RING}`}
												>
													<span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-700">
														{chipPerson.own ? chipPerson.initial : <img src={icon} alt="" width={14} height={14} />}
													</span>
													{chipPerson.name}
												</button>
												{!shown && (
													<span
														role="tooltip"
														className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-xs text-white group-focus-within:block group-hover:block"
													>
														{chipPerson.address}
													</span>
												)}
											</li>
										);
									})}
									{open && state.contactCard && (
										<HomeContactCard
											// Remount on a chip switch, so the Copy button's "Copied" resets.
											key={state.contactCard.address}
											person={person(state.contactCard.address)}
											icon={icon}
											left={state.contactCard.left}
											onNewEmail={() =>
												dispatch({ type: "compose", to: state.contactCard?.address ?? "", subject: "" })
											}
											onSearch={() => dispatch({ type: "search", text: person(state.contactCard?.address ?? "").name })}
											onNote={() => {
												dispatch({ type: "closeContact" });
												dispatch({ type: "toast", text: "Demo: nothing changes here" });
											}}
										/>
									)}
								</ul>
							</header>
							<p className="text-xs text-neutral-500">
								<span className="font-medium text-neutral-800">{people.sender.name}</span> &lt;{people.sender.address}
								&gt; to {people.me.address}
							</p>
							<div className="space-y-4 border-t border-neutral-200 pt-5">{bodies[email.id]}</div>
						</article>
					);
				})}
			</div>
		</section>
	);
});
