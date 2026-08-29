const DEFAULT_MAX_LENGTH = 240;

export function splitChatMessage(message: string, maxLength = DEFAULT_MAX_LENGTH): string[] {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return [];
  }

  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1);
    const lastSpace = candidate.lastIndexOf(' ');
    const splitAt = lastSpace > 0 ? lastSpace : maxLength;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}
