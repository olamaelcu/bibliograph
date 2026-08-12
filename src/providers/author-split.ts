export function splitHumanAuthorString(input: string): string[] {
  return input
    .split(/\s*(?:,|\band\b|\&)\s*/i)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}