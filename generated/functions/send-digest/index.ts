// Edge Function `send-digest`: scaffolded once by AccessNexus — this file is yours.
// The wrapper from _shared/accessnexus.ts (regenerated from the schema) checks auth
// (secret), answers CORS, and validates the JSON body before calling you.
// ctx.supabase runs as the caller, so RLS applies. Without a user (publishable/secret/none) it has no user.
// ctx.supabaseAdmin bypasses RLS: filter by ctx.userClaims yourself if you use it.
import { FunctionError, sendDigest } from '../_shared/accessnexus.ts';

export default {
  // Handler: (input, ctx, req) => output. Return the output, or throw FunctionError.
  fetch: sendDigest(async () => {
    throw new FunctionError(501, 'not_implemented', 'send-digest is not implemented yet');
  }),
};
