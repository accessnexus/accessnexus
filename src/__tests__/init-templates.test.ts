import { describe, expect, it } from 'vitest';
import { generateFrameworkFiles, usesExtensionlessImports } from '../cli/init/templates.js';

describe('init wrapper imports', () => {
  it('imports ./client without an extension for bundlers (Turbopack cannot map client.js to client.ts)', () => {
    for (const framework of ['nextjs-app', 'nextjs-pages', 'vite-react', 'vite', 'cra', 'react-other'] as const) {
      const files = generateFrameworkFiles({ framework, sdkOutputPath: 'src/lib/accessnexus' });
      const wrappers = files.filter((f) => f.content.includes('createAccessNexusClient'));
      expect(wrappers.length).toBeGreaterThan(0);
      for (const file of wrappers) {
        expect(file.content).toContain("from './client'");
        expect(file.content).not.toContain("from './client.js'");
      }
    }
  });

  it('keeps ./client.js for plain Node (NodeNext ESM) unless the tsconfig uses bundler resolution', () => {
    const node = generateFrameworkFiles({ framework: 'node', sdkOutputPath: 'src/lib/accessnexus' });
    expect(node.some((f) => f.content.includes("from './client.js'"))).toBe(true);

    expect(usesExtensionlessImports('node')).toBe(false);
    expect(usesExtensionlessImports('node', 'NodeNext')).toBe(false);
    expect(usesExtensionlessImports('node', 'Bundler')).toBe(true);
    expect(usesExtensionlessImports('nextjs-app', 'NodeNext')).toBe(true);
  });
});
