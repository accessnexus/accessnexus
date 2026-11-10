import { defineConfig } from "./src";

export default defineConfig({
    schema: './examples/fullstack-saas.schema.ts',
    seed: './examples/fullstack-saas.seed.ts',
    adapter: 'supabase',
    // The example's Edge Functions are written next to the rest of the output
    // (a real project keeps the default, ./supabase/functions).
    output: { functions: './generated/functions' },
    adapterOptions: {
        dbUrlEnv: 'SUPABASE_DB_URL',
        deterministic: true,
        reactQuery: true,
    },
});