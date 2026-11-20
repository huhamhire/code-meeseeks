export function scrollToResult(
  container: HTMLElement | null,
  runId: string,
  findingId?: string,
): void {
  const run = container?.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
  if (!run) return;
  const finding = findingId && run.querySelector(`[data-finding-id="${CSS.escape(findingId)}"]`);
  const target = finding || run;
  const highlight = finding ? 'chat-finding-flash' : 'chat-run-flash';
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add(highlight);
  window.setTimeout(() => target.classList.remove(highlight), 1600);
}
