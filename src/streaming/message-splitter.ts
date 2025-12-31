/**
 * Split a long message into chunks that fit Discord's 2000 character limit.
 * Tries to split at natural boundaries (newlines, sentences, words).
 */
export function splitMessage(content: string, maxLength: number = 2000): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point
    let splitIndex = findSplitPoint(remaining, maxLength);

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

function findSplitPoint(text: string, maxLength: number): number {
  // Try to split at a double newline (paragraph break)
  const doubleNewline = text.lastIndexOf("\n\n", maxLength);
  if (doubleNewline > maxLength * 0.5) {
    return doubleNewline + 2;
  }

  // Try to split at a single newline
  const newline = text.lastIndexOf("\n", maxLength);
  if (newline > maxLength * 0.5) {
    return newline + 1;
  }

  // Try to split at a sentence boundary
  const sentenceEnders = [". ", "! ", "? ", ".\n", "!\n", "?\n"];
  let bestSentenceEnd = -1;

  for (const ender of sentenceEnders) {
    const index = text.lastIndexOf(ender, maxLength);
    if (index > bestSentenceEnd) {
      bestSentenceEnd = index;
    }
  }

  if (bestSentenceEnd > maxLength * 0.3) {
    return bestSentenceEnd + 2;
  }

  // Try to split at a word boundary (space)
  const space = text.lastIndexOf(" ", maxLength);
  if (space > maxLength * 0.3) {
    return space + 1;
  }

  // Last resort: hard split at maxLength
  return maxLength;
}

/**
 * Format a streaming message with a "continuing..." indicator.
 */
export function formatStreamingMessage(
  content: string,
  maxLength: number = 2000,
  isComplete: boolean = false
): string {
  if (content.length <= maxLength) {
    return content;
  }

  // Leave room for continuation indicator
  const indicator = isComplete ? "" : "\n\n*...(continuing)*";
  const available = maxLength - indicator.length;

  return content.slice(0, available) + indicator;
}
