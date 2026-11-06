export function watchParentDeath(
  onDeath: () => void,
  options: { intervalMs?: number; parentPid?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 1_000;
  const parentPid = options.parentPid ?? process.ppid;
  let fired = false;
  const timer = setInterval(() => {
    if (fired || process.ppid === parentPid) return;
    fired = true;
    clearInterval(timer);
    onDeath();
  }, intervalMs);
  return () => {
    fired = true;
    clearInterval(timer);
  };
}
