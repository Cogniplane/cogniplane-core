// Resizing a focused textarea can leave its selection outside its scrollport.
// Measure the active selection end with the same text width and typography.
export function revealTextareaCaret(field: HTMLTextAreaElement) {
  if (field.scrollHeight <= field.clientHeight || !field.clientHeight) return;
  const style = getComputedStyle(field);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", pointerEvents: "none",
    top: "0", left: "0", boxSizing: "border-box", border: "0",
    width: `${field.clientWidth}px`, height: "auto", margin: "0",
    padding: style.padding, font: style.font, letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing, textIndent: style.textIndent,
    textTransform: style.textTransform, textAlign: style.textAlign,
    tabSize: style.tabSize, direction: style.direction, wordBreak: style.wordBreak,
    whiteSpace: "pre-wrap", overflowWrap: "break-word",
  });
  const offset = field.selectionDirection === "backward" ? field.selectionStart : field.selectionEnd;
  mirror.textContent = field.value.slice(0, offset);
  const marker = document.createElement("span");
  marker.textContent = field.value.slice(offset) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  try {
    const caret = marker.getClientRects()[0];
    if (!caret) return;
    const top = caret.top - mirror.getBoundingClientRect().top;
    const bottom = top + caret.height;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    if (top < field.scrollTop + paddingTop) field.scrollTop = Math.max(0, top - paddingTop);
    else if (bottom > field.scrollTop + field.clientHeight - paddingBottom) {
      field.scrollTop = bottom - field.clientHeight + paddingBottom;
    }
  } finally {
    mirror.remove();
  }
}
