export function scrollToResult(
  container: HTMLElement | null,
  runId: string,
  findingId?: string,
): void {
  const id = CSS.escape(runId);
  const run = container?.querySelector(`[data-run-id="${id}"]`);
  const finding =
    findingId &&
    container?.querySelector(
      `[data-feedback-run-id="${id}"] [data-finding-id="${CSS.escape(findingId)}"]`,
    );
  const target = finding || run;
  if (!target) return;
  for (
    let details = target.closest('details');
    details;
    details = details.parentElement?.closest('details') ?? null
  ) {
    details.open = true;
  }
  const highlight = finding ? 'chat-finding-flash' : 'chat-run-flash';
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add(highlight);
  window.setTimeout(() => target.classList.remove(highlight), 1600);
}
