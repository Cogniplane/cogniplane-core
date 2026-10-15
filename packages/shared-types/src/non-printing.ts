// Format, control, surrogate, private-use and unassigned characters draw nothing
// or draw something else. Zero-width and tag characters can hide text that a
// model still reads, and bidirectional controls can reorder it. The agent's
// approval card, the memory data message and the memories settings view all use
// this one function, so each of them shows the characters that the others do.
const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;

/**
 * Makes characters that do not print visible as `⟦U+XXXX⟧`. Line breaks and tabs
 * stay.
 */
export function showNonPrintingCharacters(text: string): string {
  return text.replace(NON_PRINTING, (character) => {
    if (character === "\n" || character === "\r" || character === "\t") return character;
    return `⟦U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`;
  });
}
