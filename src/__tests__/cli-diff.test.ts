import { describe, expect, it } from 'vitest';
import { buildDiff, renderUnifiedDiff, stripVolatileHeader, type ExpectedFile } from '../cli/diff.js';

describe('CLI diff', () => {
  it('detects added, modified and removed files', () => {
    const expected: ExpectedFile[] = [
      {
        absolutePath: '/repo/generated/policies/users_rls.sql',
        displayPath: 'generated/policies/users_rls.sql',
        content: 'CREATE POLICY users_select;',
      },
      {
        absolutePath: '/repo/generated/sdk/client.ts',
        displayPath: 'generated/sdk/client.ts',
        content: 'export const v = 2;',
      },
    ];

    const current = new Map<string, string>([
      ['/repo/generated/sdk/client.ts', 'export const v = 1;'],
      ['/repo/generated/triggers/old.sql', 'DROP ME'],
    ]);

    const changes = buildDiff(expected, current);

    expect(changes).toHaveLength(3);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'added',
          displayPath: 'generated/policies/users_rls.sql',
        }),
        expect.objectContaining({
          status: 'modified',
          displayPath: 'generated/sdk/client.ts',
        }),
        expect.objectContaining({
          status: 'removed',
          absolutePath: '/repo/generated/triggers/old.sql',
        }),
      ]),
    );
  });

  it('renders unified diff for modified files', () => {
    const changes = buildDiff(
      [{
        absolutePath: '/repo/generated/sdk/client.ts',
        displayPath: 'generated/sdk/client.ts',
        content: 'line1\nline2-new',
      }],
      new Map<string, string>([
        ['/repo/generated/sdk/client.ts', 'line1\nline2-old'],
      ]),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe('modified');

    const text = renderUnifiedDiff(changes[0]);
    expect(text).toContain('--- a/generated/sdk/client.ts');
    expect(text).toContain('+++ b/generated/sdk/client.ts');
    expect(text).toContain('-line2-old');
    expect(text).toContain('+line2-new');
  });

  it('prints only the changed hunks, not whole files', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`);
    const after = [...before];
    after[20] = 'line20-new';
    const changes = buildDiff(
      [{ absolutePath: '/repo/a.sql', displayPath: 'a.sql', content: after.join('\n') }],
      new Map<string, string>([['/repo/a.sql', before.join('\n')]]),
    );
    const text = renderUnifiedDiff(changes[0]);
    expect(text).toContain('+line20-new');
    expect(text).toContain(' line17');
    expect(text).not.toContain('line5\n');
    expect(text).not.toContain('line30');
  });

  it('ignores a difference limited to the volatile "Generated at" header', () => {
    const changes = buildDiff(
      [{
        absolutePath: '/repo/generated/policies/a_rls.sql',
        displayPath: 'generated/policies/a_rls.sql',
        content: '-- AccessNexus\n-- Generated at: 2026-01-02T00:00:00.000Z\nCREATE POLICY x;\n',
      }],
      new Map<string, string>([
        ['/repo/generated/policies/a_rls.sql', '-- AccessNexus\n-- Generated at: 2025-01-01T00:00:00.000Z\nCREATE POLICY x;\n'],
      ]),
    );
    expect(changes).toEqual([]);
    expect(stripVolatileHeader('-- Generated at: now\nSELECT 1;')).toBe('SELECT 1;');
  });
});
