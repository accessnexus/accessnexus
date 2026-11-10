// Edge Function `invite-member`: scaffolded once by AccessNexus — this file is yours.
// The wrapper from _shared/accessnexus.ts (regenerated from the schema) checks auth
// (user), answers CORS, and validates the JSON body before calling you.
// ctx.supabase runs as the caller, so RLS applies.
// ctx.supabaseAdmin bypasses RLS: filter by ctx.userClaims yourself if you use it.
import { FunctionError, inviteMember } from '../_shared/accessnexus.ts';

export default {
  // Handler: (input, ctx, req) => output. Return the output, or throw FunctionError.
  fetch: inviteMember(async () => {
    throw new FunctionError(501, 'not_implemented', 'invite-member is not implemented yet');
  }),
};
