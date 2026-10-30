# Seed

Um arquivo de seed coloca linhas conhecidas num banco de desenvolvimento: alguns usuários, uma org, alguns projetos, para o app ter algo para mostrar e o RLS ter algo para filtrar. O AccessNexus transforma isso em SQL de upsert e executa tudo numa única transação.

O seed nunca roda sozinho. Ele só roda quando você chama `accessnexus seed` ou `accessnexus push --seed`.

## Escreva o arquivo de seed {#write-the-seed-file}

O caminho padrão é `./accessnexus.seed.ts` (mude com `seed` no `accessnexus.config.ts`, ou com `--seed <path>` no comando `seed`). Exporte por padrão `defineSeed(...)`.

::: code-group

```ts [Modo manual]
// accessnexus.seed.ts
import { defineSeed } from 'accessnexus';
import schema from './accessnexus.schema.js';

export default defineSeed(schema, {
  profiles: [
    { id: '00000000-0000-0000-0000-000000000001', name: 'Admin' },
  ],
});
```

```ts [Modo Database]
// accessnexus.seed.ts
import { defineSeed } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSeed<Database>({
  profiles: [
    { id: '00000000-0000-0000-0000-000000000001', name: 'Admin' },
  ],
});
```

:::

| Overload | O que o TypeScript checa |
| --- | --- |
| `defineSeed(schema, data)` (modo manual) | Só os nomes das tabelas. As linhas são objetos simples: uma coluna com nome errado aparece como erro do Postgres quando o seed roda. Confira antes com `seed --dry-run`. |
| `defineSeed<Database>(data)` (modo Database) | Nomes das tabelas e cada linha, contra o tipo `Insert` da tabela. |

Use UUIDs fixos nas primary keys e em todo id para o qual outras linhas apontam. É isso que torna o seed repetível e permite que as linhas se referenciem.

## Rode o seed {#run-it}

```bash
npx accessnexus seed --dry-run      # imprime o SQL, sem precisar de banco
npx accessnexus seed                # roda contra o banco
npx accessnexus push --seed         # faz o push do schema e depois o seed
```

A URL do banco é resolvida como no `push`: `--url`, depois `adapterOptions.dbUrlEnv` (do `--target`, se informado), depois `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL`, `DATABASE_URL`. `.env` e `.env.local` são carregados. O seed precisa do driver `pg` (`npm install -D pg`).

As tabelas são inseridas na ordem das foreign keys, então uma linha pode referenciar linhas de outra tabela no mesmo seed. Rode o seed depois do `push`: as tabelas precisam existir.

## Usuários do seed em `auth.users` {#seeded-users-in-auth-users}

Muitas linhas apontam para usuários: `profiles.id`, `projects.owner_id`. Para cada valor numa coluna cuja referência é `auth.users.id`, o seed primeiro cria esse usuário em `auth.users`:

- com o email da coluna `email` da linha, se ela tiver uma;
- com o email já confirmado;
- com uma **senha aleatória e impossível de descobrir** (bcrypt de 24 bytes aleatórios);
- com `ON CONFLICT (id) DO NOTHING`, então um usuário existente fica intacto.

Para entrar localmente como os usuários do seed, escolha a senha pelo ambiente:

```bash
ACCESSNEXUS_SEED_PASSWORD='local-dev-only' npx accessnexus seed
```

A senha só vale quando um usuário é criado. Rodar o seed de novo com outro valor não muda a senha de usuários que já existem.

::: warning Declare a referência no mapa `references` da tabela
Na v0.1.6, o seed encontra as colunas de usuário pelo mapa no nível da tabela, `references: { owner_id: 'auth.users.id' }`. Uma referência escrita na forma de objeto da coluna (`owner_id: { type: 'uuid', references: 'auth.users.id' }`) cria a mesma foreign key, mas o seed não provisiona esse usuário, e o insert falha com erro de foreign key. Use o mapa no nível da tabela para as colunas do seed. No modo Database, adicione `references` à entrada da tabela pelo mesmo motivo.
:::

