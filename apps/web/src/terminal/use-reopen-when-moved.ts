import { useEffect, useRef } from "react";

/**
 * A machine renamed before the feed told this page leaves its terminals asked for at the old name, which hc no longer
 * knows, so their attach is refused. Once the page has the new name the terminal's address moves; a view left unopened
 * at the old address then opens again at the new one (`reopen`, as Try again does) instead of staying unopened at an
 * address the terminal no longer has (#656). Returns the call that records the address an attach was refused at.
 */
export function useReopenWhenMoved(
  address: string,
  unopened: string | null,
  reopen: () => void,
): (refusedAt: string) => void {
  const refused = useRef<string | null>(null);
  const reopenNow = useRef(reopen);
  reopenNow.current = reopen;
  useEffect(() => {
    if (unopened !== null && refused.current !== address) reopenNow.current();
  }, [address, unopened]);
  return (refusedAt) => {
    refused.current = refusedAt;
  };
}
