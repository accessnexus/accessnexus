import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Examples import 'accessnexus' like a real project; in this repo that is src/.
    alias: [
      { find: /^accessnexus$/, replacement: src('index.ts') },
      { find: /^accessnexus\/testing$/, replacement: src('testing/index.ts') },
      { find: /^accessnexus\/adapters\/supabase$/, replacement: src('adapters/supabase/index.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
