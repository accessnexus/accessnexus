# RPCs

Uma RPC é uma função do Postgres que seu app chama pelo Supabase (`supabase.rpc(...)`, ou `db.rpc.<name>()` no SDK gerado). Você a declara com `rpc()` ao lado das suas tabelas; o AccessNexus escreve o `CREATE OR REPLACE FUNCTION`, os grants e um método tipado no client.

Use uma RPC quando uma regra de tabela não basta: um agregado que o client não deveria calcular, uma alteração em várias etapas que precisa ficar consistente, ou uma ação que precisa mexer em linhas que quem chama não enxerga (aceitar um convite, restaurar uma linha com soft delete).

## Declare uma RPC {#declare-an-rpc}

As RPCs ficam no segundo argumento de `defineSchema`, em `rpcs`. Elas nunca vão dentro do objeto de tabelas (o `validate` acusa `RPC_IN_TABLES`).

```ts [accessnexus.schema.ts]
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
    count_open_todos: rpc({
      returns: 'int',
      language: 'sql',
      body: 'SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;',
    }),
  },
});
```

`npx accessnexus generate` escreve isso em `generated/rpcs/rpcs.sql`:

```sql
CREATE OR REPLACE FUNCTION count_open_todos()
RETURNS INTEGER
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = pg_catalog, public
AS $$
SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;
$$;
```

O `push` aplica `rpcs.sql` depois das migrations, policies e triggers, e reaplica o arquivo sempre que ele muda.

## Três formas {#three-forms}

| Forma | Gera SQL | Tipa o client | Use para |
| --- | --- | --- | --- |
| `rpc({ args, returns, body })` | sim | sim | funções que o AccessNexus gerencia |
| `rpc({ args, returns })` | não | sim | uma função que já existe no banco (escrita numa migration que você mantém) |
| `rpc()` | não | a partir do seu tipo `Database` | [modo Database](/pt/guide/schema), em que os tipos vêm de `database.types.ts` |

Só as RPCs com `body` entram em `rpcs.sql`.

## Opções {#options}