::: danger Nunca defina uma senha fixa de seed num banco acessível
`ACCESSNEXUS_SEED_PASSWORD` cria contas em que qualquer pessoa que saiba a senha consegue entrar. Use só num banco local (`supabase start`). Sem ela, os usuários do seed têm senhas que ninguém conhece.
:::

## Projetos hospedados são recusados por padrão {#hosted-projects-are-refused-by-default}

Seeds são para bancos locais e descartáveis. `seed` e `push --seed` recusam um host Supabase hospedado (`*.supabase.co`, `*.supabase.com`) com `SEED_REMOTE_BLOCKED`:

```
✗ Refusing to seed a hosted Supabase database (postgresql://postgres.abc:***@aws-0-eu-central-1.pooler.supabase.com:5432/postgres) [SEED_REMOTE_BLOCKED]
```

Passe `--allow-remote-seed` só para um projeto que você pode jogar fora (uma preview branch, uma cópia de staging). Com `push --seed`, a checagem roda antes de qualquer SQL ser aplicado, então um seed recusado também significa que nada foi enviado.

## Rodar de novo é seguro {#re-running-is-safe}

Cada linha vira um upsert na primary key da tabela:

```sql
INSERT INTO "projects" ("id", "org_id", "name") VALUES ('3000...', '1000...', 'Website Redesign')
  ON CONFLICT ("id") DO UPDATE SET "org_id" = EXCLUDED."org_id", "name" = EXCLUDED."name";
```

Então, numa segunda execução:

- linhas que faltam são criadas;
- as colunas que você listou voltam aos valores do seed (as outras colunas mantêm os valores atuais);
- nenhuma linha é apagada, nem as que você tirou do arquivo de seed;
- triggers de `UPDATE` disparam nas linhas existentes (`updated_at` muda, `trigger.auditLog` grava novas entradas).

Uma tabela sem `primaryKey` no schema recebe upsert por `id`.

::: tip Triggers rodam durante o seed
O seed é SQL comum executado com a role do push, então todo trigger dispara. Se um trigger já cria uma linha (por exemplo, um trigger AFTER INSERT que adiciona o criador de um time como seu primeiro owner), não inclua essa linha no seed também: o segundo insert esbarra no índice único e o seed inteiro falha.
:::

## Quando falha {#when-it-fails}

O seed inteiro roda numa única transação. Se o Postgres rejeitar qualquer statement, nada do seed é mantido, e a CLI sai com código 1:

| Código | Significado | Correção |
| --- | --- | --- |
| `SEED_NOT_FOUND` | Não há arquivo de seed no caminho | Crie `accessnexus.seed.ts`, passe `--seed <path>` ou defina `seed` na config |
| `SEED_EMPTY` | O arquivo não exporta nenhuma linha | Exporte por padrão `defineSeed(schema, { table: [rows] })` |
| `SEED_LOAD_FAILED` | O arquivo lançou um erro ao carregar, ou importa um pacote que não existe | Corrija o arquivo ou o import indicado |
| `SEED_FAILED` | O Postgres rejeitou um statement (mensagem incluída); o seed sofreu rollback | Confira se o `push` rodou, se as colunas existem e se nenhuma chave única colide |
| `SEED_REMOTE_BLOCKED` | Host Supabase hospedado | Use um banco local, ou `--allow-remote-seed` para um descartável |
| `DB_URL_MISSING`, `PG_DRIVER_MISSING`, `DB_CONNECTION_FAILED` | Igual ao `push` | Veja [Solução de problemas](/pt/guide/troubleshooting) |

Com `push --seed`, o push e o seed são etapas separadas. Quando o seed falha, os arquivos SQL já foram aplicados: o resultado JSON mantém `applied[]` e informa `seed.status: "failed"`. Corrija o seed e rode `accessnexus seed`; não precisa fazer o push de novo.

## Veja também {#related}

- [CLI](/pt/guide/cli): flags de `seed` e `push --seed`
- [Referência de `defineSeed` / `defineConfig`](/pt/api/seed-config)
- [Solução de problemas](/pt/guide/troubleshooting)
- [Schema](/pt/guide/schema): `references` e primary keys
