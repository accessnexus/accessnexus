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
| `database` | `--db-url`, ou uma URL em `ACCESSNEXUS_DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` | Tabelas, tipos exatos e defaults das colunas, chaves, estado do RLS, policies, funções, triggers |
| `rest` | Sem URL de banco, mas com uma URL do Supabase e uma secret key em `.env*` | Só tabelas, colunas, primary keys e foreign keys |
| `template` | `--no-introspect`, ou nada encontrado | Um exemplo comentado |

`--db-url` precisa do driver `pg` (`PG_DRIVER_MISSING`) e falha com `DB_CONNECTION_FAILED` depois de 10 s quando o host não responde. Com `--no-introspect`, o `init` nunca conecta.

::: warning Prefira `--db-url` à importação via REST
O REST não consegue ler o RLS. As tabelas importadas ficam sem policies, então o primeiro `push` liga o RLS em todas elas. As policies que já existem no banco são reportadas como estranhas (veja abaixo), e uma tabela que estava com o RLS desligado vira deny-all até você adicionar policies ou `enableRLS: false`.
:::

## O que é importado {#what-is-imported}

Do schema `public`, usando uma conexão direta:

| Importado | Observações |
| --- | --- |
| Tabelas base e colunas, nulabilidade | Tabelas de sistema como `spatial_ref_sys` são puladas |
| Tipos de coluna | Exatos quando o AccessNexus tem o tipo: `numeric(10,2)`, `numeric`, `smallint`, `varchar`, enums como `"enum('a','b')"`, `text[]` / `int[]` / `uuid[]`. O resto vira `text` com um comentário `// WARNING:` |
| Defaults de coluna | Como `default` (`now()`, `0`, `'{}'::text[]`). `serial` / `nextval(...)` vira `serial`; um literal de enum perde o cast para o nome antigo do tipo |
| Primary key | Uma coluna como `primaryKey`, várias como `compositePrimaryKey: ['a', 'b']` |
| Foreign keys | Como `references`, inclusive para outros schemas (`'auth.users.id'`), com o `ON DELETE` em `onDelete`. FKs de várias colunas viram um comentário `// WARNING:` |
| Constraints unique | Uma coluna: `unique: true`. Várias colunas: `indexes: [{ columns: [...], unique: true }]` |
| RLS ligado ou desligado | Desligado vira um `enableRLS: false` explícito |
| Policies (`pg_policies`) | Traduzidas de forma fail-closed, veja abaixo |
| Funções (`pg_proc`) | Não as funções de trigger, nem as que pertencem a uma extensão. Os defaults dos parâmetros são mantidos |
| Triggers (`pg_trigger`) | Triggers do usuário como `trigger.custom`, veja abaixo. Triggers com nome `<prefix>_...` (criados pelo AccessNexus) são pulados |

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
- Os defaults dos parâmetros são mantidos: `p_limit integer DEFAULT 20` vira `p_limit: { type: 'int', default: '20' }`, então o `CREATE OR REPLACE` bate com a função existente (o Postgres se recusa a substituir uma função removendo seus defaults).
- Nomes com underscore no início (`_pix_crc16`) são válidos.
- Overloads: só o primeiro é mantido; os outros viram um comentário.

### Como os triggers são traduzidos {#how-triggers-are-translated}

Cada trigger do usuário vira um `trigger.custom({ name, events, forEach, when, security, functionBody })` com o corpo da sua função (`pg_proc.prosrc`):

- `BEFORE` / `AFTER`, `INSERT` / `UPDATE` / `DELETE`, `FOR EACH ROW` / `STATEMENT`, a condição `WHEN` e o `SECURITY DEFINER` são mantidos.
- `UPDATE OF col` num trigger de linha que só trata UPDATE vira `when: 'OLD.col IS DISTINCT FROM NEW.col'`; senão ele dispara em todo UPDATE e um `// WARNING:` avisa.
- Não importados, com um comentário `// WARNING:` e o `CREATE TRIGGER` original: triggers que passam argumentos (`TG_ARGV`), triggers desabilitados, `INSTEAD OF` e os só de `TRUNCATE`, e funções que não são `plpgsql`. Um constraint trigger é importado como trigger comum, com um aviso.

O `push` cria o trigger como `<prefix>_<table>_<name>`, com uma função própria. No mesmo banco, o trigger original continua existindo, então o `push` recusa com `FOREIGN_TRIGGERS` até você passar `--replace-foreign-triggers` (veja abaixo).

## O que revisar antes do primeiro `generate` {#what-to-review-before-the-first-generate}

