# Projetos existentes

Você pode adotar um projeto Supabase que já tem tabelas, policies e funções. O `init` lê o banco e escreve um `accessnexus.schema.ts` que o reproduz. Você revisa esse arquivo, e o primeiro `push` muda o mínimo possível.

## Antes de começar {#before-you-start}

```bash
npm install -D accessnexus pg
```

- Pegue a connection string do **Session pooler** (Dashboard, Connect). Ela conecta como `postgres`, que tem o `BYPASSRLS` de que o `push` precisa.
- Faça um backup e, se puder, ensaie antes numa cópia de staging ou num banco de branch.

## Rode o `init` {#run-init}

```bash
npx accessnexus init --yes --db-url "$SUPABASE_DB_URL"
```

### Detecção de framework {#framework-detection}

| Detectado no `package.json` | Arquivos de wrapper escritos na pasta do SDK |
| --- | --- |
| `next` com uma pasta `app/` (ou `src/app/`) | `server.ts` + `browser.ts` (App Router, `@supabase/ssr`) |
| `next` sem `app/` | `server.ts` + `browser.ts` (Pages Router) |
| `vite` + `react`, só `vite`, `react-scripts`, outro React | `index.ts` |
| qualquer outra coisa | `index.ts` (client Node simples) |

### Reaproveitando seu client do Supabase {#reusing-your-supabase-client}

O `init` procura um client existente em `src/` e na raiz do projeto: `lib/supabase/server`, `utils/supabase/server`, `lib/supabase-server` (lado do servidor) e `lib/supabase/client`, `utils/supabase/client`, `lib/supabase/browser`, `lib/supabaseClient`, `lib/supabase`, `supabaseClient` (lado do browser), com `.ts`, `.tsx`, `.js` ou `.jsx`. Ele reconhece uma factory exportada `createClient` / `createBrowserClient` / `createServerClient` / `createSupabase*`, ou uma instância exportada `supabase`, `client` ou `db`. Quando encontra uma, o wrapper a importa em vez de criar um segundo client. Os arquivos de wrapper são seus para editar; o `generate` nunca mexe neles.

### De onde vem o schema {#where-the-schema-comes-from}

| `schemaSource` | Quando | O que é importado |
| --- | --- | --- |
| `database` | `--db-url`, ou uma URL em `ACCESSNEXUS_DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` | Tabelas, colunas, chaves, estado do RLS, policies, funções |
| `rest` | Sem URL de banco, mas com uma URL do Supabase e uma secret key em `.env*` | Só tabelas, colunas, primary keys e foreign keys |
| `template` | `--no-introspect`, ou nada encontrado | Um exemplo comentado |

`--db-url` precisa do driver `pg` (`PG_DRIVER_MISSING`) e falha com `DB_CONNECTION_FAILED` depois de 10 s quando o host não responde. Com `--no-introspect`, o `init` nunca conecta.

::: warning Prefira `--db-url` à importação via REST
O REST não consegue ler o RLS. As tabelas importadas ficam sem policies, então o primeiro `push` liga o RLS em todas elas. As policies que já existem no banco continuam, mas uma tabela que estava com o RLS desligado vira deny-all até você adicionar policies ou `enableRLS: false`.
:::

## O que é importado {#what-is-imported}

Do schema `public`, usando uma conexão direta:

| Importado | Observações |
| --- | --- |
| Tabelas base e colunas, nulabilidade | Tabelas de sistema como `spatial_ref_sys` são puladas |
| Tipos de coluna | Mapeados para tipos do AccessNexus; qualquer coisa desconhecida vira `text` |
| Primary key | Uma coluna (veja a lista de revisão) |
| Foreign keys entre tabelas do `public` | Como `references` |
| Constraints unique | Como `unique: true` por coluna |
| RLS ligado ou desligado | Desligado vira um `enableRLS: false` explícito |
| Policies (`pg_policies`) | Traduzidas de forma fail-closed, veja abaixo |
| Funções (`pg_proc`) | Não as funções de trigger, nem as que pertencem a uma extensão |

### Como as policies são traduzidas {#how-policies-are-translated}

A importação nunca concede mais do que o banco concedia:

- Policies permissivas de uma operação são combinadas com OR (`policy.any`); as RESTRICTIVE entram com AND (`policy.all`), aplicadas a todo usuário da API.
- Policies `FOR ALL` são expandidas para as quatro operações.
- Policies para roles que não são da API (`TO service_role`, ...) são puladas; a service role ignora o RLS de qualquer forma.
- `TO authenticated` acrescenta a exigência de estar logado.
- Uma policy concedida só a `anon` não pode ser expressa: vira um comentário `TODO` e a operação continua negada.
- RLS ligado sem policies vira `policy.none()` em todas as operações.
- Um UPDATE cujo `WITH CHECK` difere do `USING` vira `policy.withCheck(using, check, { mode: 'replace' })`.
- `true`, `false`, `auth.uid() IS NOT NULL` e `auth.uid() = col` viram `policy.public()`, `policy.none()`, `policy.isAuthenticated()` e `policy.isOwner('col')`. Todo o resto é mantido literalmente em `policy.custom()`. `auth.jwt() ->> 'role'` nunca é mapeado para `hasRole`, que lê outra claim.

