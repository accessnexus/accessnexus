# rpc

Define uma função Postgres, exposta pelo Supabase como RPC e tipada no SDK como `client.rpc.<name>()`. Guia: [RPCs](/pt/guide/rpcs).

```ts
function rpc(config?: {
  args?: Record<string, ColumnType>;
  returns?: RpcReturnType;
  body?: string;
  language?: RpcLanguage;
  security?: RpcSecurity;
  volatility?: RpcVolatility;
  immutable?: boolean; // alias de volatility: 'immutable'
  set?: Record<string, string>;
  allowAnon?: boolean;
}): RpcDef;
```

As RPCs vão no segundo argumento do [`defineSchema`](/pt/api/schema#defineschema): `defineSchema(tables, { rpcs: { name: rpc({...}) } })`. Colocar uma no meio das tabelas é reportado como `RPC_IN_TABLES`. Nomes de RPC precisam ser snake_case em minúsculas (`INVALID_IDENTIFIER`).

## Modos de uso {#usage-modes}

| Chamada | SQL gerado | SDK |
| --- | --- | --- |
| `rpc()` | nenhum | `rpc.<name>(args)` tipado a partir de `Database['public']['Functions']` (Database mode) |
| `rpc({ args, returns })` | nenhum | tipado a partir de `args` / `returns` (a função já existe no banco) |
| `rpc({ args?, returns?, body, ... })` | `CREATE OR REPLACE FUNCTION` em `rpcs.sql` | tipado a partir de `args` / `returns` |

## Opções {#options}

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `args` | `Record<string, ColumnType \| { type, default? }>` | `{}` | Nome do argumento para o tipo, na ordem de declaração. Tipos como em [tipos de coluna](/pt/api/schema#column-types); um `?` no final só afeta o tipo TS. `{ type: 'int', default: '20' }` emite `DEFAULT 20` (SQL cru) e torna o argumento opcional no client; todo argumento depois de um com default também precisa de um. |
| `returns` | `ColumnType \| 'void'` | `'void'` | Tipo de retorno. Omitido: `RETURNS VOID` no SQL, `unknown` no SDK. |
| `body` | `string` | `undefined` | Corpo da função, sem o invólucro `CREATE FUNCTION`. Sem ele, nenhum SQL é gerado. |
| `language` | `'plpgsql' \| 'sql'` | `'plpgsql'` | `LANGUAGE`. |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | `SECURITY INVOKER` ou `SECURITY DEFINER`. |
| `volatility` | `'volatile' \| 'stable' \| 'immutable'` | `'volatile'` | `VOLATILE`, `STABLE` ou `IMMUTABLE`. Use `'stable'` em funções só de leitura chamadas dentro de policies RLS (veja abaixo). |
| `immutable` | `boolean` | `false` | Alias de `volatility: 'immutable'`. Combinar com outra `volatility` é `RPC_VOLATILITY_CONFLICT`. |
| `set` | `Record<string, string>` | `undefined` | Configuração da função: `{ row_security: 'off' }` emite `SET row_security = 'off'`. As chaves precisam ser nomes de parâmetros de configuração (`work_mem`, `myapp.tenant`); os valores são strings emitidas como um único literal entre aspas (senão, `INVALID_FUNCTION_SET`). O `search_path` não pode ser alterado: um valor diferente é ignorado com o aviso `SEARCH_PATH_PINNED`. |
| `allowAnon` | `boolean` | `false` | Só com `security: 'definer'`: mantém o `EXECUTE` para `anon`. |

Tipos de argumento desconhecidos são reportados como `UNKNOWN_COLUMN_TYPE`; um `auth.uid()` sem wrapper no body, como `UNWRAPPED_AUTH_CALL`.

::: tip Volatilidade e RLS
Uma função chamada dentro de uma policy (`policy.custom('is_member(org_id)')`) que é `VOLATILE` é avaliada de novo para cada linha, e o Postgres não consegue transformá-la em initPlan. Declare helpers só de leitura com `volatility: 'stable'` (ou `'immutable'` quando o resultado depende só dos argumentos) para que sejam avaliados uma vez por query.
:::

::: warning
Tipos enum (`"enum('a','b')"`) são aceitos pelo `validate` em `args` e `returns`, mas são emitidos literalmente na assinatura SQL, o que o Postgres rejeita. Use `'text'` e faça o cast dentro do body.
:::

## SQL gerado {#generated-sql}

```sql
CREATE OR REPLACE FUNCTION <name>(<arg> <TYPE>, ...)
RETURNS <TYPE>
LANGUAGE <language>
SECURITY <INVOKER|DEFINER>
<VOLATILE|STABLE|IMMUTABLE>
SET search_path = pg_catalog, public
SET <key> = '<value>'   -- um por entrada de `set`, em ordem de chave
AS $$
<body>
$$;
```

Com `language: 'plpgsql'`, um body que não começa com `DECLARE` ou `BEGIN` é envolvido em `BEGIN ... END;`. Com `language: 'sql'`, ou com um body que começa com `DECLARE` / `BEGIN`, ele é emitido como foi escrito.

## Segurança e grants {#security-and-grants}

| `security` | `allowAnon` | Grants emitidos | Quem pode chamar |
| --- | --- | --- | --- |
| `'invoker'` | ignorado | nenhum | Padrão do Supabase para novas funções públicas (`anon`, `authenticated`, `service_role`). O RLS vale lá dentro. |
| `'definer'` | `false` | `REVOKE EXECUTE ON FUNCTION <name>(<types>) FROM PUBLIC, anon;` `GRANT EXECUTE ... TO authenticated, service_role;` | usuários logados e a service role |
| `'definer'` | `true` | `REVOKE ... FROM PUBLIC;` `GRANT ... TO authenticated, service_role, anon;` | todo mundo |

::: warning
Uma função `SECURITY DEFINER` roda como o seu dono e ignora o RLS. Verifique quem está chamando dentro do body (`(SELECT auth.uid())`, rejeitando `NULL` para chamadas anônimas) e qualifique as tabelas com o schema (`public.todos`). Use `allowAnon: true` só em funções seguras para qualquer um que tenha a anon key.
:::

## Exemplo {#example}

```ts
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  todos: table({
    columns: { id: 'uuid', user_id: 'uuid', done: 'boolean' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
}, {
  rpcs: {
    // Função SQL, invoker: o RLS vale
    count_open_todos: rpc({
      returns: 'int',
      language: 'sql',
      body: 'SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;',
    }),
    // PL/pgSQL com argumento; envolvida em BEGIN ... END
    complete_all: rpc({
      args: { p_user: 'uuid' },
      body: 'UPDATE todos SET done = true WHERE user_id = p_user AND p_user = (SELECT auth.uid());',
    }),
    // Definer: ignora o RLS, então verifica quem chama primeiro
    reset_my_todos: rpc({
      security: 'definer',
      body: `IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501'; END IF;
             DELETE FROM public.todos WHERE user_id = (SELECT auth.uid());`,
    }),
    // Só a assinatura: a função já existe no banco
    search_todos: rpc({ args: { q: 'text' }, returns: 'jsonb' }),
  },
});
```

Chamadas no SDK: `client.rpc.count_open_todos({})`, `client.rpc.complete_all({ p_user: id })`. Veja [SDK](/pt/api/sdk#rpc-calls).

## RpcDef

```ts
interface RpcDef {
  readonly _rpc: true;
  readonly args?: Record<string, ColumnType>;
  readonly returns?: RpcReturnType;
  readonly body?: string;
  readonly language?: RpcLanguage;
  readonly security?: RpcSecurity;
  readonly volatility?: RpcVolatility;
  readonly immutable?: boolean;
  readonly set?: Readonly<Record<string, string>>;
  readonly allowAnon?: boolean;
}

type RpcLanguage = 'plpgsql' | 'sql';
type RpcSecurity = 'invoker' | 'definer';
type RpcVolatility = 'volatile' | 'stable' | 'immutable';
type RpcReturnType = ColumnType | 'void';
```

`_rpc: true` marca o objeto como RPC; qualquer item em `rpcs` sem essa marca é reportado como `INVALID_RPC`. Todos esses tipos são exportados por `accessnexus`.
