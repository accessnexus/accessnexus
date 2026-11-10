# edgeFunction

Declares a Supabase Edge Function in the schema. For the walkthrough, see the [Edge Functions guide](/guide/edge-functions).

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

Pass functions to `defineSchema(tables, { functions: { '<name>': edgeFunction({ ... }) } })`.

| Option | Description |
| --- | --- |
| `auth` | Who may call: passed to `withSupabase({ auth })` of `@supabase/server`. An array accepts any listed mode; `'none'` must be last. `verify_jwt = false` only when `'none'` is accepted. |
| `input` | JSON body fields. With it, the wrapper requires `POST` and an object of exactly these fields (types checked, `?` = optional and nullable). `{}` requires an empty body. Without it, the body is left unread and `input` is `undefined`. |
| `output` | Response type: an object of fields, one column type, or `'void'` (`204`). Omitted: `unknown`. |

Field types: `uuid`, `text`, `varchar`, `varchar(n)` (length checked), `int`, `smallint`, `bigint`, `serial`, `float`, `decimal`, `numeric`, `numeric(p,s)`, `boolean`, `json`, `jsonb`, `date`, `timestamp`, `timestamptz`, `time`, `text[]`, `int[]`, `uuid[]`, `enum('a','b')`.

## Generated files

| File | Owner | Contents |
| --- | --- | --- |
| `<functions>/_shared/accessnexus.ts` | AccessNexus (regenerated) | `Json`, `FunctionError`, `FunctionContext`; per function `<Name>Input`, `<Name>Output` and the wrapper `<camelName>(handler)`. Imports `npm:@supabase/server@1`. |
| `<functions>/<name>/index.ts` | You (written once) | `export default { fetch: <camelName>(async () => { throw new FunctionError(501, ...) }) }`. |
| `<functions>/../config.toml` | Shared | Managed block of `[functions.<name>] verify_jwt = ...` between `# >>> accessnexus functions` and `# <<< accessnexus functions`; only when the file exists. |

`<functions>` is `output.functions` (default `./supabase/functions`).

## Wrapper

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

`FunctionContext` is `SupabaseContext` from `@supabase/server`: `supabase` (as the caller, RLS applies), `supabaseAdmin` (bypasses RLS), `userClaims`, `jwtClaims`, `authMode`.

Responses: the handler's value as JSON (`204` when it returns nothing), a `Response` as is, `FunctionError` as `{ error: { code, message } }` with its status, any other exception as `500 internal_error` (logged, message hidden). Before the handler: `401` (credentials, from `@supabase/server`), `405 method_not_allowed`, `400 invalid_json`, `400 invalid_input` with `issues: { field, message }[]`. CORS and `OPTIONS` are answered by `withSupabase`.

## SDK

| Accessor | Returns |
| --- | --- |
| `client.functions.<camelName>(input, { headers?, region? }?)` | `Promise<{ data: <Name>Output \| null; error }>` via `supabase.functions.invoke(name, { body, method: 'POST' })`. `input` is optional when the function has no input fields. |
| `q.functions.<camelName>.query(input)` | `queryOptions`, key `['accessnexus', 'functions', '<name>', input]`. |
| `q.functions.<camelName>.mutation()` | Mutation options; invalidates every AccessNexus query on success. |

Types exported by `client.ts`: `<Name>Input`, `<Name>Output`, `FunctionInvokeOptions`. A Supabase client without `functions.invoke` (a test double, for example) makes the accessor throw `[AccessNexus] functions.<name> needs a Supabase client with Edge Functions`.

## Checks

| Code | Severity | When |
| --- | --- | --- |
| `INVALID_EDGE_FUNCTION` | error | Bad name, unknown option, invalid `auth`, `input`/`output` not an object, two names with the same camelCase. |
| `UNKNOWN_COLUMN_TYPE` | error | Unknown field or output type. |
| `INVALID_IDENTIFIER` | error | A field name is not snake_case. |
| `TABLE_NAME_CLASH` | error | A table named `functions` (or `channels`) next to declared functions (or channels). |
| `EDGE_FUNCTION_PUBLIC` | warning | `auth` accepts `'none'`. |
