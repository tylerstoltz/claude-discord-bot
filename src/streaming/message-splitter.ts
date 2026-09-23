// Room left at the end of a chunk to close an open code fence ("\n```")
const FENCE_RESERVE = 4;

export interface Chunk {
  // Text to post (with any open code fence closed)
  text: string;
  // How many characters of the input this chunk used up
  consumed: number;
  // Prefix for the next chunk that reopens the fence ("```lang\n"), or ""
  carry: string;
}

/**
 * Cut the first message-sized chunk off `text`, splitting at a natural boundary
 * (paragraph, line, sentence, word) and keeping ``` code fences balanced across the cut.
 */
export function takeChunk(text: string, maxLength: number = 2000): Chunk {
  if (text.length <= maxLength) {
    return { text, consumed: text.length, carry: "" };
  }

  const consumed = findSplitPoint(text, maxLength - FENCE_RESERVE);
  let chunk = text.slice(0, consumed).trimEnd();
  let carry = "";

  const lang = openFenceLang(chunk);
  if (lang !== null) {
    chunk += "\n```";
    carry = "```" + lang + "\n";
  }

  return { text: chunk, consumed, carry };
}

/**
 * If `text` ends inside a ``` code fence, return the fence's language tag
 * ("" when it has none). Returns null when all fences are closed.
 */
export function openFenceLang(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const fence = line.match(/^ {0,3}```\s*([^\s`]*)/);
    if (!fence) continue;
    open = open === null ? fence[1] : null;
  }
  return open;
}

function findSplitPoint(text: string, maxLength: number): number {
  // Try to split at a double newline (paragraph break)
  const doubleNewline = text.lastIndexOf("\n\n", maxLength - 2);
  if (doubleNewline > maxLength * 0.5) {
    return doubleNewline + 2;
  }

  // Try to split at a single newline
  const newline = text.lastIndexOf("\n", maxLength - 1);
  if (newline > maxLength * 0.5) {
    return newline + 1;
  }

  // Try to split at a sentence boundary
  const sentenceEnders = [". ", "! ", "? "];
  let bestSentenceEnd = -1;

  for (const ender of sentenceEnders) {
    const index = text.lastIndexOf(ender, maxLength - 2);
    if (index > bestSentenceEnd) {
      bestSentenceEnd = index;
    }
  }

  if (bestSentenceEnd > maxLength * 0.3) {
    return bestSentenceEnd + 2;
  }

  // Try to split at a word boundary (space)
  const space = text.lastIndexOf(" ", maxLength - 1);
  if (space > maxLength * 0.3) {
    return space + 1;
  }

  // Last resort: hard split at maxLength
  return maxLength;
}
