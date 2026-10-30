# Início rápido {#quick-start}

Esta página leva você de uma pasta vazia a uma tabela `notes` só do dono rodando no Supabase, com RLS e um client tipado. Requer Node.js 20 ou mais recente.

## Instalação {#install}

::: code-group

```bash [npm]
npm install -D accessnexus
npm install @supabase/supabase-js
npm install -D pg
```

```bash [pnpm]
pnpm add -D accessnexus
pnpm add @supabase/supabase-js
pnpm add -D pg
```

```bash [yarn]
yarn add -D accessnexus
yarn add @supabase/supabase-js
yarn add -D pg
```

:::

| Pacote | Para quê |
| --- | --- |
| `accessnexus` | CLI e builders de schema |
| `@supabase/supabase-js` | Usado pelo SDK gerado (peer dependency opcional) |
| `pg` | Só é necessário para `push`, `seed` e `init --db-url` (peer dependency opcional) |

Os arquivos de schema, config e seed são empacotados com o esbuild, que já vem com o `accessnexus`. Você não precisa de `tsx` nem `ts-node`.

## Inicialização {#initialize}

```bash
npx accessnexus init --yes
```

`--yes` aceita os padrões e nunca faz perguntas, que é o que você quer no CI ou num agente de código. Sem TTY, o `init` se recusa a rodar sem essa flag (`INIT_NOT_INTERACTIVE`). Numa pasta sem `package.json`, ele cria um mínimo antes.

Num projeto Node simples, a saída é:

```
⬡ AccessNexus init

  ✓ Created a minimal package.json (no project found)
  → Detecting project...
  ✓ Framework: Node.js / other (no frontend framework detected)
  ✗ @supabase/supabase-js not found
  → Skipping — install later with `npm install @supabase/supabase-js`

  → No database URL or Supabase service key found — writing a template schema (pass --db-url <url> to import an existing database)


  ✓ accessnexus.schema.ts created
  → SDK generation skipped (no tables defined yet)
  → Edit accessnexus.schema.ts then run: npx accessnexus generate

  Framework files:
  ✓ lib/accessnexus/index.ts

  ✓ accessnexus.config.ts created
  ✓ Added "accessnexus" script to package.json
  ✓ AGENTS.md created (AccessNexus block for coding agents)

✓ AccessNexus initialized!
```

### Arquivos criados {#files-created}

| Arquivo | Dono | Função |
| --- | --- | --- |
| `accessnexus.schema.ts` | Você | A fonte única da verdade para tabelas e regras de acesso |
| `accessnexus.config.ts` | Você | Pastas de saída, prefixo das policies, variável de ambiente da URL do banco |
| `lib/accessnexus/index.ts` | Você | Wrapper do client; o `generate` nunca mexe nele. No Next.js são `server.ts` + `browser.ts` |
| `AGENTS.md` | Compartilhado | Um bloco marcado do AccessNexus para agentes de código (pule com `--no-agents`) |
| `package.json` | Você | Ganha um script `accessnexus` (`accessnexus generate`) |

O `init` detecta Next.js, Vite e CRA, escreve os wrappers de client correspondentes e reaproveita um client do Supabase existente quando encontra um. Para importar um banco existente em vez de partir do template, veja [Adotando um projeto existente](/pt/guide/existing-project).

## Defina uma tabela {#define-a-table}

Substitua o template por uma tabela só do dono: cada usuário logado vê e edita apenas as próprias notas.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    indexes: [{ columns: ['user_id'] }],
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

- `'timestamptz?'` é nullable; todas as outras colunas são `NOT NULL`.
- Uma primary key `uuid` tem `gen_random_uuid()` como padrão.
- `policy.isOwner('user_id')` compila para `(SELECT auth.uid()) = user_id`.

::: warning Nomes de coluna nas policies não são checados pelo TypeScript
O TypeScript aceita `policy.isOwner('usr_id')`. Quem pega isso é o `validate` (`UNKNOWN_COLUMN`), então rode-o depois de cada edição no schema.
:::

## Valide {#validate}

```bash
npx accessnexus validate
```

```
⬡ AccessNexus validating...

  ✓ Config loaded: accessnexus.config.ts
  ✓ Schema is valid — 1 tables (manual mode)

  notes (5 columns, RLS: select/insert/update/delete)
```

Os erros param aqui, com um caminho e uma dica de correção para cada problema. Veja [Solução de problemas](/pt/guide/troubleshooting).

## Pré-visualize com diff {#preview-with-diff}

Rode o `diff` **antes** do `generate`: ele compara o schema com os arquivos em disco, então logo depois de um `generate` ele vem vazio.

```bash
npx accessnexus diff
```

```
⬡ AccessNexus diff...

  ✓ Config loaded: accessnexus.config.ts
  A added:    6
  M modified: 0
  D removed:  0

  A generated/migrations/.snapshot.json
  ...
```