Cada regra leva um comentário com o nome da policy de origem:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
    },
    primaryKey: 'id',
    policies: {
      // TODO: "anon peek" (PERMISSIVE, SELECT, TO anon) grants anonymous users only, which AccessNexus cannot express — skipped (access denied); add it back by hand if needed
      // from "own notes" (PERMISSIVE, ALL, TO authenticated)
      // "svc" (PERMISSIVE, SELECT, TO service_role): skipped — it does not apply to API users (service_role bypasses RLS anyway)
      select: policy.isOwner('user_id'),
      // from "own notes" (PERMISSIVE, ALL, TO authenticated)
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

### Como as funções são traduzidas {#how-functions-are-translated}

- Argumentos e tipo de retorno escalares: um `rpc({ args, returns, language, security, body })` completo. O `push` a recria com um `search_path` fixado; uma função definer perde o `EXECUTE` para `anon`, a menos que você adicione `allowAnon: true`.
- `SETOF`, `TABLE(...)` ou tipos compostos: um marcador `rpc()` só com a assinatura. A função continua como está no banco.
- Overloads: só o primeiro é mantido; os outros viram um comentário.

## O que revisar antes do primeiro `generate` {#what-to-review-before-the-first-generate}

Corrija isto **antes** de rodar o `generate` pela primeira vez. A primeira migration usa `CREATE TABLE IF NOT EXISTS`, então as declarações nela não mexem em tabelas existentes. Depois disso, as mesmas edições viram migrations de `ALTER`.

- **Referências a `auth.users`** (e a qualquer outra tabela fora do `public`) não são importadas. Adicione-as: `references: { user_id: 'auth.users.id' }`. O seed e o `include` do SDK dependem delas.
- **Primary keys compostas** saem como uma única coluna, e **constraints unique compostas** saem como `unique: true` em cada coluna. Corrija a chave e expresse a composição com `indexes: [{ columns: ['org_id', 'user_id'], unique: true }]`.
- **Tipos**: enums, arrays e tipos desconhecidos viram `text`; `numeric` vira `float`. Use `"enum('a','b')"`, `'text[]'`, `'decimal'`.
- **Não importados**: defaults, constraints `CHECK`, índices não únicos, ações `ON DELETE`, triggers, views. Eles continuam no banco; adicione-os ao schema se quiser que sejam rastreados.
- **Policies em `policy.custom()`**: troque por builders semânticos quando possível e use o wrapper nas chamadas de auth (o `validate` avisa `UNWRAPPED_AUTH_CALL`).
- **Comentários `TODO`** de policies só para anon, e todo `enableRLS: false`.

Depois rode `npx accessnexus validate` até ficar limpo.

## O primeiro push seguro {#the-safe-first-push}

1. `npx accessnexus generate`, e depois leia o que ele escreveu:
   - `__init.sql`: `CREATE TABLE IF NOT EXISTS` (não faz nada em tabelas existentes), `CREATE INDEX IF NOT EXISTS` nas colunas de foreign key e de policy (índices novos), tipos enum se faltarem.
   - `policies/*.sql`: `ENABLE` + `FORCE ROW LEVEL SECURITY` e policies com nome `<prefix>_<table>_<op>`.
   - `rpcs.sql`: `CREATE OR REPLACE` das funções importadas.
2. `npx accessnexus push --dry-run`: a lista de statements destrutivos precisa estar vazia.
3. `npx accessnexus push` em staging, teste o app, depois em produção.

Depois desse push, existem tanto as policies originais quanto as geradas. O `push` nunca remove policies que ele não criou, e o Postgres combina policies permissivas com OR, então o acesso efetivo é a união. Como a importação nunca concede mais, essa união é igual ao que você já tinha.

::: danger Remova as originais só depois de revisar, e com consentimento
Enquanto as policies originais não forem removidas, o schema não é a fonte da verdade: uma policy permissiva antiga continua concedendo acesso, diga o schema o que disser. Quando o app estiver funcionando com as policies geradas, liste as originais e remova-as de forma deliberada:

```sql
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public' AND policyname NOT LIKE 'accessnexus\_%';

DROP POLICY "own notes" ON notes;
```

Se um agente estiver no controle, ele precisa perguntar antes de remover qualquer coisa.
:::

## Veja também {#related}

- [CLI](/pt/guide/cli): flags do `init`
- [Modelo de segurança](/pt/guide/security)
- [Solução de problemas](/pt/guide/troubleshooting)
- [Limites e roadmap](/pt/guide/limits)
