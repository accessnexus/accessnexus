# trigger

Builders para o array `triggers` de uma tabela. Cada um compila para uma função PL/pgSQL mais um `CREATE TRIGGER`, gravados em `<table>_triggers.sql`. Guia: [Triggers](/pt/guide/triggers).

```ts
import { trigger } from 'accessnexus';
```

## Saída comum {#common-output}

| Item | Valor |
| --- | --- |
| Nome da função | `<prefix>_<table>_<suffix>_fn` |
| Nome do trigger | `<prefix>_<table>_<suffix>` |
| `search_path` | toda função tem `SET search_path = pg_catalog, <schemaName>` (padrão `public`) |
| Idempotência | `CREATE OR REPLACE FUNCTION` e `DROP TRIGGER IF EXISTS` antes do `CREATE TRIGGER` (a menos que `adapterOptions.idempotent` seja `false`) |
| Granularidade | `FOR EACH ROW` (só `trigger.custom` pode escolher `statement`) |

`<prefix>` é o prefixo das policies (padrão `accessnexus`). Dois triggers com o mesmo sufixo numa tabela se substituiriam; o `validate` reporta `DUPLICATE_TRIGGER`.

| Builder | Sufixo | Dispara | Segurança |
| --- | --- | --- | --- |
| [`updatedAt`](#updatedat) | `updated_at` | `BEFORE UPDATE` | invoker |
| [`softDelete`](#softdelete) | `soft_delete`, `soft_delete_guard` | `BEFORE DELETE`, `BEFORE UPDATE OF <column>` | definer (delete), invoker (guard) |
| [`auditLog`](#auditlog) | `audit_log` | `AFTER INSERT OR UPDATE OR DELETE` | definer |
| [`lockColumns`](#lockcolumns) | `name` ou `lock_columns` | `BEFORE UPDATE` | invoker |
| [`custom`](#custom) | `name` | `events` | `security` (padrão invoker) |

## updatedAt

Preenche uma coluna de timestamp a cada UPDATE.

```ts
updatedAt(column: string): UpdatedAtTrigger; // { kind: 'updated_at', column }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `column` | `string` | Coluna de timestamp, normalmente `'timestamptz?'`. |

Corpo: `NEW.<column> = NOW(); RETURN NEW;`. O `trigger.lockColumns` nunca bloqueia uma coluna mantida pelo `updatedAt`.

```ts
import { table, trigger } from 'accessnexus';

export const posts = table({
  columns: { id: 'uuid', title: 'text', updated_at: 'timestamptz?' },
  primaryKey: 'id',
  triggers: [trigger.updatedAt('updated_at')],
});
```

## softDelete

Transforma DELETE em `SET <column> = NOW()`.

```ts
softDelete(column: string): SoftDeleteTrigger; // { kind: 'soft_delete', column }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `column` | `string` | Coluna de timestamp nullable, ex.: `'deleted_at'`. |

Definir `softDelete: '<column>'` na tabela adiciona esse trigger automaticamente (e faz o SDK filtrar as linhas apagadas); usar os dois é reportado como `DUPLICATE_TRIGGER`.

Gerado:

1. `<prefix>_<table>_soft_delete_fn`, `SECURITY DEFINER`, `BEFORE DELETE`: `UPDATE <schema>.<table> SET <column> = NOW() WHERE <pk> = OLD.<pk>; RETURN NULL;` (cancela o delete). `<pk>` é a `primaryKey`, ou `id`.
2. `<prefix>_<table>_soft_delete_guard_fn`, invoker, `BEFORE UPDATE OF <column>`: lança SQLSTATE `42501` quando um usuário da API (`anon` / `authenticated`) altera a coluna com um UPDATE comum.

Por isso, quem decide quem pode fazer soft delete é a policy de DELETE; a policy de UPDATE não serve para fazer soft delete nem para restaurar. Restaure linhas com a service role ou com uma RPC `security: 'definer'`.

::: warning Atenção
Linhas com soft delete continuam visíveis pelo RLS; só o SDK as filtra. Para escondê-las das leituras diretas pela API, adicione a condição ao `select`, ex.: `policy.all([policy.isOwner('author_id'), policy.custom('deleted_at IS NULL')])`. `onDelete: 'cascade'` apontando para uma tabela com soft delete é rejeitado (`CASCADE_INTO_SOFT_DELETE`).
:::

## auditLog

Registra todo INSERT, UPDATE e DELETE numa tabela de auditoria.

```ts
auditLog(options: { table: string; columns?: string[] }): AuditLogTrigger;
// { kind: 'audit_log', table, columns }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `table` | `string` | obrigatório | Tabela de auditoria no schema. Qualificada com o nome do schema, a menos que contenha um ponto. |
| `columns` | `string[]` | todas as colunas | Registra só essas colunas (`JSONB_BUILD_OBJECT`) em vez da linha inteira (`TO_JSONB`). |

A função é `SECURITY DEFINER` e executa:

```sql
INSERT INTO public.audit_log (table_name, operation, old_data, new_data, changed_at)
VALUES (TG_TABLE_NAME, TG_OP,
  CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
  NOW());
RETURN COALESCE(NEW, OLD);
```

A tabela de auditoria precisa ter `table_name`, `operation`, `old_data`, `new_data`, `changed_at`, e todas as outras colunas precisam ser nullable ou ter um default (`AUDIT_TABLE_MISMATCH`). Mantenha a policy de `insert` dela como `policy.none()`: o trigger não precisa dela, e um insert aberto permite que usuários forjem registros (`AUDIT_INSERT_OPEN`).

```ts
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  audit_log: table({
    columns: {
      id: 'uuid',
      table_name: 'text',
      operation: 'text',
      old_data: 'jsonb?',
      new_data: 'jsonb?',
      changed_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    policies: { select: policy.hasRole('admin'), insert: policy.none(), update: policy.none(), delete: policy.none() },
  }),
  invoices: table({
    columns: { id: 'uuid', owner_id: 'uuid', status: 'text' },
    primaryKey: 'id',
    triggers: [trigger.auditLog({ table: 'audit_log', columns: ['status'] })],
    policies: { select: policy.isOwner('owner_id'), update: policy.isOwner('owner_id') },
  }),
});
```

## lockColumns

Impede que usuários da API alterem certas colunas com UPDATE. O RLS decide quais linhas um usuário pode atualizar, nunca quais colunas.

```ts
lockColumns(options: {
  columns?: string[];
  except?: string[];
  unless?: string;
  name?: string;
}): LockColumnsTrigger; // { kind: 'lock_columns', ...só as opções passadas }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `columns` | `string[]` | `undefined` | Colunas que não podem mudar. Use esta ou `except`, não as duas (`INVALID_TRIGGER`). |
| `except` | `string[]` | `undefined` | Trava todas as colunas, exceto estas. |
| `unless` | `string` | `undefined` | Condição SQL crua (com `NEW` e `OLD` disponíveis) sob a qual a alteração é permitida. Um resultado `NULL` conta como falso. |
| `name` | `string` | `'lock_columns'` | Sufixo do trigger, em snake_case minúsculo. Precisa ser diferente quando a tabela tem dois triggers `lockColumns`. |

A função `BEFORE UPDATE` lança SQLSTATE `42501` com `<table>: <cols> cannot be changed` (ou `<table>: only <cols> can be changed`) quando todas estas condições valem:

- `current_user IN ('anon', 'authenticated')` — a service role e código `SECURITY DEFINER` nunca são bloqueados;
- `unless` não é verdadeiro;
- uma coluna travada mudou. Com `columns`: `NEW.c IS DISTINCT FROM OLD.c` para cada uma. Com `except`: `to_jsonb(NEW) - ARRAY[...]` difere de `to_jsonb(OLD) - ARRAY[...]`.

Colunas mantidas por `trigger.updatedAt` na mesma tabela sempre podem mudar.

```ts
import { table, trigger } from 'accessnexus';

export const tasks = table({
  columns: { id: 'uuid', org_id: 'uuid', reporter_id: 'uuid', status: 'text', title: 'text' },
  primaryKey: 'id',
  triggers: [
    trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
    trigger.lockColumns({
      except: ['status'],
      unless: "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = NEW.org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin')",
    }),
  ],
});
```

::: warning Atenção
`unless` é SQL cru executado como o usuário que fez a chamada. Escreva `(SELECT auth.uid())`, não um `auth.uid()` solto (`UNWRAPPED_AUTH_CALL`), e nunca interpole entrada não confiável.
:::

## custom

Um trigger com o seu próprio corpo PL/pgSQL.

```ts
custom(options: {
  name: string;
  events: TriggerEvent[];
  functionBody: string;
  when?: string;
  forEach?: TriggerForEach;
  security?: 'invoker' | 'definer';
  set?: Record<string, string>;
}): CustomTrigger;

type TriggerEvent =
  | 'before_insert' | 'after_insert'
  | 'before_update' | 'after_update'
  | 'before_delete' | 'after_delete';
type TriggerForEach = 'row' | 'statement';
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `name` | `string` | obrigatório | Sufixo do trigger, em snake_case minúsculo (`INVALID_IDENTIFIER`). |
| `events` | `TriggerEvent[]` | obrigatório | Pelo menos um (`INVALID_TRIGGER`). |
| `functionBody` | `string` | obrigatório | Statements PL/pgSQL colocados entre `BEGIN` e `END;`. Precisa terminar com `RETURN NEW`, `RETURN OLD` ou `RETURN NULL`. |
| `when` | `string` | `undefined` | Condição SQL emitida como `WHEN (<when>)`. |
| `forEach` | `'row' \| 'statement'` | `'row'` | `FOR EACH ROW` ou `FOR EACH STATEMENT`. |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | `'definer'` adiciona `SECURITY DEFINER`: o corpo roda como o dono da função e ignora o RLS. |
| `set` | `Record<string, string>` | `undefined` | Configuração da função, como em [`rpc`](/pt/api/rpc#options): `{ row_security: 'off' }` emite `SET row_security = 'off'`. O `search_path` continua fixado em `pg_catalog, public`. |

Os eventos são agrupados por momento: `['before_insert', 'before_update']` vira `BEFORE INSERT OR UPDATE`. O corpo é envolvido como `BEGIN <functionBody> END;`, então não pode ter uma seção `DECLARE` própria.

::: warning Atenção
Use eventos de um único momento em cada trigger. Misturar `before_*` e `after_*` gera `BEFORE ... OR AFTER ...`, que o Postgres rejeita no `push`; o `validate` não pega isso. Divida em dois triggers.
:::

```ts
import { trigger } from 'accessnexus';

export const lowerEmail = trigger.custom({
  name: 'lowercase_email',
  events: ['before_insert', 'before_update'],
  when: 'NEW.email IS NOT NULL',
  functionBody: 'NEW.email = lower(NEW.email); RETURN NEW;',
});

// Efeito colateral confiável: adiciona o criador como primeiro owner
export const addCreator = trigger.custom({
  name: 'add_creator_as_owner',
  events: ['after_insert'],
  security: 'definer',
  functionBody: "INSERT INTO public.team_members (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
});
```

::: warning Atenção
`security: 'definer'` ignora o RLS em tudo o que o corpo lê e escreve. Use só para efeitos colaterais confiáveis, qualifique as tabelas com o schema (`public.team_members`) e verifique quem está chamando dentro do corpo quando isso importar.
:::

## Tipos {#types}

Exportados de `accessnexus`: `TriggerRule` (`{ readonly kind: string }`), `TableTriggers` (`TriggerRule[]`), `TriggerEvent`, `TriggerForEach`, `UpdatedAtTrigger`, `SoftDeleteTrigger`, `AuditLogTrigger`, `LockColumnsTrigger`, `CustomTrigger`.