Corrija isto **antes** de rodar o `generate` pela primeira vez. A primeira migration usa `CREATE TABLE IF NOT EXISTS`, então as declarações nela não mexem em tabelas existentes. Depois disso, as mesmas edições viram migrations de `ALTER`.

- **Comentários `// WARNING:`**: cada um aponta algo que a importação não conseguiu expressar (um tipo desconhecido ou de array importado como `text`, uma coluna gerada, uma FK de várias colunas, um trigger deixado de fora). Corrija o tipo ou recrie o objeto à mão.
- **Enums**: o AccessNexus cria um tipo enum próprio por coluna (`<table>_<column>_enum`). No banco existente a coluna mantém o tipo dela; funções que fazem cast para o nome antigo continuam funcionando ali, mas não num banco novo.
- **Tamanhos e precisões sem tipo no AccessNexus**: `varchar(20)` vira `varchar`, `real` vira `float` (um comentário avisa).
- **Não importados**: constraints `CHECK`, índices não únicos, views. Eles continuam no banco; adicione-os ao schema se quiser que sejam rastreados.
- **Policies em `policy.custom()`**: troque por builders semânticos quando possível e use o wrapper nas chamadas de auth (o `validate` avisa `UNWRAPPED_AUTH_CALL`).
- **Comentários `TODO`** de policies só para anon, e todo `enableRLS: false`.

Depois rode `npx accessnexus validate` até ficar limpo.

## O primeiro push seguro {#the-safe-first-push}

Depois do `init`, as policies originais continuam no banco. O Postgres combina policies permissivas com OR, então uma policy original continuaria concedendo acesso ao lado das geradas, diga o schema o que disser. Por isso o `push` nunca as mantém em silêncio, e também nunca as remove em silêncio: ele lê `pg_policies` de cada tabela que o schema gerencia e recusa com `FOREIGN_POLICIES` enquanto houver ali uma policy cujo nome não é `<prefix>_<table>_<op>`.

1. `npx accessnexus generate`, e depois leia o que ele escreveu:
   - `__init.sql`: `CREATE TABLE IF NOT EXISTS` (não faz nada em tabelas existentes), `CREATE INDEX IF NOT EXISTS` nas colunas de foreign key e de policy (índices novos), tipos enum se faltarem.
   - `policies/*.sql`: `ENABLE` + `FORCE ROW LEVEL SECURITY` e policies com nome `<prefix>_<table>_<op>`.
   - `triggers/*.sql`: os triggers importados, como `<prefix>_<table>_<name>`.
   - `rpcs.sql`: `CREATE OR REPLACE` das funções importadas.
2. `npx accessnexus push --dry-run --json` com a URL do banco definida: `destructive` precisa estar vazio, e `foreignPolicies` lista cada policy original de uma tabela gerenciada (`wouldRefuse: true`). O dry run só lê.
3. Compare cada policy listada com a regra que o `init` gerou para ela (cada regra tem um comentário com o nome da policy de origem). Leve para o `accessnexus.schema.ts` o que ainda faltar e rode o `generate` de novo.
4. Em staging: `npx accessnexus push --replace-foreign-policies`. Numa única transação ele remove as policies listadas (`droppedPolicies` no `--json`), aplica as migrations, as policies geradas, os triggers e as RPCs, e registra tudo. Se algo falhar, tudo sofre rollback, inclusive as remoções: o banco fica como estava.
5. Teste o app como usuários reais (anon, logado, outros tenants). Depois repita as etapas 2 e 4 em produção.

Depois desse push, só as policies geradas existem nas tabelas gerenciadas, então o schema passa a ser a fonte da verdade.

::: danger Remova as originais só depois de revisar, e com consentimento
O `--replace-foreign-policies` apaga policies que o AccessNexus não escreveu. Passe a flag só depois da etapa 3. Se um agente estiver no controle, ele precisa mostrar a lista do `FOREIGN_POLICIES` e perguntar antes de passar a flag.

Com os triggers importados é igual: o original dispararia junto com a cópia gerada (um `updated_at` duas vezes não faz mal, um insert de auditoria ou um contador faz), então o `push` recusa com `FOREIGN_TRIGGERS` e lista quais são. Depois de revisar as entradas `trigger.custom` importadas, `npx accessnexus push --replace-foreign-triggers` remove os originais na mesma transação.

Se um agente estiver no controle, ele precisa perguntar antes de remover qualquer coisa.
:::

## Veja também {#related}

- [CLI](/pt/guide/cli): flags do `init`
- [Modelo de segurança](/pt/guide/security)
- [Solução de problemas](/pt/guide/troubleshooting)
- [Limites e roadmap](/pt/guide/limits)
