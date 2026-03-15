export function renderClampedText(context) {
  const {
    buttonLabel = "Description",
    className = "",
    emptyText = "",
    escapeHtml,
    lineClamp = 2,
    renderIcon,
    text,
  } = context;

  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return emptyText ? `<p class="board-clamped-text__empty ${escapeHtml(className)}">${escapeHtml(emptyText)}</p>` : "";
  }

  return `
    <details class="board-clamped-text" data-clamped-text>
      <summary class="board-clamped-text__summary">
        <span class="board-clamped-text__preview board-clamped-text__preview--${lineClamp} ${escapeHtml(className)}">${escapeHtml(trimmed)}</span>
        <span class="board-clamped-text__toggle" aria-label="Toggle ${escapeHtml(buttonLabel)}">
          <span class="board-clamped-text__toggle-more">Show more ${renderIcon("expand_more", "text-[16px]")}</span>
          <span class="board-clamped-text__toggle-less">Collapse ${renderIcon("expand_less", "text-[16px]")}</span>
        </span>
      </summary>
      <div class="board-clamped-text__body ${escapeHtml(className)}">
        ${escapeHtml(trimmed).replaceAll("\n", "<br />")}
      </div>
    </details>
  `;
}
