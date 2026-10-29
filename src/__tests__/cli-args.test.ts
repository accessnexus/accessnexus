import { describe, expect, it } from 'vitest';
import { closest, parseFlags, type FlagSpecs } from '../cli/args.js';
import { CliError } from '../cli/output.js';

const SPECS: FlagSpecs = {
  schema: { kind: 'string', description: 'schema' },
  'dry-run': { kind: 'boolean', description: 'dry run' },
  'no-agents': { kind: 'boolean', description: 'skip agents' },
  yes: { kind: 'boolean', description: 'yes' },
};

function errorOf(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error('expected a CliError');
}

describe('parseFlags', () => {
  it('parses string, boolean, --flag=value, global and short flags', () => {
    expect(parseFlags(['--schema', 'a.ts', '--dry-run', '--json', '--config=x.ts', '-y', '--no-agents'], SPECS, 'push')).toEqual({
      schema: 'a.ts',
      'dry-run': true,
      json: true,
      config: 'x.ts',
      yes: true,
      'no-agents': true,
    });
  });

  it('never lets a boolean flag swallow the next token', () => {
    expect(parseFlags(['--json', '--schema', 's.ts'], SPECS, 'validate')).toEqual({ json: true, schema: 's.ts' });
  });

  it('rejects unknown flags with a suggestion', () => {
    const err = errorOf(() => parseFlags(['--shcema', 'x'], SPECS, 'generate'));
    expect(err.code).toBe('UNKNOWN_FLAG');
    expect(err.hint).toContain('--schema');
  });

  it('rejects a string flag without value and a boolean flag with one', () => {
    expect(errorOf(() => parseFlags(['--schema'], SPECS, 'generate')).code).toBe('MISSING_FLAG_VALUE');
    expect(errorOf(() => parseFlags(['--schema', '--json'], SPECS, 'generate')).code).toBe('MISSING_FLAG_VALUE');
    expect(errorOf(() => parseFlags(['--json=1'], SPECS, 'generate')).code).toBe('INVALID_FLAG_VALUE');
  });

  it('rejects positional arguments', () => {
    expect(errorOf(() => parseFlags(['schema.ts'], SPECS, 'generate')).code).toBe('UNEXPECTED_ARGUMENT');
  });
});

describe('closest', () => {
  it('suggests near matches only', () => {
    expect(closest('genrate', ['generate', 'diff'])).toBe('generate');
    expect(closest('zzzzzz', ['generate', 'diff'])).toBeUndefined();
  });
});
