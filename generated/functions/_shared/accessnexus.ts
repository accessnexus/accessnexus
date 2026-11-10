// ============================================
// AccessNexus: Auto-generated Edge Function wrappers
// DO NOT EDIT — regenerate with `npx accessnexus generate`
// Runs on Supabase Edge Functions (Deno) with @supabase/server.
// ============================================

import { withSupabase, type SupabaseContext } from 'npm:@supabase/server@1';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Throw from a handler to answer with this HTTP status and `{ error: { code, message } }`. */
export class FunctionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'FunctionError';
  }
}

/** What a handler receives besides its input: the @supabase/server context. */
export type FunctionContext = SupabaseContext;
type Handler<I, O> = (input: I, ctx: FunctionContext, req: Request) => O | Response | Promise<O | Response>;
type Field = { type: string; optional: boolean; values?: readonly string[]; maxLength?: number };
type Issue = { field: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function validValue(field: Field, value: unknown): boolean {
  switch (field.type) {
    case 'uuid': return typeof value === 'string' && UUID.test(value);
    case 'text': return typeof value === 'string';
    case 'varchar': return typeof value === 'string' && (field.maxLength === undefined || value.length <= field.maxLength);
    case 'int': case 'smallint': case 'bigint': case 'serial': return Number.isSafeInteger(value);
    case 'float': case 'decimal': case 'numeric': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'json': case 'jsonb': return value !== undefined;
    case 'date': return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value));
    case 'timestamp': case 'timestamptz': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'time': return typeof value === 'string' && TIME.test(value);
    case 'enum': return typeof value === 'string' && (field.values ?? []).includes(value);
    case 'text[]': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'int[]': return Array.isArray(value) && value.every((v) => Number.isSafeInteger(v));
    case 'uuid[]': return Array.isArray(value) && value.every((v) => typeof v === 'string' && UUID.test(v));
    default: return false;
  }
}

function validate(spec: Record<string, Field>, body: unknown): Issue[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [{ field: '(body)', message: 'expected a JSON object' }];
  }
  const issues: Issue[] = [];
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(spec, key)) issues.push({ field: key, message: 'unknown field' });
  }
  for (const [key, field] of Object.entries(spec)) {
    const value = record[key];
    if (value === undefined || value === null) {
      if (!field.optional) issues.push({ field: key, message: value === null ? 'must not be null' : 'is required' });
      continue;
    }
    if (!validValue(field, value)) {
      issues.push({ field: key, message: field.values ? `must be one of: ${field.values.join(', ')}` : `must be ${field.type}` });
    }
  }
  return issues;
}

function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

// With an input spec: POST + JSON body, validated before the handler runs.
// Without one (`input` omitted): the body is left unread for the handler (e.g. a
// webhook verifying a signature over the raw body), and `input` is undefined.
async function run<I, O>(req: Request, ctx: FunctionContext, spec: Record<string, Field> | null, handler: Handler<I, O>): Promise<Response> {
  let body: unknown = undefined;
  if (spec) {
    if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'Use POST with a JSON body');
    const text = await req.text();
    body = {};
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        return errorResponse(400, 'invalid_json', 'The request body is not valid JSON');
      }
    }
    const issues = validate(spec, body);
    if (issues.length > 0) return errorResponse(400, 'invalid_input', 'The request body does not match the function input', { issues });
  }
  try {
    const result = await handler(body as I, ctx, req);
    if (result instanceof Response) return result;
    return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);
  } catch (err) {
    if (err instanceof FunctionError) return errorResponse(err.status, err.code, err.message);
    console.error(err);
    return errorResponse(500, 'internal_error', 'Internal error');
  }
}

// ---- invite-member ----

export type InviteMemberInput = {
  org_id: string;
  email: string;
  role: 'admin' | 'manager' | 'member';
  message?: string | null;
};
export type InviteMemberOutput = {
  invitation_id: string;
};
const INVITE_MEMBER_INPUT: Record<string, Field> = {
  org_id: { type: 'uuid', optional: false },
  email: { type: 'text', optional: false },
  role: { type: 'enum', optional: false, values: ['admin', 'manager', 'member'] },
  message: { type: 'text', optional: true },
};

/**
 * `invite-member` (auth: user). Validates the JSON body as InviteMemberInput,
 * then calls `handler(input, ctx, req)`: `ctx.supabase` runs as the caller (RLS),
 * `ctx.supabaseAdmin` bypasses RLS. Return InviteMemberOutput (or a Response), or throw FunctionError.
 */
export function inviteMember(handler: Handler<InviteMemberInput, InviteMemberOutput>): (req: Request) => Promise<Response> {
  return withSupabase({ auth: 'user' }, (req, ctx) => run(req, ctx, INVITE_MEMBER_INPUT, handler));
}

// ---- send-digest ----

export type SendDigestInput = {
  org_id: string;
};
export type SendDigestOutput = void;
const SEND_DIGEST_INPUT: Record<string, Field> = {
  org_id: { type: 'uuid', optional: false },
};

/**
 * `send-digest` (auth: secret). Validates the JSON body as SendDigestInput,
 * then calls `handler(input, ctx, req)`: `ctx.supabase` runs as the caller (RLS),
 * `ctx.supabaseAdmin` bypasses RLS. Return SendDigestOutput (or a Response), or throw FunctionError.
 */
export function sendDigest(handler: Handler<SendDigestInput, SendDigestOutput>): (req: Request) => Promise<Response> {
  return withSupabase({ auth: 'secret' }, (req, ctx) => run(req, ctx, SEND_DIGEST_INPUT, handler));
}
