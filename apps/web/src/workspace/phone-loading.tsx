import { QuietBusy } from "../terminal/quiet-busy.tsx";

/** The phone's list until the core's first answer: a status that says what it waits for, never an empty one. */
export function PhoneListLoading() {
  return <QuietBusy label="Loading agents" text="Loading agents…" className="h-full" />;
}
