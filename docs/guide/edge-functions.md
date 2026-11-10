# Edge Functions

Supabase Edge Functions run your server code (Deno) next to the database. AccessNexus lets you declare each function in the schema: who may call it, the shape of its JSON input, and the shape of its output. `generate` turns that into:

- `supabase/functions/_shared/accessnexus.ts`: a typed wrapper per function, built on `withSupabase` from [`@supabase/server`](https://github.com/supabase/server) (the approach the Supabase docs recommend). It checks the caller's credentials, answers CORS, validates the JSON body, and gives your handler an RLS-scoped client. Regenerated, never edited.
- `supabase/functions/<name>/index.ts`: a scaffold written once, when the file is missing. After that it is your code; `generate` never touches it again.
- `supabase/config.toml`: a managed block with `verify_jwt` for each function.
- `client.functions.<name>(input)` in the SDK, typed from the same declaration.

Deploying stays with the Supabase CLI (`supabase functions deploy`); `push` only touches the database.

## Declare a function

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

Function names are lowercase letters and digits joined by `-` or `_` (Supabase recommends hyphens). In the SDK and the wrappers they become camelCase: `invite-member` → `inviteMember`.

### auth

| Value | Who may call | `ctx.supabase` |
| --- | --- | --- |
| `'user'` (default) | Requests with a signed-in user's JWT | Runs as that user: RLS applies |
| `'publishable'` | Requests with a publishable key (no user needed) | No user |
| `'secret'` | Servers holding a secret key (cron jobs, other backends) | No user |
| `'none'` | Anyone, e.g. a webhook that verifies its own signature | No user |
| `['publishable', 'secret']` | Any of the listed modes (`'none'` must come last) | Depends on the caller |

Requests that do not match are answered `401` by `withSupabase` before your handler runs. `verify_jwt` in `config.toml` is `true` for every function except those that accept `'none'`; `validate` warns `EDGE_FUNCTION_PUBLIC` for those.

### input and output

`input` maps field names to the same column types tables use (`'uuid'`, `'text'`, `'int'`, `'boolean'`, `'jsonb'`, `'date'`, `'timestamptz'`, `'text[]'`, `"enum('a','b')"`, `'varchar(20)'`, ...). A trailing `?` makes a field optional and nullable.

| `input` | The wrapper |
| --- | --- |
| `{ field: 'type', ... }` | Requires `POST` with a JSON object of exactly these fields, checked by type. Anything else is rejected with `400` before your handler runs. |
| `{}` | Requires `POST` with an empty body or `{}`. |
| left out | Does not read the body: your handler reads `req` itself (for example `await req.text()` to verify a webhook signature) and `input` is `undefined`. |

`output` is an object of fields, a single column type (`'jsonb'`), or `'void'` (the wrapper answers `204`). Leave it out for an untyped response.

## Implement it

The first `generate` writes a scaffold that answers `501`. Replace the handler body:

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

The handler receives `(input, ctx, req)`:

- `ctx.supabase` runs as the caller, so the table's RLS decides what it may read and write.
- `ctx.supabaseAdmin` bypasses RLS. If you use it, filter by `ctx.userClaims` yourself.
- `ctx.userClaims` holds the caller's identity (`id`, `email`, `role`), or `null` without a user.

Return the output, which the wrapper sends as JSON, or return a `Response` for full control. `throw new FunctionError(status, code, message)` answers with that status and `{ error: { code, message } }`. Any other exception answers `500` with a generic message and logs the error, so internal details never reach the caller.

### Errors the wrapper sends

| Status | `error.code` | When |
| --- | --- | --- |
| 401 | (from `@supabase/server`) | The request lacks the credential `auth` requires. |
| 405 | `method_not_allowed` | Not `POST` (functions with an `input` spec). |
| 400 | `invalid_json` | The body is not JSON. |
| 400 | `invalid_input` | The body does not match `input`; `error.issues` lists `{ field, message }` for each problem. |
| yours | yours | A `FunctionError` you threw. |
| 500 | `internal_error` | Any other exception (logged, not exposed). |

## Call it from the app

```ts
const { data, error } = await db.functions.inviteMember({
  org_id: orgId,
  email: 'new@example.com',
  role: 'member',
});
// data: { invitation_id: string } | null
```

The call is `supabase.functions.invoke('invite-member', { body, method: 'POST' })`, so supabase-js sends the signed-in user's JWT for you. The input type is checked at compile time; the wrapper checks it again at runtime. On failure, `error` is the supabase-js `FunctionsHttpError`, and `await error.context.json()` gives `{ error: { code, message, issues? } }`. `db.functions.x(input, { headers, region })` passes extra headers or a region.

With [TanStack Query helpers](/api/sdk#tanstack-query-react-query) on, `q.functions.inviteMember.mutation()` and `q.functions.publicStats.query(input)` are ready-made options. A mutation invalidates every AccessNexus query, because a function can write anywhere.

## supabase/config.toml

If `supabase/config.toml` exists (run `supabase init`), `generate` keeps this block in it:

```toml
# >>> accessnexus functions (generated — edit the schema, not this block)
[functions.invite-member]
verify_jwt = true

[functions.stripe-webhook]
verify_jwt = false
# <<< accessnexus functions
```

The rest of the file is never changed. If you already have a `[functions.<name>]` table outside the block, it is left as is and the block carries a comment telling you which `verify_jwt` value to set there.

## Folders

Functions go to `output.functions` (default `./supabase/functions`, where the Supabase CLI deploys from). `config.toml` is read from the parent folder. `generate --sql-only` skips them.

## Related

- [edgeFunction reference](/api/edge-functions)
- [Generated SDK](/api/sdk#edge-functions)
- [Security model](/guide/security#edge-functions-check-the-caller-first)
