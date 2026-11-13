/** Why an action cannot run now, then what happens next, as one passage: `why` may end in a full stop or not. */
export function notNowText(why: string, next: string): string {
  return `${why.replace(/\.$/, "")}. ${next}`;
}

/**
 * The one neutral line a question shows while its action cannot run now (#2455): why, and that the action comes back by
 * itself. It is not an error: nothing was tried, so the error notice is kept for a write that really failed.
 */
export function NotNowLine({ action, why }: { readonly action: string; readonly why: string }) {
  return (
    <p className="text-prose text-muted-foreground">
      {notNowText(why, `${action} comes back by itself once the machine can take it.`)}
    </p>
  );
}