Cada entrada vem seguida do seu diff unificado. Use `diff --check` no CI: ele sai com `1` quando os arquivos gerados estão desatualizados.

## Gere {#generate}

```bash
npx accessnexus generate
```

```
  Migrations:
  ✓ generated/migrations/20261029213510__init.sql
  ✓ generated/migrations/.snapshot.json

  SQL Policies:
  ✓ generated/policies/notes_rls.sql

  Triggers:
  ✓ generated/triggers/notes_triggers.sql

  Typed SDK:
  ✓ lib/accessnexus/types.ts
  ✓ lib/accessnexus/client.ts

✓ Done! 6 created, 0 updated, 0 unchanged
```

O arquivo de policy é SQL puro, que você pode revisar:

```sql [generated/policies/notes_rls.sql]
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accessnexus_notes_update" ON notes;
CREATE POLICY "accessnexus_notes_update"
  ON notes FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
  );
```

::: danger Não edite arquivos gerados
Tudo em `generated/` e o `client.ts` / `types.ts` do SDK são derivados. Altere o schema e gere de novo. O `push` recusa uma migration já aplicada que foi editada (`MIGRATION_DRIFT`).
:::

## Push {#push}

O `push` é o único comando que mexe no banco. Aponte-o para o seu projeto Supabase com a connection string do **Session pooler** (Dashboard → Connect). Ele roda como o usuário `postgres`, que ignora o RLS, como os helpers gerados exigem.

```bash [.env]
SUPABASE_DB_URL=postgres://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres
```

`.env` e `.env.local` são carregados automaticamente. Você também pode passar `--url` ou definir `ACCESSNEXUS_DB_URL` / `DATABASE_URL`.

Primeiro, um dry run. Ele lista o que seria aplicado e não precisa de banco:

```bash
npx accessnexus push --dry-run
```

```
⬡ AccessNexus push...

  ✓ Config loaded: accessnexus.config.ts
  Adapter: supabase
  Files:   3
  - Migrations: 1
      generated/migrations/20261029213510__init.sql
  - Policies: 1
      generated/policies/notes_rls.sql
  - Triggers: 1
      generated/triggers/notes_triggers.sql

  ✓ Dry run — execution skipped
```

Depois, aplique:

```bash
npx accessnexus push
```

```
  Migrations:
  ✓ generated/migrations/20261029213510__init.sql

  Policies:
  ✓ generated/policies/notes_rls.sql

  Triggers:
  ✓ generated/triggers/notes_triggers.sql

✓ Push complete! Applied 3 SQL file(s), skipped 0.
```

Rodar de novo pula todos os arquivos (`already applied`). O `push` também se recusa a rodar quando o SQL gerado é mais antigo que o schema (`GENERATED_OUT_OF_DATE`) ou quando uma migration pendente apaga dados (`DESTRUCTIVE_MIGRATION`), a menos que você passe `--allow-destructive`.

## Use o SDK {#use-the-sdk}

O wrapper que o `init` escreveu cria um client do Supabase e o passa para o `createAccessNexusClient` gerado. Ajuste nele os nomes das variáveis de ambiente para bater com o seu app.

```ts [app.ts]
import { accessnexus } from './lib/accessnexus/index.js';

export async function addNote(body: string) {
  const { data: auth } = await accessnexus.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');

  // id, created_at e updated_at são opcionais em NotesCreate
  const { data: note, error } = await accessnexus.notes.create({ user_id: auth.user.id, body });
  if (error) throw error;

  const { data: mine } = await accessnexus.notes.findMany();
  return { note, mine };
}
```

Cada tabela ganha `findMany(filter?, options?)`, `findOne(filter, options?)`, `findById(id, options?)`, `create(row)`, `update(id, patch)` e `delete(id)`; `options.columns` seleciona (e tipa) só algumas colunas. `findOne` e `findById` retornam `data: null` sem erro quando nenhuma linha bate. `accessnexus.auth` é o próprio `auth` do client do Supabase, com tipos completos. Os resultados são `{ data, error }`, como no `supabase-js`. O RLS continua valendo: o SDK roda como o usuário logado, então `findMany()` retorna só as notas desse usuário.

::: tip O ciclo típico
Edite o schema e depois `validate` → `diff` → `generate` → `push --dry-run` → `push`. Um agente de código segue o mesmo ciclo com `--json`.
:::

## Próximos passos {#next-steps}

- [Schema](/pt/guide/schema) - tipos de coluna, defaults, referências, índices e soft delete
- [Policies](/pt/guide/policies) - cada builder `policy.*` e o SQL para o qual ele compila
- [Permissões](/pt/guide/permissions) - papéis e acesso multi-tenant com `definePermissions`
- [CLI](/pt/guide/cli) - todos os comandos e flags
