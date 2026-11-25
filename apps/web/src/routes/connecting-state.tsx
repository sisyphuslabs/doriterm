import { EmptyState, Spinner, useShownAfter } from "@doriface/ui";

/** "Connecting to your host", once the connect has taken a second: a quick one shows nothing at all (#2768). */
export function ConnectingState() {
  const shown = useShownAfter(true);
  return shown ? (
    <EmptyState icon={<Spinner />} title="Connecting to your host" description="Opening the session." />
  ) : null;
}
