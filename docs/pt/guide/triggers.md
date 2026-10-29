# Triggers

Triggers executam lógica dentro do Postgres quando uma linha é escrita. O AccessNexus traz presets para os casos comuns (timestamps, soft delete, log de auditoria, travas de coluna) e uma válvula de escape para PL/pgSQL customizado. Coloque-os no array `triggers` de uma tabela; o `generate` escreve um `<table>_triggers.sql` por tabela com as funções e os comandos `CREATE TRIGGER`.

| Builder | Dispara | Roda como |
| --- | --- | --- |
| `trigger.updatedAt(column)` | `BEFORE UPDATE` | O usuário que escreve |
| `trigger.softDelete(column)` | `BEFORE DELETE` | Dono da função (`SECURITY DEFINER`) |
| `trigger.auditLog({ table, columns? })` | `AFTER INSERT OR UPDATE OR DELETE` | Dono da função (`SECURITY DEFINER`) |
| `trigger.lockColumns({ columns \| except, unless?, name? })` | `BEFORE UPDATE` | O usuário que escreve |
| `trigger.custom({ name, events, functionBody, when?, forEach?, security? })` | Os eventos que você definir | O usuário que escreve, ou o dono com `security: 'definer'` |

Toda função gerada tem `SET search_path = pg_catalog, public`. Os triggers se chamam `<prefix>_<table>_<name>` e suas funções acrescentam `_fn`, por exemplo `accessnexus_projects_updated_at` e `accessnexus_projects_updated_at_fn()`. O arquivo os substitui no lugar a cada push.

## Por que triggers: RLS não restringe colunas {#why-triggers-rls-cannot-restrict-columns}

O RLS responde "este usuário pode mexer nesta linha?". Ele não compara os valores antigo e novo de uma coluna, então não consegue dizer "o responsável pode mudar `status`, mas não `title`" ou "ninguém pode mudar `owner_id` depois da criação". Uma regra `update: policy.isOwner('assignee_id')` deixa o responsável reescrever todas as colunas da linha, incluindo o dono e o tenant.

