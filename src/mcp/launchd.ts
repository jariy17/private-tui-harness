import { delimiter, dirname } from 'path';

const FALLBACK_PATH_ENTRIES = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export function buildLaunchdPath(nodePath: string, currentPath = process.env.PATH ?? ''): string {
  const entries = [dirname(nodePath), ...currentPath.split(delimiter), ...FALLBACK_PATH_ENTRIES];
  return [...new Set(entries.filter(entry => entry.length > 0))].join(delimiter);
}

export function escapePlistValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
