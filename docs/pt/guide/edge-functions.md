# Edge Functions {#edge-functions}

As Supabase Edge Functions rodam o seu código de servidor (Deno) ao lado do banco. O AccessNexus permite declarar cada função no schema: quem pode chamá-la, o formato do input JSON e o formato do output. O `generate` transforma isso em:

- `supabase/functions/_shared/accessnexus.ts`: um wrapper tipado por função, construído sobre o `withSupabase` do [`@supabase/server`](https://github.com/supabase/server) (a abordagem que a documentação do Supabase recomenda). Ele checa as credenciais de quem chama, responde CORS, valida o corpo JSON e entrega ao seu handler um client com escopo de RLS. É regenerado, nunca editado.
- `supabase/functions/<name>/index.ts`: um scaffold escrito uma vez, quando o arquivo não existe. Depois disso é código seu; o `generate` nunca mais mexe nele.
- `supabase/config.toml`: um bloco gerenciado com o `verify_jwt` de cada função.
- `client.functions.<name>(input)` no SDK, tipado a partir da mesma declaração.

O deploy continua com o Supabase CLI (`supabase functions deploy`); o `push` só mexe no banco.

## Declare uma função {#declare-a-function}

```ts [accessnexus.schema.ts]
import { defineSchema, edgeFunction, policy, table } from 'accessnexus';

export default defineSchema({
  invitations: table({
    columns: { id: 'uuid', org_id: 'uuid', email: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isAuthenticated(), insert: policy.isAuthenticated() },
  }),
}, {
  functions: {
    'invite-member': edgeFunction({
      auth: 'user',
      input: { org_id: 'uuid', email: 'text', role: "enum('admin','member')", message: 'text?' },
      output: { invitation_id: 'uuid' },
    }),
    'stripe-webhook': edgeFunction({ auth: 'none', output: 'void' }),
  },
});
```

Nomes de função são letras minúsculas e dígitos unidos por `-` ou `_` (o Supabase recomenda hífens). No SDK e nos wrappers eles viram camelCase: `invite-member` → `inviteMember`.

### auth {#auth}

| Valor | Quem pode chamar | `ctx.supabase` |
| --- | --- | --- |
| `'user'` (padrão) | Requisições com o JWT de um usuário autenticado | Roda como esse usuário: o RLS se aplica |
| `'publishable'` | Requisições com uma publishable key (sem usuário) | Sem usuário |
| `'secret'` | Servidores com uma secret key (cron jobs, outros backends) | Sem usuário |
| `'none'` | Qualquer pessoa, por exemplo um webhook que verifica a própria assinatura | Sem usuário |
| `['publishable', 'secret']` | Qualquer um dos modos listados (`'none'` deve vir por último) | Depende de quem chama |

Requisições que não casam recebem `401` do `withSupabase` antes de o seu handler rodar. O `verify_jwt` no `config.toml` é `true` em toda função, exceto nas que aceitam `'none'`; para essas o `validate` avisa `EDGE_FUNCTION_PUBLIC`.

### input e output {#input-and-output}

`input` mapeia nomes de campo para os mesmos tipos de coluna que as tabelas usam (`'uuid'`, `'text'`, `'int'`, `'boolean'`, `'jsonb'`, `'date'`, `'timestamptz'`, `'text[]'`, `"enum('a','b')"`, `'varchar(20)'`, ...). Um `?` no final torna o campo opcional e anulável.

| `input` | O wrapper |
| --- | --- |
| `{ field: 'type', ... }` | Exige `POST` com um objeto JSON com exatamente esses campos, checados por tipo. Qualquer outra coisa é rejeitada com `400` antes de o handler rodar. |
| `{}` | Exige `POST` com corpo vazio ou `{}`. |
| omitido | Não lê o corpo: o handler lê o `req` por conta própria (por exemplo, `await req.text()` para verificar a assinatura de um webhook) e `input` é `undefined`. |

`output` é um objeto de campos, um único tipo de coluna (`'jsonb'`) ou `'void'` (o wrapper responde `204`). Omita para uma resposta sem tipo.

## Implemente {#implement-it}

O primeiro `generate` escreve um scaffold que responde `501`. Substitua o corpo do handler:

```ts
// supabase/functions/invite-member/index.ts
import { FunctionError, inviteMember } from '../_shared/accessnexus.ts';

export default {
  fetch: inviteMember(async (input, ctx) => {
    // input: { org_id: string; email: string; role: 'admin' | 'member'; message?: string | null }
    const { data, error } = await ctx.supabase
      .from('invitations')
      .insert({ org_id: input.org_id, email: input.email })
      .select('id')
      .single();
    if (error) throw new FunctionError(400, 'insert_failed', error.message);
    return { invitation_id: data.id };
  }),
};
```

O handler recebe `(input, ctx, req)`:

- `ctx.supabase` roda como quem chama, então o RLS da tabela decide o que ele pode ler e escrever.
- `ctx.supabaseAdmin` ignora o RLS. Se você o usar, filtre por `ctx.userClaims` por conta própria.
- `ctx.userClaims` traz a identidade de quem chama (`id`, `email`, `role`), ou `null` sem usuário.

Retorne o output, que o wrapper envia como JSON, ou retorne um `Response` para controle total. `throw new FunctionError(status, code, message)` responde com esse status e `{ error: { code, message } }`. Qualquer outra exceção responde `500` com uma mensagem genérica e registra o erro em log, então detalhes internos nunca chegam a quem chama.

### Erros que o wrapper envia {#errors-the-wrapper-sends}

| Status | `error.code` | Quando |
| --- | --- | --- |
| 401 | (do `@supabase/server`) | A requisição não tem a credencial que o `auth` exige. |
| 405 | `method_not_allowed` | Não é `POST` (funções com especificação de `input`). |
| 400 | `invalid_json` | O corpo não é JSON. |
| 400 | `invalid_input` | O corpo não casa com `input`; `error.issues` lista `{ field, message }` de cada problema. |
| o seu | o seu | Um `FunctionError` que você lançou. |
| 500 | `internal_error` | Qualquer outra exceção (registrada em log, não exposta). |

## Chame pelo app {#call-it-from-the-app}

```ts
const { data, error } = await db.functions.inviteMember({
  org_id: orgId,
  email: 'new@example.com',
  role: 'member',
});
// data: { invitation_id: string } | null
```

A chamada é `supabase.functions.invoke('invite-member', { body, method: 'POST' })`, então o supabase-js envia o JWT do usuário autenticado por você. O tipo do input é checado em tempo de compilação; o wrapper o checa de novo em runtime. Em caso de falha, `error` é o `FunctionsHttpError` do supabase-js, e `await error.context.json()` retorna `{ error: { code, message, issues? } }`. `db.functions.x(input, { headers, region })` repassa headers extras ou uma região.

Com os [helpers do TanStack Query](/pt/api/sdk#tanstack-query-react-query) ligados, `q.functions.inviteMember.mutation()` e `q.functions.publicStats.query(input)` são opções prontas. Uma mutation invalida todas as queries do AccessNexus, porque uma função pode escrever em qualquer lugar.

## supabase/config.toml {#supabaseconfigtoml}

Se o `supabase/config.toml` existir (rode `supabase init`), o `generate` mantém este bloco nele:

```toml
# >>> accessnexus functions (generated — edit the schema, not this block)
[functions.invite-member]
verify_jwt = true

[functions.stripe-webhook]
verify_jwt = false
# <<< accessnexus functions
```

O resto do arquivo nunca é alterado. Se você já tem uma tabela `[functions.<name>]` fora do bloco, ela é deixada como está e o bloco traz um comentário dizendo qual valor de `verify_jwt` definir lá.

## Pastas {#folders}

As funções vão para `output.functions` (padrão `./supabase/functions`, de onde o Supabase CLI faz o deploy). O `config.toml` é lido da pasta pai. O `generate --sql-only` as ignora.

## Veja também {#related}

- [Referência de edgeFunction](/pt/api/edge-functions)
- [SDK gerado](/pt/api/sdk#edge-functions)
- [Modelo de segurança](/pt/guide/security#edge-functions-check-the-caller-first)