Triggers enxergam tanto `OLD` quanto `NEW`, e é por isso que as regras por coluna ficam aqui. Use [`trigger.lockColumns`](#trigger-lockcolumns) para elas, nunca uma regra de UPDATE extra.

## `trigger.updatedAt`

Define uma coluna de timestamp como `NOW()` a cada UPDATE.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
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

```sql
CREATE OR REPLACE FUNCTION accessnexus_notes_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

CREATE TRIGGER accessnexus_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_notes_updated_at_fn();
```

## Soft delete {#soft-delete}

Prefira a opção de tabela `softDelete: 'deleted_at'` a adicionar `trigger.softDelete` você mesmo: a opção adiciona o trigger e sua proteção, além de um índice parcial e do filtro do SDK que esconde as linhas excluídas (veja [Schema](/pt/guide/schema#soft-delete)). Listar `trigger.softDelete` também não faz mal; ele é gerado uma vez só.

```ts
import { trigger } from 'accessnexus';

// O que a opção de tabela adiciona para você
export const softDelete = trigger.softDelete('deleted_at');
```

O SQL gerado intercepta o DELETE, preenche a coluna e cancela a exclusão original retornando `NULL`:

```sql
CREATE OR REPLACE FUNCTION accessnexus_projects_soft_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.projects SET deleted_at = NOW() WHERE id = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
```

Junto com ele é gerado um trigger de proteção. Ele rejeita qualquer UPDATE comum de um usuário da API que preencha ou limpe a coluna:

```sql
CREATE OR REPLACE FUNCTION accessnexus_projects_soft_delete_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'projects.deleted_at can only be set by DELETE (soft delete)'
      USING ERRCODE = '42501',
      HINT = 'Delete the row instead; the DELETE policy decides who may. Restore rows with the service role or a security definer RPC.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
```

Assim, a **policy de DELETE** decide quem pode fazer soft delete, e a policy de UPDATE não pode ser usada para excluir nem restaurar. A função é `SECURITY DEFINER` porque o UPDATE interno não pode depender da policy de UPDATE do usuário; seu alvo é qualificado com o schema. Restaure linhas com a service role ou uma RPC `security: 'definer'`.

::: warning Linhas com soft delete continuam visíveis pelo RLS
Só o SDK as esconde. Adicione `policy.custom('deleted_at IS NULL')` à regra de `select` se leituras diretas pela API não puderem vê-las.
:::

## `trigger.auditLog`

Grava todo INSERT, UPDATE e DELETE numa tabela de auditoria como JSONB.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  invoices: table({
    columns: { id: 'uuid', owner_id: 'uuid', amount: 'decimal' },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id' },
    triggers: [trigger.auditLog({ table: 'audit_log' })],
    policies: {
      select: policy.isOwner('owner_id'),
      insert: policy.isOwner('owner_id'),
      update: policy.isOwner('owner_id'),
      delete: policy.none(),
    },
  }),
  audit_log: table({
    columns: {
      id: 'bigint',
      table_name: 'text',
      operation: 'text',
      old_data: 'jsonb?',
      new_data: 'jsonb?',
      changed_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    policies: {
      select: policy.hasRole('admin'), // equipe da plataforma (app_metadata.role)
      insert: policy.none(),           // só o trigger escreve
      update: policy.none(),           // apenas acréscimo
      delete: policy.none(),
    },
  }),
});
```

```sql
CREATE OR REPLACE FUNCTION accessnexus_invoices_audit_log_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.audit_log (table_name, operation, old_data, new_data, changed_at)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    NOW()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
```

### O contrato da tabela de auditoria {#the-audit-table-contract}

| Coluna | Tipo | Valor |
| --- | --- | --- |
| `table_name` | `text` | `TG_TABLE_NAME` |
| `operation` | `text` | `INSERT`, `UPDATE` ou `DELETE` |
| `old_data` | `jsonb?` | A linha antes; `NULL` no INSERT |
| `new_data` | `jsonb?` | A linha depois; `NULL` no DELETE |
| `changed_at` | `timestamptz` | `NOW()` |

Qualquer outra coluna precisa ser nullable ou ter um default (uma primary key `bigint` é identity). Uma divergência faz o `validate` falhar com `AUDIT_TABLE_MISMATCH`. Uma tabela de auditoria pode atender várias tabelas.

`columns: ['status', 'amount']` registra só essas colunas: o trigger armazena `JSONB_BUILD_OBJECT('status', OLD.status, ...)` em vez da linha inteira. Use para manter colunas sensíveis fora do log.

::: danger Mantenha inserts pela API fechados na tabela de auditoria
A função do trigger é `SECURITY DEFINER`, então ela escreve mesmo quando o `insert` da tabela de auditoria é `policy.none()`. Mantenha assim: se usuários puderem inserir, poderão forjar registros. O `validate` emite o aviso `AUDIT_INSERT_OPEN`.
:::

## `trigger.lockColumns`

Impede que usuários da API (`anon`, `authenticated`) alterem colunas com UPDATE. Ele dispara `BEFORE UPDATE`, compara `OLD` e `NEW` e lança SQLSTATE `42501` quando uma coluna travada muda.

| Opção | Descrição |
| --- | --- |
| `columns` | Colunas que não podem mudar. Use esta **ou** `except` |
| `except` | Trava todas as colunas exceto estas |
| `unless` | Condição SQL crua (`OLD` e `NEW` disponíveis) sob a qual a mudança é permitida |
| `name` | Sufixo do nome do trigger (padrão `lock_columns`). Obrigatório quando uma tabela tem dois triggers `lockColumns` (senão `DUPLICATE_TRIGGER`) |

Ele nunca bloqueia a service role, triggers e RPCs `SECURITY DEFINER`, nem a coluna mantida por `trigger.updatedAt`.

### Congele colunas de dono e de tenant {#freeze-ownership-and-tenant-columns}

```ts
import { trigger } from 'accessnexus';

// Ninguém reatribui um projeto nem o move para outra org
export const freezeIdentity = trigger.lockColumns({ columns: ['created_by', 'org_id'] });
```

```sql
CREATE OR REPLACE FUNCTION accessnexus_projects_lock_columns_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    RAISE EXCEPTION 'projects: created_by, org_id cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
```

Congele as colunas de dono, de criador e de tenant em toda tabela em que usuários podem atualizar linhas. A regra de UPDATE só verifica se a nova linha ainda passa nela: quando a regra tem vários ramos ("o dono OU um admin da org"), um admin da org pode reescrever `created_by`, e alguém que administra duas orgs pode mover uma linha entre elas. A trava fecha as duas brechas.

### Deixe alguns usuários mudarem só algumas colunas {#let-some-users-change-only-some-columns}

O responsável por um ticket só pode mudar `status`; quem o reportou pode mudar todo o resto:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  tickets: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      reporter_id: 'uuid',
      assignee_id: 'uuid?',
      title: 'text',
      status: { type: "enum('open','doing','done')", default: "'open'" },
    },
    primaryKey: 'id',
    references: { reporter_id: 'auth.users.id', assignee_id: 'auth.users.id' },
    triggers: [
      // Ninguém reatribui um ticket nem o move para outra org
      trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
      // Todos, exceto quem reportou, só podem mudar status
      trigger.lockColumns({
        name: 'assignee_scope',
        except: ['status'],
        unless: 'OLD.reporter_id = (SELECT auth.uid())',
      }),
    ],
    policies: {
      select: policy.any([policy.isOwner('reporter_id'), policy.isOwner('assignee_id')]),
      insert: policy.isOwner('reporter_id'),
      update: policy.any([policy.isOwner('reporter_id'), policy.isOwner('assignee_id')]),
      delete: policy.isOwner('reporter_id'),
    },
  }),
});
```

A forma com `except` compara a linha inteira menos as colunas permitidas:

```sql
IF current_user IN ('anon', 'authenticated')
   AND NOT COALESCE((OLD.reporter_id = (SELECT auth.uid())), FALSE)
   AND ((to_jsonb(NEW) - ARRAY['status']::text[]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status']::text[])) THEN
  RAISE EXCEPTION 'tickets: only status can be changed'
    USING ERRCODE = '42501';
END IF;
```

`unless` é SQL cru executado como quem chamou. Escreva `(SELECT auth.uid())`, nunca um `auth.uid()` solto. Ele pode consultar a tabela de membros diretamente, por exemplo "o usuário é admin da org":

```ts
import { trigger } from 'accessnexus';

export const statusOnly = trigger.lockColumns({
  name: 'member_scope',
  except: ['status', 'position'],
  unless: "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = OLD.org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin')",
});
```

Este é o único lugar em que um `EXISTS` na tabela de membros é a ferramenta certa: a condição roda fora de qualquer policy, então não há recursão, e a própria policy de `select` da tabela de membros continua valendo para ela.

## `trigger.custom`

Controle total sobre o corpo PL/pgSQL.

| Opção | Descrição |
| --- | --- |
| `name` | Sufixo do nome do trigger, usado nos nomes da função e do trigger |
| `events` | `before_insert`, `after_insert`, `before_update`, `after_update`, `before_delete`, `after_delete` |
| `functionBody` | Corpo PL/pgSQL, sem o invólucro `CREATE FUNCTION`. Retorne `NEW` (ou `OLD` / `NULL`) você mesmo |
| `when` | Condição `WHEN` opcional, por exemplo `'NEW.email IS NOT NULL'` |
| `forEach` | `'row'` (padrão) ou `'statement'` |
| `security` | `'invoker'` (padrão) ou `'definer'` |

```ts
import { trigger } from 'accessnexus';

export const lowerEmail = trigger.custom({
  name: 'lowercase_email',
  events: ['before_insert', 'before_update'],
  when: 'NEW.email IS NOT NULL',
  functionBody: 'NEW.email = lower(NEW.email); RETURN NEW;',
});
```

Eventos com o mesmo momento são combinados num único trigger: `['before_insert', 'before_update']` vira `BEFORE INSERT OR UPDATE`, e `when` vira a cláusula `WHEN (...)` do trigger.

### `security: 'definer'` {#security-definer}

Por padrão, um trigger customizado roda como o usuário que escreve, e o RLS se aplica a tudo que seu corpo lê e escreve. Com `security: 'definer'`, ele roda como o dono da função e **ignora o RLS**. Use só para efeitos colaterais confiáveis, como adicionar quem criou um time como seu primeiro owner:

```ts
import { trigger } from 'accessnexus';

export const addCreator = trigger.custom({
  name: 'add_creator_as_owner',
  events: ['after_insert'],
  security: 'definer',
  functionBody: "INSERT INTO public.team_members (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
});
```

::: danger Corpos definer só confiam na linha
Um corpo definer pula todas as policies, então precisa decidir o que é permitido apenas a partir de `NEW`, `OLD` e `(SELECT auth.uid())`. Qualifique toda tabela com o schema (`public.team_members`). Prefira isso a uma regra de INSERT de "bootstrap" na tabela de membros ("quem criou pode se adicionar como owner"), que continua válida para sempre e deixa um criador removido voltar.
:::

Um trigger invoker é a escolha certa para proteções que devem respeitar o RLS. Por exemplo, um trigger `BEFORE INSERT OR UPDATE` que verifica se o projeto de uma tarefa pertence à mesma org: um projeto de outra org é invisível pelo RLS, então é reportado como um projeto que não existe. O padrão completo está no [Exemplos](/pt/guide/cookbook).

## Próximos passos {#next-steps}

- [Policies](/pt/guide/policies) - regras por linha que os triggers complementam
- [Permissões](/pt/guide/permissions) - passo a passo multi-tenant usando `lockColumns` e um trigger definer
- [Exemplos](/pt/guide/cookbook) - proteções de mesmo tenant e updates restritos a colunas
- [API de triggers](/pt/api/trigger) - assinaturas e tipos completos