| Opção | Tipo | Padrão | Observações |
| --- | --- | --- | --- |
| `args` | `Record<string, ColumnType>` | nenhum | Nome do argumento para tipo de coluna (`'uuid'`, `'text'`, `'int'`, `'jsonb'`, `'text[]'`, ...). A ordem das chaves é a ordem dos argumentos no SQL. |
| `returns` | `ColumnType \| 'void' \| { table } \| { setof }` | `'void'` | Um tipo de coluna escalar ou array, ou um conjunto de linhas: `{ table: { col: 'type', ... } }` emite `RETURNS TABLE(...)`, `{ setof: 'bookings' }` (uma tabela do schema) ou `{ setof: 'uuid' }` (um tipo de coluna) emite `RETURNS SETOF ...`. Veja [Tipos de retorno](/pt/api/rpc#return-types). |
| `body` | `string` | nenhum | O corpo da função, sem o invólucro `CREATE FUNCTION`. |
| `language` | `'plpgsql' \| 'sql'` | `'plpgsql'` | Veja [Escrevendo o corpo](#writing-the-body). |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | Veja [Invoker ou definer](#invoker-or-definer). |
| `allowAnon` | `boolean` | `false` | Só para RPCs definer: também concede EXECUTE a `anon`. |
| `volatility` | `'volatile' \| 'stable' \| 'immutable'` | `'volatile'` | Emitido como `VOLATILE` / `STABLE` / `IMMUTABLE`. Um helper chamado em policies RLS deveria ser `'stable'`: um `VOLATILE` é reavaliado a cada linha em vez de uma vez por query. |
| `immutable` | `boolean` | `false` | Alias de `volatility: 'immutable'` (uma `volatility` conflitante é `RPC_VOLATILITY_CONFLICT`). |
| `set` | `Record<string, string>` | nenhum | Configuração da função, ex. `{ row_security: 'off' }` → `SET row_security = 'off'`. Os valores vão entre aspas; as chaves precisam ser nomes de parâmetros de configuração. O `search_path` continua fixado (veja abaixo). |

Nomes de RPC seguem a mesma regra das tabelas: snake_case minúsculo (senão, `INVALID_IDENTIFIER`). Tipos de argumento desconhecidos falham com `UNKNOWN_COLUMN_TYPE`.

## Escrevendo o corpo {#writing-the-body}

- **`plpgsql`**: o AccessNexus envolve o corpo em `BEGIN ... END;`. Se o seu corpo começa com `DECLARE` ou `BEGIN`, ele é emitido como está, então escreva o bloco inteiro você mesmo (necessário para variáveis locais).
- **`sql`**: emitido literalmente. O resultado do último statement é o valor de retorno.
- Toda função recebe `SET search_path = pg_catalog, public`. Qualquer coisa fora desses dois schemas precisa ser qualificada com o schema (`auth.uid()`, `auth.users`, `extensions.<fn>`). Um `search_path` em `set` não muda isso: o `validate` avisa `SEARCH_PATH_PINNED` e o valor fixado é emitido.
- `args` viram parâmetros SQL simples. Use um prefixo (`p_org_id`) para que nunca escondam o nome de uma coluna.

```ts [accessnexus.schema.ts]
import { defineSchema, rpc, table } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: { id: 'uuid', user_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
  }),
}, {
  rpcs: {
    // plpgsql com variáveis locais: escreva o bloco DECLARE ... BEGIN ... END completo
    my_note_stats: rpc({
      returns: 'jsonb',
      body: `
        DECLARE
          v_total int;
        BEGIN
          SELECT count(*) INTO v_total FROM notes WHERE user_id = (SELECT auth.uid());
          RETURN jsonb_build_object('total', v_total);
        END;`,
    }),
  },
});
```

## Invoker ou definer {#invoker-or-definer}

| | `security: 'invoker'` (padrão) | `security: 'definer'` |
| --- | --- | --- |
| Roda como | quem chama | o dono da função (a role que rodou o `push`) |
| RLS dentro do corpo | vale, exatamente como numa query direta | é ignorado |
| Quem pode dar EXECUTE | padrão do Supabase: `anon` e `authenticated` | `authenticated` e `service_role`; `anon` só com `allowAnon: true` |
| Você precisa | nada a mais: o RLS protege os dados | checar quem chama por conta própria |

Prefira invoker. Recorra a definer só quando a função precisa ler ou escrever linhas que as policies de quem chama escondem, por exemplo, inserir uma linha de membership numa tabela cuja policy de `insert` é `policy.none()`.

Para uma RPC definer, o AccessNexus acrescenta:

```sql
REVOKE EXECUTE ON FUNCTION accept_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_invitation(TEXT) TO authenticated, service_role;
```

Com `allowAnon: true`, o `REVOKE` mantém `anon` e o `GRANT` o adiciona:

```sql
REVOKE EXECUTE ON FUNCTION public_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_stats() TO authenticated, service_role, anon;
```

`allowAnon` não tem efeito em RPCs invoker.

::: danger Uma RPC definer é um buraco no RLS, a menos que você o feche
Dentro de um corpo definer, toda tabela pode ser lida e escrita. Tudo o que os argumentos deixam quem chama alcançar, ele alcança. Antes de qualquer outra coisa, verifique:

1. **Quem está chamando.** `(SELECT auth.uid()) IS NULL` significa uma chamada anônima (ou da service role). Rejeite, a menos que o uso anônimo seja o objetivo.
2. **Se quem chama pode agir sobre essas linhas.** Filtre por `(SELECT auth.uid())` ou cheque a membership explicitamente. Nunca confie num id passado em `args` como "o usuário atual".
3. **O que o resultado revela.** Retorne só o que quem chama pode ver.

O `validate` não inspeciona corpos definer em busca dessas checagens. Ele só avisa sobre chamadas `auth.uid()` sem o wrapper.
:::

## Cheque quem chama dentro de uma função definer {#check-the-caller-inside-a-definer-function}

Lance o erro com SQLSTATE `42501` (insufficient privilege), para que o client receba a mesma classe de erro de uma negação do RLS.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  orgs: table({
    columns: { id: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: {
      select: policy.belongsTo('id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }),
    },
  }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','member')" },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.none(),
      update: policy.none(),
      delete: policy.none(),
    },
  }),
}, {
  rpcs: {
    // Admins da org removem um membro. org_members não tem regra de DELETE para ninguém,
    // então esta função definer é o único caminho, e ela mesma checa tudo.
    remove_member: rpc({
      args: { p_org_id: 'uuid', p_user_id: 'uuid' },
      security: 'definer',
      body: `
        IF (SELECT auth.uid()) IS NULL THEN
          RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.org_members m
          WHERE m.org_id = p_org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin'
        ) THEN
          RAISE EXCEPTION 'only org admins can remove members' USING ERRCODE = '42501';
        END IF;
        DELETE FROM public.org_members WHERE org_id = p_org_id AND user_id = p_user_id;`,
    }),
  },
});
```

O mesmo padrão, com uma checagem de email confirmado, é a RPC `accept_invitation` da [receita de convites](/pt/guide/cookbook#invitation-based-membership-consent).

## Use o wrapper nas chamadas de auth {#wrap-auth-calls}

Sempre escreva `(SELECT auth.uid())` e `(SELECT auth.jwt())`, nunca a chamada direta. Dentro de uma query, a forma com subquery é avaliada uma vez (um initPlan) em vez de uma vez por linha, e é a forma que o próprio gerador emite nas policies.

```sql
-- Bom
DELETE FROM public.todos WHERE user_id = (SELECT auth.uid());
-- Acusado pelo validate (UNWRAPPED_AUTH_CALL)
DELETE FROM public.todos WHERE user_id = auth.uid();
```

O `validate` avisa `UNWRAPPED_AUTH_CALL` para `auth.uid()`, `auth.jwt()` ou `auth.role()` sem o wrapper num corpo de RPC, em `policy.custom()` e numa condição `trigger.lockColumns({ unless })`.

## Chame pelo SDK {#call-it-from-the-sdk}

Cada RPC vira um método tipado em `db.rpc`. O resultado é `{ data, error }`, como no supabase-js, e a chamada roda como o usuário logado.

```ts [src/dashboard.ts]
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function loadDashboard() {
  // RPC sem argumentos: passe um objeto vazio
  const { data: open, error } = await db.rpc.count_open_todos({});
  if (error) throw error;
  return open; // number
}
```

Os tipos de argumento e de retorno vêm dos tipos de coluna: `uuid`/`text` viram `string`, `int`/`bigint`/`float` viram `number`, `jsonb` vira `Json` (o mesmo tipo do Supabase). Um retorno de conjunto de linhas é tipado como array: `{ table: { id: 'uuid', done: 'boolean' } }` dá `{ id: string; done: boolean }[]`, `{ setof: 'todos' }` dá `Todos[]` (o Row da tabela), `{ setof: 'uuid' }` dá `string[]`. Uma chamada comum do supabase-js (`supabase.rpc('count_open_todos')`) chega à mesma função.

## Alterando ou removendo uma RPC {#changing-or-removing-an-rpc}

O `push` reexecuta `rpcs.sql` com `CREATE OR REPLACE FUNCTION`, que tem as limitações do Postgres:

| Mudança no schema | O que acontece no banco |
| --- | --- |
| Corpo, linguagem, security | Substituída no lugar. |
| Tipo de retorno (escalar, colunas de `TABLE`, `SETOF`) ou nomes de argumento | O guard antes da função remove a versão antiga (`DROP FUNCTION name(argtypes)`, sem `CASCADE`) e cria a nova, dentro da mesma transação do push. Os grants são reaplicados: o `REVOKE`/`GRANT` gerado para RPCs definer, os default privileges do Supabase para as invoker. |
| Tipos ou quantidade de argumentos | Uma função **nova** (overload) é criada. A antiga continua, com os grants antigos. |
| RPC removida do schema | A função continua no banco. O AccessNexus nunca remove funções que não declara mais. |
| Default de parâmetro removido | Não é tratado pelo guard: o Postgres rejeita. Remova a função à mão e depois faça o push. |

O Postgres não consegue mudar o tipo de resultado nem os nomes dos argumentos de uma função no lugar ("cannot change return type of existing function"), daí o guard. Ele compara na grafia do próprio Postgres (`format_type`, `pg_get_function_result`, `pg_get_function_identity_arguments`), então uma função inalterada nunca é removida. O plano ao vivo (`push --plan` e o relatório do dry-run) mostra o drop-e-create como função alterada (`returns` mudou), não como função removida.

::: warning Dependentes bloqueiam o drop
Se uma policy, view ou outra função depende da função, o `DROP` falha e o push inteiro sofre rollback: nada é aplicado. Remova ou ajuste o dependente antes, ou dê outro nome à nova versão.
:::

::: warning Remova você mesmo as funções definer antigas
Depois de mudar os argumentos de uma RPC definer ou removê-la, a versão anterior continua podendo ser chamada por `authenticated`. Remova-a explicitamente (`DROP FUNCTION old_name(uuid);` como `postgres`) se ela não deve mais existir.
:::

## Veja também {#related}

- [Modelo de segurança](/pt/guide/security): o que o gerador garante e o que o código definer precisa fazer
- [Exemplos](/pt/guide/cookbook): convites, restaurar após soft delete
- [Triggers](/pt/guide/triggers): triggers com `security: 'definer'` seguem as mesmas regras
- [Referência da API `rpc()`](/pt/api/rpc)
- [SDK gerado](/pt/api/sdk)
