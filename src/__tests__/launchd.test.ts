import { buildLaunchdPath, escapePlistValue } from '../mcp/launchd.js';
import { delimiter } from 'path';
import { describe, expect, it } from 'vitest';

describe('launchd configuration', () => {
  it('preserves the installer PATH and adds required fallbacks without duplicates', () => {
    const currentPath = ['/home/test/.local/bin', '/opt/tools/bin', '/usr/bin'].join(delimiter);
    const result = buildLaunchdPath('/opt/node/bin/node', currentPath).split(delimiter);

    expect(result[0]).toBe('/opt/node/bin');
    expect(result).toContain('/home/test/.local/bin');
    expect(result).toContain('/opt/tools/bin');
    expect(result).toContain('/usr/local/bin');
    expect(result).toContain('/bin');
    expect(result.filter(entry => entry === '/usr/bin')).toHaveLength(1);
  });

  it('escapes values embedded in the launchd plist', () => {
    expect(escapePlistValue(`/Users/A&B/<tools>/"node"'`)).toBe(
      '/Users/A&amp;B/&lt;tools&gt;/&quot;node&quot;&apos;'
    );
  });
});
