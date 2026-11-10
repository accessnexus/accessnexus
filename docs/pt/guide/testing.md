# Testando RLS {#testing-rls}

O `validate` prova que o schema está bem formado; ele não prova que uma policy bloqueia o que deveria. Para isso, rode SQL como usuários reais da API contra um Postgres de verdade e confira como o RLS responde. O AccessNexus traz as duas peças:

- `accessnexus test-db up | down`: um Postgres Supabase local descartável no Docker, preparado para testes de RLS.
- `accessnexus/testing`: um kit pequeno (`asUser`, `asAnon`, `sqlState`, `affectedRows`, `expectDenied`) que age como um usuário da API dentro de uma transação que sempre sofre rollback.

::: warning Atenção
Nunca aponte os testes para um projeto hospedado. O kit é para o banco descartável que o `test-db` cria (ou um que você montou do mesmo jeito).
:::

## Suba o banco de teste {#start-the-test-database}

```bash
npx accessnexus test-db up --push   # sobe o container e faz o push do seu schema
npx accessnexus test-db down        # remove o container
```

O `up` sobe o `ghcr.io/supabase/postgres` na porta `55439` (`--port`, `--name` e `--image` mudam isso) e imprime a URL, `postgres://postgres:postgres@127.0.0.1:55439/postgres`. Ele prepara o banco do jeito que um projeto Supabase se comporta para RLS: `auth.uid()` e `auth.jwt()` leem os claims do JWT da requisição (como os do GoTrue), `auth.users` tem `email_confirmed_at`, a role `authenticator` consegue logar e `realtime.messages` existe. O `--push` também roda o [`push`](/pt/api/cli#push) nele, então as tabelas, policies, triggers e RPCs são as que o seu schema gera. O Docker precisa estar instalado (`DOCKER_NOT_FOUND`), e a porta e o nome do container precisam estar livres (`TEST_DB_START_FAILED`).

## Escreva os testes {#write-the-tests}

Instale o driver `pg` (`npm install -D pg`) e o seu test runner. Crie as fixtures como o usuário `postgres`, que ignora o RLS (inclusive as linhas de `auth.users` para as quais suas foreign keys apontam), e rode cada checagem como um usuário da API:

```ts
import pg from 'pg';
import { asAnon, asUser, affectedRows, expectDenied, sqlState } from 'accessnexus/testing';

const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55439/postgres' });
const ALICE = { id: '00000000-0000-4000-8000-000000000001', email: 'alice@test.dev' };

export async function checks() {
  // Fixtures as `postgres` (bypasses RLS): pool.query('INSERT ...').
  await asUser(pool, ALICE, async (db) => {
    // Every check runs as the API user, in a transaction that is always rolled back.
    const insert = await sqlState(db, 'INSERT INTO notes (owner_id, body) VALUES ($1, $2)', [ALICE.id, 'x']); // 'ok' | '42501' | ...
    const hidden = await expectDenied(db, 'DELETE FROM notes WHERE owner_id <> $1', [ALICE.id]); // { denied: true, by: 'no_rows' }
    const changed = await affectedRows(db, 'UPDATE notes SET body = $1 WHERE owner_id = $2', ['y', ALICE.id]);
    return { insert, hidden, changed };
  });
  await asAnon(pool, async (db) => (await db.query('SELECT count(*) FROM notes')).rows);
}
```

Com um test runner, as checagens viram asserções:

```ts
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { asUser, expectDenied, sqlState } from 'accessnexus/testing';

const pool = new pg.Pool({ connectionString: process.env.ACCESSNEXUS_TEST_DB_URL });
const ALICE = { id: '00000000-0000-4000-8000-000000000001', email: 'alice@test.dev' };
const BOB = { id: '00000000-0000-4000-8000-000000000002', email: 'bob@test.dev' };

describe('notes', () => {
  it('lets the owner write their own rows', async () => {
    const state = await asUser(pool, ALICE, (db) => sqlState(db, 'INSERT INTO notes (owner_id, body) VALUES ($1, $2)', [ALICE.id, 'x']));
    expect(state).toBe('ok');
  });

  it('refuses a row attributed to someone else', async () => {
    const result = await asUser(pool, BOB, (db) => expectDenied(db, 'INSERT INTO notes (owner_id, body) VALUES ($1, $2)', [ALICE.id, 'x']));
    expect(result).toEqual({ denied: true, by: 'error', sqlState: '42501' });
  });
});
```

## O kit {#the-kit}

Tudo isto vem de `accessnexus/testing`. `db` é um client do `pg` (ou qualquer coisa com `query`) passado ao seu callback.

| Export | Assinatura | O que faz |
| --- | --- | --- |
| `asUser` | `(pool, user, fn) => Promise<T>` | Roda `fn(db)` como `user`: `SET LOCAL ROLE authenticated` e os claims do JWT em `request.jwt.claims` (`sub`, `email`, `app_metadata.role` a partir de `appRole`, mais quaisquer `claims`), como o PostgREST faz. Tudo roda numa transação que **sempre sofre rollback**, então os testes nunca veem as escritas uns dos outros. |
| `asAnon` | `(pool, fn) => Promise<T>` | O mesmo como um visitante anônimo (`ROLE anon`); é `asUser(pool, null, fn)`. |
| `sqlState` | `(db, sql, params?) => Promise<string>` | O SQLSTATE com que o comando falha, ou `'ok'`. Usa um savepoint, então um comando negado não aborta o teste. |
| `affectedRows` | `(db, sql, params?) => Promise<number>` | Linhas que o comando afetou. Um UPDATE ou DELETE em linhas que o RLS esconde afeta `0`, em silêncio. |
| `expectDenied` | `(db, sql, params?) => Promise<Denial>` | Afirma que o comando foi recusado, em qualquer das formas com que o RLS recusa: um erro (`{ denied: true, by: 'error', sqlState }`) ou zero linhas (`{ denied: true, by: 'no_rows' }`). Lança erro quando o comando teve sucesso e alterou linhas. Envolto em savepoint, e desfaz o comando nos dois casos. |
| `TEST_DB_STANDINS_SQL` | `string` | O SQL de preparação que o `test-db up` roda, para os seus próprios containers (veja abaixo). |

`TestUser` é `{ id: string; email?: string; appRole?: string; claims?: Record<string, unknown> }`. O `appRole` vira `app_metadata.role`, que é o que o [`policy.hasRole`](/pt/api/policy#hasrole) e os arrays de papéis leem; `claims` são mesclados no JWT.

Use `expectDenied` para tudo o que precisa ser recusado: ele cobre as duas formas com que o RLS diz não, então o teste não depende de qual cláusula recusa.

## Como uma negação aparece {#how-a-denial-shows}

O RLS recusa um comando de uma de duas formas, conforme a cláusula, e algumas guardas lançam erros próprios. Saber qual é qual define como você afirma isso:

| Comando | Cláusula do RLS que recusa | O que quem chamou recebe |
| --- | --- | --- |
| `INSERT` | `WITH CHECK` | erro `42501` (`new row violates row-level security policy`) |
| `UPDATE`, linha escondida pelo `USING` | `USING` | sem erro, 0 linhas |
| `UPDATE`, linha nova falha no `WITH CHECK` | `WITH CHECK` | erro `42501` |
| `DELETE`, linha escondida ou que não pode ser apagada | `USING` | sem erro, 0 linhas |
| `SELECT` | `USING` | a linha simplesmente não volta |
| [`trigger.lockColumns`](/pt/api/trigger#lockcolumns) | trigger | erro `42501`, HINT `accessnexus:locked_column:<table>.<column>` |
| [`sameTenant`](/pt/api/trigger#sametenant) / [`memberOfTenant`](/pt/api/trigger#memberoftenant) | trigger | erro `23503` |
| [`keepAtLeastOne`](/pt/api/trigger#keepatleastone) | trigger | erro `23514` |

No app, o SDK gerado transforma os casos de 0 linhas de `update(id)`, `delete(id)`, `updateOne` e `deleteOne` no erro `ACCESSNEXUS_NOT_FOUND_OR_DENIED`; veja [Erros do SDK](/pt/api/sdk#errors).

## O seu próprio container {#your-own-container}

O `test-db` é o caminho mais curto. Se você roda o Postgres de outro jeito (um service container de CI, o seu próprio compose), suba uma imagem `supabase/postgres` e rode o `TEST_DB_STANDINS_SQL` como `supabase_admin`, depois faça o `push` nela:

```ts
import { TEST_DB_STANDINS_SQL } from 'accessnexus/testing';

// psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < the SQL below
export const preparationSql: string = TEST_DB_STANDINS_SQL;
```

Ele define `auth.uid()` / `auth.jwt()` que leem `request.jwt.claims`, adiciona `auth.users.email_confirmed_at`, dá um login ao `authenticator` e cria substitutos para `realtime.messages` e `realtime.topic()` (um projeto real os recebe do serviço Realtime).

## Uma suíte completa {#a-full-suite}

O `examples/saas-teams/` do repositório é um schema multi-tenant completo (times, papéis, projetos, tarefas, convites) construído com [`definePermissions`](/pt/guide/permissions), os triggers de tenant e o [`tenantInvitations`](/pt/api/tenancy#tenantinvitations). A suíte de RLS dele, `src/__tests__/saas-teams.integration.test.ts`, faz o push desse schema num Postgres real e confere, como usuários reais da API, quem pode ler, escrever, mover, convidar e apagar o quê. É o modelo para copiar: uma tabela de usuários com papéis diferentes, fixtures criadas como `postgres` e um `it` por regra que precisa valer, escrito com o kit acima.
