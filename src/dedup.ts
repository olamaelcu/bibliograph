import { createHash } from 'node:crypto';

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(the|a|an)\s+/i, '');
}

function extractYear(dateStr?: string): string {
  if (!dateStr) return '';
  const match = dateStr.match(/(\d{4})/);
  return match ? match[1] : '';
}

export function computeDeduplicationHash(
  title: string,
  author: string,
  publishedDate?: string,
): string {
  const key = `${normalize(title)}|${normalize(author)}|${extractYear(publishedDate)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}
