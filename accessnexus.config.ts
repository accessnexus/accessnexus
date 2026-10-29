import { defineConfig } from "./src";

export default defineConfig({
    schema: './examples/fullstack-saas.schema.ts',
    seed: './examples/fullstack-saas.seed.ts',
    adapter: 'supabase',
    adapterOptions: {
        dbUrlEnv: 'SUPABASE_DB_URL',
        deterministic: true,
    },
});