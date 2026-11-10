# edgeFunction {#edgefunction}

Declara uma Supabase Edge Function no schema. Para o passo a passo, veja o [guia de Edge Functions](/pt/guide/edge-functions).

```ts
// exported by the accessnexus package
function edgeFunction(def?: EdgeFunctionDef): EdgeFunctionDef;

interface EdgeFunctionDef {
  auth?: EdgeFunctionAuth | EdgeFunctionAuth[];   // default 'user'
  input?: Record<string, string>;                 // field → column type ('text?', "enum('a','b')", ...)
  output?: Record<string, string> | string;       // fields, one column type, or 'void'
}

type EdgeFunctionAuth = 'user' | 'publishable' | 'secret' | 'none';
```

Passe as funções para `defineSchema(tables, { functions: { '<name>': edgeFunction({ ... }) } })`.

| Opção | Descrição |
| --- | --- |
| `auth` | Quem pode chamar: repassado ao `withSupabase({ auth })` do `@supabase/server`. Um array aceita qualquer modo listado; `'none'` deve ser o último. `verify_jwt = false` só quando `'none'` é aceito. |
| `input` | Campos do corpo JSON. Com ele, o wrapper exige `POST` e um objeto com exatamente esses campos (tipos checados, `?` = opcional e anulável). `{}` exige corpo vazio. Sem ele, o corpo não é lido e `input` é `undefined`. |
| `output` | Tipo da resposta: um objeto de campos, um tipo de coluna ou `'void'` (`204`). Omitido: `unknown`. |

Tipos de campo: `uuid`, `text`, `varchar`, `varchar(n)` (tamanho checado), `int`, `smallint`, `bigint`, `serial`, `float`, `decimal`, `numeric`, `numeric(p,s)`, `boolean`, `json`, `jsonb`, `date`, `timestamp`, `timestamptz`, `time`, `text[]`, `int[]`, `uuid[]`, `enum('a','b')`.

## Arquivos gerados {#generated-files}

| Arquivo | Dono | Conteúdo |
| --- | --- | --- |
| `<functions>/_shared/accessnexus.ts` | AccessNexus (regenerado) | `Json`, `FunctionError`, `FunctionContext`; por função, `<Name>Input`, `<Name>Output` e o wrapper `<camelName>(handler)`. Importa `npm:@supabase/server@1`. |
| `<functions>/<name>/index.ts` | Você (escrito uma vez) | `export default { fetch: <camelName>(async () => { throw new FunctionError(501, ...) }) }`. |
| `<functions>/../config.toml` | Compartilhado | Bloco gerenciado de `[functions.<name>] verify_jwt = ...` entre `# >>> accessnexus functions` e `# <<< accessnexus functions`; só quando o arquivo existe. |

`<functions>` é `output.functions` (padrão `./supabase/functions`).

## Wrapper {#wrapper}

```ts
// in _shared/accessnexus.ts
export function inviteMember(
  handler: (input: InviteMemberInput, ctx: FunctionContext, req: Request) =>
    InviteMemberOutput | Response | Promise<InviteMemberOutput | Response>,
): (req: Request) => Promise<Response>;

export class FunctionError extends Error {
  constructor(status: number, code: string, message: string);
}
```

`FunctionContext` é o `SupabaseContext` do `@supabase/server`: `supabase` (como quem chama, o RLS se aplica), `supabaseAdmin` (ignora o RLS), `userClaims`, `jwtClaims`, `authMode`.

Respostas: o valor do handler como JSON (`204` quando ele não retorna nada), um `Response` como está, `FunctionError` como `{ error: { code, message } }` com o status dele, qualquer outra exceção como `500 internal_error` (registrada em log, mensagem oculta). Antes do handler: `401` (credenciais, vindo do `@supabase/server`), `405 method_not_allowed`, `400 invalid_json`, `400 invalid_input` com `issues: { field, message }[]`. CORS e `OPTIONS` são respondidos pelo `withSupabase`.

## SDK {#sdk}

| Acessor | Retorna |
| --- | --- |
| `client.functions.<camelName>(input, { headers?, region? }?)` | `Promise<{ data: <Name>Output \| null; error }>` via `supabase.functions.invoke(name, { body, method: 'POST' })`. `input` é opcional quando a função não tem campos de input. |
| `q.functions.<camelName>.query(input)` | `queryOptions`, key `['accessnexus', 'functions', '<name>', input]`. |
| `q.functions.<camelName>.mutation()` | Opções de mutation; invalida todas as queries do AccessNexus em caso de sucesso. |

Tipos exportados pelo `client.ts`: `<Name>Input`, `<Name>Output`, `FunctionInvokeOptions`. Um client Supabase sem `functions.invoke` (um test double, por exemplo) faz o acessor lançar `[AccessNexus] functions.<name> needs a Supabase client with Edge Functions`.

## Verificações {#checks}

| Código | Severidade | Quando |
| --- | --- | --- |
| `INVALID_EDGE_FUNCTION` | error | Nome inválido, opção desconhecida, `auth` inválido, `input`/`output` que não é objeto, dois nomes com o mesmo camelCase. |
| `UNKNOWN_COLUMN_TYPE` | error | Tipo de campo ou de saída desconhecido. |
| `INVALID_IDENTIFIER` | error | Um nome de campo não é snake_case. |
| `TABLE_NAME_CLASH` | error | Uma tabela chamada `functions` (ou `channels`) ao lado de funções (ou canais) declaradas. |
| `EDGE_FUNCTION_PUBLIC` | warning | `auth` aceita `'none'`. |
