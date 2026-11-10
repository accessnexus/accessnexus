// ============================================
// AccessNexus: Auto-generated client
// DO NOT EDIT — regenerate with `npx accessnexus generate`
// ============================================

import type { Database, Profiles, ProfilesCreate, ProfilesUpdate, Organizations, OrganizationsCreate, OrganizationsUpdate, OrgMembers, OrgMembersCreate, OrgMembersUpdate, Projects, ProjectsCreate, ProjectsUpdate, Tasks, TasksCreate, TasksUpdate, Comments, CommentsCreate, CommentsUpdate, AuditLog, AuditLogCreate, AuditLogUpdate, Invitations, InvitationsCreate, InvitationsUpdate } from './types.js';
export type { Json } from './types.js';
type Tables = Database['public']['Tables'];
type Functions = Database['public']['Functions'];
type TableName = keyof Tables & string;
type RowOf<T extends TableName> = Tables[T]['Row'];
type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;

/** Column names of a table, for the `columns` option of the find* methods. */
export type ColumnsOf<T extends TableName> = readonly (keyof RowOf<T> & string)[];
/** The row narrowed to the selected `columns` (the whole row when omitted). */
export type SelectedRow<T extends TableName, TColumns extends ColumnsOf<T> | undefined> =
  TColumns extends readonly (infer K extends keyof RowOf<T>)[] ? Pick<RowOf<T>, K> : RowOf<T>;
/**
 * Filter of the *One/*Many writes: column → value, naming at least one column
 * of the table (`{}` and unknown columns are type errors).
 */
export type RowFilter<T extends TableName, TFilter> = TFilter
  & { [K in Exclude<keyof TFilter, keyof RowOf<T>>]: never }
  & (keyof TFilter extends never ? { 'filter must name at least one column': never } : unknown);

// Runtime guard of the *One/*Many writes: never update or delete every row.
function requireFilter(filter: object | null | undefined, method: string): object {
  const entries = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    throw new Error(`[AccessNexus] ${method}: the filter must name at least one column (refusing to write every row)`);
  }
  return Object.fromEntries(entries);
}

/** Code of the error a write gets when no row it may change matches (missing, or RLS hides/denies it). */
export const NOT_FOUND_OR_DENIED = 'ACCESSNEXUS_NOT_FOUND_OR_DENIED';
/** Error built by the SDK itself (writes that matched no row the caller may change). */
export type AccessNexusError = { code: string; message: string; details: Record<string, unknown>; hint: string };

function notFoundOrDenied(table: string, method: string, details: Record<string, unknown>): AccessNexusError {
  return {
    code: NOT_FOUND_OR_DENIED,
    message: `${table}.${method}: no row was changed — it does not exist, or RLS does not let you change it`,
    details: { table, method, ...details },
    hint: 'RLS hides rows you may not see and skips rows you may not write; check the row id and the policies.',
  };
}

/** True for the SDK's "no row changed" error (missing row, or denied by RLS). */
export function isNotFoundOrDenied(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === NOT_FOUND_OR_DENIED;
}

/**
 * True when the database refused the request: the SDK's NOT_FOUND_OR_DENIED, or SQLSTATE
 * 42501 (an INSERT / WITH CHECK rejected by RLS, a locked column, a definer RPC check).
 */
export function isAccessDenied(error: unknown): boolean {
  return isNotFoundOrDenied(error) || (!!error && typeof error === 'object' && (error as { code?: unknown }).code === '42501');
}

/** True when a `trigger.lockColumns` guard refused the update (SQLSTATE 42501, stable hint). */
export function isLockedColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; hint?: unknown };
  return e.code === '42501' && typeof e.hint === 'string' && e.hint.startsWith('accessnexus:locked_column:');
}

type RawResult = { data: unknown; error: unknown; count?: number | null };

// One-row writes: no row back (and no error) means nothing was changed.
async function changedOne(table: string, method: string, details: Record<string, unknown>, run: PromiseLike<unknown>): Promise<{ data: unknown; error: unknown }> {
  const res = (await run) as RawResult;
  if (res.error) return { data: null, error: res.error };
  if (res.data === null || res.data === undefined) return { data: null, error: notFoundOrDenied(table, method, details) };
  return { data: res.data, error: null };
}

// DELETE by key: the affected-row count tells a real delete from one RLS skipped.
async function deletedById(table: string, id: unknown, run: PromiseLike<unknown>): Promise<{ data: null; error: unknown }> {
  const res = (await run) as RawResult;
  if (res.error) return { data: null, error: res.error };
  if (res.count === 0) return { data: null, error: notFoundOrDenied(table, 'delete', { id }) };
  return { data: null, error: null };
}

// Soft-delete tables: the trigger turns DELETE into an UPDATE, so the DELETE reports 0 rows
// either way. Look at the live row before and after: gone means deleted, still there means denied.
async function softDeleted(
  table: string, method: string, details: Record<string, unknown>,
  before: () => PromiseLike<unknown>, remove: () => PromiseLike<unknown>, after: () => PromiseLike<unknown>,
): Promise<{ data: unknown; error: unknown }> {
  const pre = (await before()) as RawResult;
  if (pre.error) return { data: null, error: pre.error };
  if (pre.data === null || pre.data === undefined) return { data: null, error: notFoundOrDenied(table, method, details) };
  const del = (await remove()) as RawResult;
  if (del.error) return { data: null, error: del.error };
  const post = (await after()) as RawResult;
  if (post.error) return { data: null, error: post.error };
  if (post.data !== null && post.data !== undefined) return { data: null, error: notFoundOrDenied(table, method, details) };
  return { data: method === 'delete' ? null : pre.data, error: null };
}

// Internal, loosely typed view of the Supabase query builder. Results are
// typed per method below.
interface QueryBuilder extends PromiseLike<unknown> {
  select(columns?: string): QueryBuilder;
  insert(data: object): QueryBuilder;
  update(data: object): QueryBuilder;
  delete(options?: { count?: 'exact' }): QueryBuilder;
  match(filter: object): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  is(column: string, value: null): QueryBuilder;
  single(): QueryBuilder;
  maybeSingle(): QueryBuilder;
}

// Internal, loosely typed view of a supabase-js RealtimeChannel.
interface RealtimeChannelLike {
  on(type: string, filter: object, callback: (payload: unknown) => void): RealtimeChannelLike;
  subscribe(callback?: (status: string, error?: Error) => void): unknown;
}

type AccessNexusTransport = {
  from(table: string): QueryBuilder;
  rpc(name: string, args: object): QueryBuilder;
  channel?(name: string, options?: object): RealtimeChannelLike;
  removeChannel?(channel: RealtimeChannelLike): unknown;
  functions?: { invoke(name: string, options: object): PromiseLike<unknown> };
};

/**
 * Loose shape a real Supabase client satisfies (`createClient`, or
 * `createBrowserClient` / `createServerClient` from @supabase/ssr).
 */
export type AccessNexusProvider = {
  auth: unknown;
  from(table: string): unknown;
  rpc(name: string, args?: object): unknown;
  channel?(name: string, options?: object): unknown;
  removeChannel?(channel: never): unknown;
  functions?: unknown;
};

function realtimeTransport(provider: AccessNexusTransport, what: string): Required<Pick<AccessNexusTransport, 'channel' | 'removeChannel'>> {
  if (typeof provider.channel !== 'function' || typeof provider.removeChannel !== 'function') {
    throw new Error(`[AccessNexus] ${what} needs a Supabase client with Realtime (channel / removeChannel)`);
  }
  return provider as Required<Pick<AccessNexusTransport, 'channel' | 'removeChannel'>>;
}

/** Postgres Changes event to listen to. */
export type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';
type RealtimeMeta = { schema: string; table: string; commit_timestamp: string; errors: string[] | null };
/**
 * One row change. `old` holds only the primary key (RLS tables send no more);
 * DELETE has no `new` row.
 */
export type RealtimeChange<Row> =
  | (RealtimeMeta & { eventType: 'INSERT'; new: Row; old: Record<string, never> })
  | (RealtimeMeta & { eventType: 'UPDATE'; new: Row; old: Partial<Row> })
  | (RealtimeMeta & { eventType: 'DELETE'; new: Record<string, never>; old: Partial<Row> });
/** The change type of `subscribe`, narrowed by its `event` option. */
export type RealtimeChangeOf<Row, TEvent extends RealtimeEvent> =
  TEvent extends '*' ? RealtimeChange<Row> : Extract<RealtimeChange<Row>, { eventType: TEvent }>;
type RealtimeFilterValue<V> = V | readonly V[] | { eq: V } | { neq: V } | { lt: V } | { lte: V } | { gt: V } | { gte: V } | { in: readonly V[] };
/**
 * Server-side filter of `subscribe`: exactly one column (Realtime accepts one),
 * `{ project_id: id }`, `{ status: ['todo', 'done'] }` (in) or `{ views: { gt: 10 } }`.
 * DELETE events ignore filters.
 */
export type RealtimeFilter<Row> = { [K in keyof Row]?: RealtimeFilterValue<NonNullable<Row[K]>> };
/** Options of `subscribe`. */
export type RealtimeSubscribeOptions<Row, TEvent extends RealtimeEvent = '*'> = {
  event?: TEvent;
  filter?: RealtimeFilter<Row>;
  /** Channel status: SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT or CLOSED. */
  onStatus?: (status: string, error?: Error) => void;
};

const REALTIME_OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in']);

function realtimeFilter(filter: object | undefined): string | undefined {
  const entries = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  if (entries.length > 1) {
    throw new Error('[AccessNexus] subscribe: Realtime filters on one column only');
  }
  const [column, value] = entries[0];
  if (value === null) throw new Error(`[AccessNexus] subscribe: cannot filter ${column} on null`);
  if (Array.isArray(value)) return `${column}=in.(${value.map(String).join(',')})`;
  if (typeof value === 'object') {
    const ops = Object.entries(value as Record<string, unknown>);
    if (ops.length === 1 && REALTIME_OPS.has(ops[0][0])) {
      const [op, operand] = ops[0];
      return Array.isArray(operand) ? `${column}=${op}.(${operand.map(String).join(',')})` : `${column}=${op}.${String(operand)}`;
    }
  }
  return `${column}=eq.${String(value)}`;
}

let realtimeSeq = 0;

function realtimeSubscribe(
  provider: AccessNexusTransport,
  schema: string,
  table: string,
  listener: (change: unknown) => void,
  options?: { event?: string; filter?: object; onStatus?: (status: string, error?: Error) => void },
): () => void {
  const realtime = realtimeTransport(provider, `${table}.subscribe`);
  const filter = realtimeFilter(options?.filter);
  realtimeSeq += 1;
  const channel = realtime.channel(`accessnexus:${table}:${realtimeSeq}`);
  channel
    .on('postgres_changes', { event: options?.event ?? '*', schema, table, ...(filter ? { filter } : {}) }, listener)
    .subscribe(options?.onStatus);
  return () => {
    void realtime.removeChannel(channel);
  };
}

/** The provider's own RealtimeChannel type (unknown for a bare AccessNexusProvider). */
export type ChannelOf<TClient extends AccessNexusProvider> =
  TClient['channel'] extends ((...args: never[]) => infer C) | undefined ? C : unknown;

function openChannel(provider: AccessNexusTransport, topic: string): RealtimeChannelLike {
  // Private: Realtime checks the realtime.messages policies on join, send and receive.
  return realtimeTransport(provider, `channel ${topic}`).channel(topic, { config: { private: true } });
}

/** Options of `client.functions.*`: extra headers, or a region (e.g. 'us-east-1'). */
export type FunctionInvokeOptions = { headers?: Record<string, string>; region?: string };

/** Edge Function `invite-member`. */
export type InviteMemberInput = {
  org_id: string;
  email: string;
  role: 'admin' | 'manager' | 'member';
  message?: string | null;
};
export type InviteMemberOutput = {
  invitation_id: string;
};
/** Edge Function `send-digest`. */
export type SendDigestInput = {
  org_id: string;
};
export type SendDigestOutput = void;

function invokeFunction(provider: AccessNexusTransport, name: string, body: unknown, options?: FunctionInvokeOptions): PromiseLike<unknown> {
  if (!provider.functions || typeof provider.functions.invoke !== 'function') {
    throw new Error(`[AccessNexus] functions.${name} needs a Supabase client with Edge Functions (functions.invoke)`);
  }
  return provider.functions.invoke(name, { ...options, body, method: 'POST' });
}

function selectClause(
  columns: readonly string[] | undefined,
  joins?: Record<string, string>,
  include?: Record<string, true | undefined>,
): string {
  // Column names are checked at compile time (ColumnsOf); an empty list means all.
  const parts = columns && columns.length > 0 ? [...columns] : ['*'];
  if (joins && include) {
    for (const key of Object.keys(include)) {
      if (include[key] === true && joins[key]) parts.push(joins[key]);
    }
  }
  return parts.join(', ');
}

type OrganizationsRelations = {
  'owner': RowOf<'profiles'>;
};
export type OrganizationsInclude = Partial<Record<keyof OrganizationsRelations, true>>;
type OrganizationsWithInclude<TInclude extends OrganizationsInclude | undefined, TRow = RowOf<'organizations'>> =
  TRow
  & (TInclude extends { 'owner': true } ? { 'owner': OrganizationsRelations['owner'] | null } : unknown)
;
const organizationsJoins: Record<keyof OrganizationsRelations & string, string> = {
  'owner': 'owner:profiles!organizations_owner_id_fkey(*)',
};

type OrgMembersRelations = {
  'org': RowOf<'organizations'>;
  'user': RowOf<'profiles'>;
  'invited_by': RowOf<'profiles'>;
};
export type OrgMembersInclude = Partial<Record<keyof OrgMembersRelations, true>>;
type OrgMembersWithInclude<TInclude extends OrgMembersInclude | undefined, TRow = RowOf<'org_members'>> =
  TRow
  & (TInclude extends { 'org': true } ? { 'org': OrgMembersRelations['org'] | null } : unknown)
  & (TInclude extends { 'user': true } ? { 'user': OrgMembersRelations['user'] | null } : unknown)
  & (TInclude extends { 'invited_by': true } ? { 'invited_by': OrgMembersRelations['invited_by'] | null } : unknown)
;
const org_membersJoins: Record<keyof OrgMembersRelations & string, string> = {
  'org': 'org:organizations!org_members_org_id_fkey(*)',
  'user': 'user:profiles!org_members_user_id_fkey(*)',
  'invited_by': 'invited_by:profiles!org_members_invited_by_fkey(*)',
};

type ProjectsRelations = {
  'org': RowOf<'organizations'>;
  'created_by': RowOf<'profiles'>;
};
export type ProjectsInclude = Partial<Record<keyof ProjectsRelations, true>>;
type ProjectsWithInclude<TInclude extends ProjectsInclude | undefined, TRow = RowOf<'projects'>> =
  TRow
  & (TInclude extends { 'org': true } ? { 'org': ProjectsRelations['org'] | null } : unknown)
  & (TInclude extends { 'created_by': true } ? { 'created_by': ProjectsRelations['created_by'] | null } : unknown)
;
const projectsJoins: Record<keyof ProjectsRelations & string, string> = {
  'org': 'org:organizations!projects_org_id_fkey(*)',
  'created_by': 'created_by:profiles!projects_created_by_fkey(*)',
};

type TasksRelations = {
  'org': RowOf<'organizations'>;
  'project': RowOf<'projects'>;
  'assignee': RowOf<'profiles'>;
  'reporter': RowOf<'profiles'>;
};
export type TasksInclude = Partial<Record<keyof TasksRelations, true>>;
type TasksWithInclude<TInclude extends TasksInclude | undefined, TRow = RowOf<'tasks'>> =
  TRow
  & (TInclude extends { 'org': true } ? { 'org': TasksRelations['org'] | null } : unknown)
  & (TInclude extends { 'project': true } ? { 'project': TasksRelations['project'] | null } : unknown)
  & (TInclude extends { 'assignee': true } ? { 'assignee': TasksRelations['assignee'] | null } : unknown)
  & (TInclude extends { 'reporter': true } ? { 'reporter': TasksRelations['reporter'] | null } : unknown)
;
const tasksJoins: Record<keyof TasksRelations & string, string> = {
  'org': 'org:organizations!tasks_org_id_fkey(*)',
  'project': 'project:projects!tasks_project_id_fkey(*)',
  'assignee': 'assignee:profiles!tasks_assignee_id_fkey(*)',
  'reporter': 'reporter:profiles!tasks_reporter_id_fkey(*)',
};

type CommentsRelations = {
  'org': RowOf<'organizations'>;
  'task': RowOf<'tasks'>;
  'author': RowOf<'profiles'>;
};
export type CommentsInclude = Partial<Record<keyof CommentsRelations, true>>;
type CommentsWithInclude<TInclude extends CommentsInclude | undefined, TRow = RowOf<'comments'>> =
  TRow
  & (TInclude extends { 'org': true } ? { 'org': CommentsRelations['org'] | null } : unknown)
  & (TInclude extends { 'task': true } ? { 'task': CommentsRelations['task'] | null } : unknown)
  & (TInclude extends { 'author': true } ? { 'author': CommentsRelations['author'] | null } : unknown)
;
const commentsJoins: Record<keyof CommentsRelations & string, string> = {
  'org': 'org:organizations!comments_org_id_fkey(*)',
  'task': 'task:tasks!comments_task_id_fkey(*)',
  'author': 'author:profiles!comments_author_id_fkey(*)',
};

type InvitationsRelations = {
  'org': RowOf<'organizations'>;
  'invited_by': RowOf<'profiles'>;
};
export type InvitationsInclude = Partial<Record<keyof InvitationsRelations, true>>;
type InvitationsWithInclude<TInclude extends InvitationsInclude | undefined, TRow = RowOf<'invitations'>> =
  TRow
  & (TInclude extends { 'org': true } ? { 'org': InvitationsRelations['org'] | null } : unknown)
  & (TInclude extends { 'invited_by': true } ? { 'invited_by': InvitationsRelations['invited_by'] | null } : unknown)
;
const invitationsJoins: Record<keyof InvitationsRelations & string, string> = {
  'org': 'org:organizations!invitations_org_id_fkey(*)',
  'invited_by': 'invited_by:profiles!invitations_invited_by_fkey(*)',
};

export function createAccessNexusClient<TClient extends AccessNexusProvider>(providerRaw: TClient) {
  // Accept a real Supabase client (loose AccessNexusProvider) and use the
  // internal QueryBuilder view for the typed accessors below.
  const provider = providerRaw as unknown as AccessNexusTransport;
  return {
    // Typed as the client you passed in (e.g. SupabaseAuthClient).
    auth: providerRaw.auth as TClient['auth'],

    profiles: {
      findMany: <TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter?: Partial<Profiles>,
        options?: { columns?: TColumns },
      ) =>
        provider.from('profiles').select(selectClause(options?.columns)).match(filter ?? {}) as unknown as QueryResult<SelectedRow<'profiles', TColumns>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter: Partial<Profiles>,
        options?: { columns?: TColumns },
      ) =>
        provider.from('profiles').select(selectClause(options?.columns)).match(filter).maybeSingle() as unknown as QueryResult<SelectedRow<'profiles', TColumns>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns },
      ) =>
        provider.from('profiles').select(selectClause(options?.columns)).eq('id', id).maybeSingle() as unknown as QueryResult<SelectedRow<'profiles', TColumns>>,

      create: (data: ProfilesCreate) =>
        provider.from('profiles').insert(data).select().single() as unknown as QueryResult<Profiles>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: ProfilesUpdate) =>
        changedOne('profiles', 'update', { id }, provider.from('profiles').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<Profiles>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        deletedById('profiles', id, provider.from('profiles').delete({ count: 'exact' }).eq('id', id)) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Profiles>, TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter: RowFilter<'profiles', TFilter>,
        data: ProfilesUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'profiles.updateOne');
        return changedOne('profiles', 'updateOne', { filter: match }, provider.from('profiles').update(data).match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'profiles', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<Profiles>, TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter: RowFilter<'profiles', TFilter>,
        data: ProfilesUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'profiles.updateMany');
        return provider.from('profiles').update(data).match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'profiles', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<Profiles>, TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter: RowFilter<'profiles', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'profiles.deleteOne');
        return changedOne('profiles', 'deleteOne', { filter: match }, provider.from('profiles').delete().match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'profiles', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them.
      deleteMany: <TFilter extends Partial<Profiles>, TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter: RowFilter<'profiles', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'profiles.deleteMany');
        return provider.from('profiles').delete().match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'profiles', TColumns>[]>;
      },
    },

    organizations: {
      findMany: <TColumns extends ColumnsOf<'organizations'> | undefined = undefined, TInclude extends OrganizationsInclude | undefined = undefined>(
        filter?: Partial<Organizations>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('organizations').select(selectClause(options?.columns, organizationsJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter ?? {}) as unknown as QueryResult<OrganizationsWithInclude<TInclude, SelectedRow<'organizations', TColumns>>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'organizations'> | undefined = undefined, TInclude extends OrganizationsInclude | undefined = undefined>(
        filter: Partial<Organizations>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('organizations').select(selectClause(options?.columns, organizationsJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter).maybeSingle() as unknown as QueryResult<OrganizationsWithInclude<TInclude, SelectedRow<'organizations', TColumns>>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'organizations'> | undefined = undefined, TInclude extends OrganizationsInclude | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('organizations').select(selectClause(options?.columns, organizationsJoins, options?.include as Record<string, true | undefined> | undefined)).eq('id', id).maybeSingle() as unknown as QueryResult<OrganizationsWithInclude<TInclude, SelectedRow<'organizations', TColumns>>>,

      create: (data: OrganizationsCreate) =>
        provider.from('organizations').insert(data).select().single() as unknown as QueryResult<Organizations>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: OrganizationsUpdate) =>
        changedOne('organizations', 'update', { id }, provider.from('organizations').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<Organizations>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        deletedById('organizations', id, provider.from('organizations').delete({ count: 'exact' }).eq('id', id)) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Organizations>, TColumns extends ColumnsOf<'organizations'> | undefined = undefined>(
        filter: RowFilter<'organizations', TFilter>,
        data: OrganizationsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'organizations.updateOne');
        return changedOne('organizations', 'updateOne', { filter: match }, provider.from('organizations').update(data).match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'organizations', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<Organizations>, TColumns extends ColumnsOf<'organizations'> | undefined = undefined>(
        filter: RowFilter<'organizations', TFilter>,
        data: OrganizationsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'organizations.updateMany');
        return provider.from('organizations').update(data).match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'organizations', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<Organizations>, TColumns extends ColumnsOf<'organizations'> | undefined = undefined>(
        filter: RowFilter<'organizations', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'organizations.deleteOne');
        return changedOne('organizations', 'deleteOne', { filter: match }, provider.from('organizations').delete().match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'organizations', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them.
      deleteMany: <TFilter extends Partial<Organizations>, TColumns extends ColumnsOf<'organizations'> | undefined = undefined>(
        filter: RowFilter<'organizations', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'organizations.deleteMany');
        return provider.from('organizations').delete().match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'organizations', TColumns>[]>;
      },
    },

    org_members: {
      findMany: <TColumns extends ColumnsOf<'org_members'> | undefined = undefined, TInclude extends OrgMembersInclude | undefined = undefined>(
        filter?: Partial<OrgMembers>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('org_members').select(selectClause(options?.columns, org_membersJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter ?? {}) as unknown as QueryResult<OrgMembersWithInclude<TInclude, SelectedRow<'org_members', TColumns>>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'org_members'> | undefined = undefined, TInclude extends OrgMembersInclude | undefined = undefined>(
        filter: Partial<OrgMembers>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('org_members').select(selectClause(options?.columns, org_membersJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter).maybeSingle() as unknown as QueryResult<OrgMembersWithInclude<TInclude, SelectedRow<'org_members', TColumns>>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'org_members'> | undefined = undefined, TInclude extends OrgMembersInclude | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('org_members').select(selectClause(options?.columns, org_membersJoins, options?.include as Record<string, true | undefined> | undefined)).eq('id', id).maybeSingle() as unknown as QueryResult<OrgMembersWithInclude<TInclude, SelectedRow<'org_members', TColumns>>>,

      create: (data: OrgMembersCreate) =>
        provider.from('org_members').insert(data).select().single() as unknown as QueryResult<OrgMembers>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: OrgMembersUpdate) =>
        changedOne('org_members', 'update', { id }, provider.from('org_members').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<OrgMembers>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        deletedById('org_members', id, provider.from('org_members').delete({ count: 'exact' }).eq('id', id)) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<OrgMembers>, TColumns extends ColumnsOf<'org_members'> | undefined = undefined>(
        filter: RowFilter<'org_members', TFilter>,
        data: OrgMembersUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'org_members.updateOne');
        return changedOne('org_members', 'updateOne', { filter: match }, provider.from('org_members').update(data).match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'org_members', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<OrgMembers>, TColumns extends ColumnsOf<'org_members'> | undefined = undefined>(
        filter: RowFilter<'org_members', TFilter>,
        data: OrgMembersUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'org_members.updateMany');
        return provider.from('org_members').update(data).match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'org_members', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<OrgMembers>, TColumns extends ColumnsOf<'org_members'> | undefined = undefined>(
        filter: RowFilter<'org_members', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'org_members.deleteOne');
        return changedOne('org_members', 'deleteOne', { filter: match }, provider.from('org_members').delete().match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'org_members', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them.
      deleteMany: <TFilter extends Partial<OrgMembers>, TColumns extends ColumnsOf<'org_members'> | undefined = undefined>(
        filter: RowFilter<'org_members', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'org_members.deleteMany');
        return provider.from('org_members').delete().match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'org_members', TColumns>[]>;
      },
    },

    projects: {
      findMany: <TColumns extends ColumnsOf<'projects'> | undefined = undefined, TInclude extends ProjectsInclude | undefined = undefined>(
        filter?: Partial<Projects>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('projects').select(selectClause(options?.columns, projectsJoins, options?.include as Record<string, true | undefined> | undefined)).is('deleted_at', null).match(filter ?? {}) as unknown as QueryResult<ProjectsWithInclude<TInclude, SelectedRow<'projects', TColumns>>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'projects'> | undefined = undefined, TInclude extends ProjectsInclude | undefined = undefined>(
        filter: Partial<Projects>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('projects').select(selectClause(options?.columns, projectsJoins, options?.include as Record<string, true | undefined> | undefined)).is('deleted_at', null).match(filter).maybeSingle() as unknown as QueryResult<ProjectsWithInclude<TInclude, SelectedRow<'projects', TColumns>>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'projects'> | undefined = undefined, TInclude extends ProjectsInclude | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('projects').select(selectClause(options?.columns, projectsJoins, options?.include as Record<string, true | undefined> | undefined)).eq('id', id).is('deleted_at', null).maybeSingle() as unknown as QueryResult<ProjectsWithInclude<TInclude, SelectedRow<'projects', TColumns>>>,

      create: (data: ProjectsCreate) =>
        provider.from('projects').insert(data).select().single() as unknown as QueryResult<Projects>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: ProjectsUpdate) =>
        changedOne('projects', 'update', { id }, provider.from('projects').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<Projects>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        softDeleted('projects', 'delete', { id },
          () => provider.from('projects').select('id').eq('id', id).is('deleted_at', null).maybeSingle(),
          () => provider.from('projects').delete().eq('id', id),
          () => provider.from('projects').select('id').eq('id', id).is('deleted_at', null).maybeSingle(),
        ) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Projects>, TColumns extends ColumnsOf<'projects'> | undefined = undefined>(
        filter: RowFilter<'projects', TFilter>,
        data: ProjectsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'projects.updateOne');
        return changedOne('projects', 'updateOne', { filter: match }, provider.from('projects').update(data).match(match).is('deleted_at', null).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'projects', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<Projects>, TColumns extends ColumnsOf<'projects'> | undefined = undefined>(
        filter: RowFilter<'projects', TFilter>,
        data: ProjectsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'projects.updateMany');
        return provider.from('projects').update(data).match(match).is('deleted_at', null).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'projects', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<Projects>, TColumns extends ColumnsOf<'projects'> | undefined = undefined>(
        filter: RowFilter<'projects', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'projects.deleteOne');
        return softDeleted('projects', 'deleteOne', { filter: match },
          () => provider.from('projects').select(selectClause(options?.columns)).match(match).is('deleted_at', null).maybeSingle(),
          () => provider.from('projects').delete().match(match).is('deleted_at', null),
          () => provider.from('projects').select('id').match(match).is('deleted_at', null).maybeSingle(),
        ) as unknown as QueryResult<SelectedRow<'projects', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them (`[]` on this soft-delete table).
      deleteMany: <TFilter extends Partial<Projects>, TColumns extends ColumnsOf<'projects'> | undefined = undefined>(
        filter: RowFilter<'projects', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'projects.deleteMany');
        return provider.from('projects').delete().match(match).is('deleted_at', null).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'projects', TColumns>[]>;
      },
    },

    tasks: {
      findMany: <TColumns extends ColumnsOf<'tasks'> | undefined = undefined, TInclude extends TasksInclude | undefined = undefined>(
        filter?: Partial<Tasks>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('tasks').select(selectClause(options?.columns, tasksJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter ?? {}) as unknown as QueryResult<TasksWithInclude<TInclude, SelectedRow<'tasks', TColumns>>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'tasks'> | undefined = undefined, TInclude extends TasksInclude | undefined = undefined>(
        filter: Partial<Tasks>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('tasks').select(selectClause(options?.columns, tasksJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter).maybeSingle() as unknown as QueryResult<TasksWithInclude<TInclude, SelectedRow<'tasks', TColumns>>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'tasks'> | undefined = undefined, TInclude extends TasksInclude | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('tasks').select(selectClause(options?.columns, tasksJoins, options?.include as Record<string, true | undefined> | undefined)).eq('id', id).maybeSingle() as unknown as QueryResult<TasksWithInclude<TInclude, SelectedRow<'tasks', TColumns>>>,

      create: (data: TasksCreate) =>
        provider.from('tasks').insert(data).select().single() as unknown as QueryResult<Tasks>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: TasksUpdate) =>
        changedOne('tasks', 'update', { id }, provider.from('tasks').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<Tasks>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        deletedById('tasks', id, provider.from('tasks').delete({ count: 'exact' }).eq('id', id)) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Tasks>, TColumns extends ColumnsOf<'tasks'> | undefined = undefined>(
        filter: RowFilter<'tasks', TFilter>,
        data: TasksUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'tasks.updateOne');
        return changedOne('tasks', 'updateOne', { filter: match }, provider.from('tasks').update(data).match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'tasks', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<Tasks>, TColumns extends ColumnsOf<'tasks'> | undefined = undefined>(
        filter: RowFilter<'tasks', TFilter>,
        data: TasksUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'tasks.updateMany');
        return provider.from('tasks').update(data).match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'tasks', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<Tasks>, TColumns extends ColumnsOf<'tasks'> | undefined = undefined>(
        filter: RowFilter<'tasks', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'tasks.deleteOne');
        return changedOne('tasks', 'deleteOne', { filter: match }, provider.from('tasks').delete().match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'tasks', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them.
      deleteMany: <TFilter extends Partial<Tasks>, TColumns extends ColumnsOf<'tasks'> | undefined = undefined>(
        filter: RowFilter<'tasks', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'tasks.deleteMany');
        return provider.from('tasks').delete().match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'tasks', TColumns>[]>;
      },

      // Row changes over Supabase Realtime (Postgres Changes), only for rows the
      // SELECT policy shows. DELETE events are not RLS-filtered and carry only the
      // primary key. Returns a function that unsubscribes.
      subscribe: <TEvent extends RealtimeEvent = '*'>(
        listener: (change: RealtimeChangeOf<RowOf<'tasks'>, TEvent>) => void,
        options?: RealtimeSubscribeOptions<RowOf<'tasks'>, TEvent>,
      ) =>
        realtimeSubscribe(provider, 'public', 'tasks', listener as (change: unknown) => void, options),
    },

    comments: {
      findMany: <TColumns extends ColumnsOf<'comments'> | undefined = undefined, TInclude extends CommentsInclude | undefined = undefined>(
        filter?: Partial<Comments>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('comments').select(selectClause(options?.columns, commentsJoins, options?.include as Record<string, true | undefined> | undefined)).is('deleted_at', null).match(filter ?? {}) as unknown as QueryResult<CommentsWithInclude<TInclude, SelectedRow<'comments', TColumns>>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'comments'> | undefined = undefined, TInclude extends CommentsInclude | undefined = undefined>(
        filter: Partial<Comments>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('comments').select(selectClause(options?.columns, commentsJoins, options?.include as Record<string, true | undefined> | undefined)).is('deleted_at', null).match(filter).maybeSingle() as unknown as QueryResult<CommentsWithInclude<TInclude, SelectedRow<'comments', TColumns>>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'comments'> | undefined = undefined, TInclude extends CommentsInclude | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('comments').select(selectClause(options?.columns, commentsJoins, options?.include as Record<string, true | undefined> | undefined)).eq('id', id).is('deleted_at', null).maybeSingle() as unknown as QueryResult<CommentsWithInclude<TInclude, SelectedRow<'comments', TColumns>>>,

      create: (data: CommentsCreate) =>
        provider.from('comments').insert(data).select().single() as unknown as QueryResult<Comments>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: CommentsUpdate) =>
        changedOne('comments', 'update', { id }, provider.from('comments').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<Comments>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        softDeleted('comments', 'delete', { id },
          () => provider.from('comments').select('id').eq('id', id).is('deleted_at', null).maybeSingle(),
          () => provider.from('comments').delete().eq('id', id),
          () => provider.from('comments').select('id').eq('id', id).is('deleted_at', null).maybeSingle(),
        ) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Comments>, TColumns extends ColumnsOf<'comments'> | undefined = undefined>(
        filter: RowFilter<'comments', TFilter>,
        data: CommentsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'comments.updateOne');
        return changedOne('comments', 'updateOne', { filter: match }, provider.from('comments').update(data).match(match).is('deleted_at', null).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'comments', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<Comments>, TColumns extends ColumnsOf<'comments'> | undefined = undefined>(
        filter: RowFilter<'comments', TFilter>,
        data: CommentsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'comments.updateMany');
        return provider.from('comments').update(data).match(match).is('deleted_at', null).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'comments', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<Comments>, TColumns extends ColumnsOf<'comments'> | undefined = undefined>(
        filter: RowFilter<'comments', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'comments.deleteOne');
        return softDeleted('comments', 'deleteOne', { filter: match },
          () => provider.from('comments').select(selectClause(options?.columns)).match(match).is('deleted_at', null).maybeSingle(),
          () => provider.from('comments').delete().match(match).is('deleted_at', null),
          () => provider.from('comments').select('id').match(match).is('deleted_at', null).maybeSingle(),
        ) as unknown as QueryResult<SelectedRow<'comments', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them (`[]` on this soft-delete table).
      deleteMany: <TFilter extends Partial<Comments>, TColumns extends ColumnsOf<'comments'> | undefined = undefined>(
        filter: RowFilter<'comments', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'comments.deleteMany');
        return provider.from('comments').delete().match(match).is('deleted_at', null).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'comments', TColumns>[]>;
      },

      // Row changes over Supabase Realtime (Postgres Changes), only for rows the
      // SELECT policy shows. DELETE events are not RLS-filtered and carry only the
      // primary key. Returns a function that unsubscribes.
      subscribe: <TEvent extends RealtimeEvent = '*'>(
        listener: (change: RealtimeChangeOf<RowOf<'comments'>, TEvent>) => void,
        options?: RealtimeSubscribeOptions<RowOf<'comments'>, TEvent>,
      ) =>
        realtimeSubscribe(provider, 'public', 'comments', listener as (change: unknown) => void, options),
    },

    audit_log: {
      findMany: <TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter?: Partial<AuditLog>,
        options?: { columns?: TColumns },
      ) =>
        provider.from('audit_log').select(selectClause(options?.columns)).match(filter ?? {}) as unknown as QueryResult<SelectedRow<'audit_log', TColumns>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter: Partial<AuditLog>,
        options?: { columns?: TColumns },
      ) =>
        provider.from('audit_log').select(selectClause(options?.columns)).match(filter).maybeSingle() as unknown as QueryResult<SelectedRow<'audit_log', TColumns>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns },
      ) =>
        provider.from('audit_log').select(selectClause(options?.columns)).eq('id', id).maybeSingle() as unknown as QueryResult<SelectedRow<'audit_log', TColumns>>,

      create: (data: AuditLogCreate) =>
        provider.from('audit_log').insert(data).select().single() as unknown as QueryResult<AuditLog>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: AuditLogUpdate) =>
        changedOne('audit_log', 'update', { id }, provider.from('audit_log').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<AuditLog>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        deletedById('audit_log', id, provider.from('audit_log').delete({ count: 'exact' }).eq('id', id)) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<AuditLog>, TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter: RowFilter<'audit_log', TFilter>,
        data: AuditLogUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'audit_log.updateOne');
        return changedOne('audit_log', 'updateOne', { filter: match }, provider.from('audit_log').update(data).match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'audit_log', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<AuditLog>, TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter: RowFilter<'audit_log', TFilter>,
        data: AuditLogUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'audit_log.updateMany');
        return provider.from('audit_log').update(data).match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'audit_log', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<AuditLog>, TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter: RowFilter<'audit_log', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'audit_log.deleteOne');
        return changedOne('audit_log', 'deleteOne', { filter: match }, provider.from('audit_log').delete().match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'audit_log', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them.
      deleteMany: <TFilter extends Partial<AuditLog>, TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter: RowFilter<'audit_log', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'audit_log.deleteMany');
        return provider.from('audit_log').delete().match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'audit_log', TColumns>[]>;
      },
    },

    invitations: {
      findMany: <TColumns extends ColumnsOf<'invitations'> | undefined = undefined, TInclude extends InvitationsInclude | undefined = undefined>(
        filter?: Partial<Invitations>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('invitations').select(selectClause(options?.columns, invitationsJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter ?? {}) as unknown as QueryResult<InvitationsWithInclude<TInclude, SelectedRow<'invitations', TColumns>>[]>,

      // The row matching `filter`, or `data: null` (no error) when none does;
      // more than one match is an error (PGRST116): filter on a unique column.
      findOne: <TColumns extends ColumnsOf<'invitations'> | undefined = undefined, TInclude extends InvitationsInclude | undefined = undefined>(
        filter: Partial<Invitations>,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('invitations').select(selectClause(options?.columns, invitationsJoins, options?.include as Record<string, true | undefined> | undefined)).match(filter).maybeSingle() as unknown as QueryResult<InvitationsWithInclude<TInclude, SelectedRow<'invitations', TColumns>>>,

      // `data: null` (no error) when the row does not exist or is not visible.
      findById: <TColumns extends ColumnsOf<'invitations'> | undefined = undefined, TInclude extends InvitationsInclude | undefined = undefined>(
        id: string,
        options?: { columns?: TColumns; include?: TInclude },
      ) =>
        provider.from('invitations').select(selectClause(options?.columns, invitationsJoins, options?.include as Record<string, true | undefined> | undefined)).eq('id', id).maybeSingle() as unknown as QueryResult<InvitationsWithInclude<TInclude, SelectedRow<'invitations', TColumns>>>,

      create: (data: InvitationsCreate) =>
        provider.from('invitations').insert(data).select().single() as unknown as QueryResult<Invitations>,

      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed
      // (it does not exist, or RLS hides it / denies the update).
      update: (id: string, data: InvitationsUpdate) =>
        changedOne('invitations', 'update', { id }, provider.from('invitations').update(data).eq('id', id).select().maybeSingle()) as unknown as QueryResult<Invitations>,

      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).
      delete: (id: string) =>
        deletedById('invitations', id, provider.from('invitations').delete({ count: 'exact' }).eq('id', id)) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than
      // one match is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Invitations>, TColumns extends ColumnsOf<'invitations'> | undefined = undefined>(
        filter: RowFilter<'invitations', TFilter>,
        data: InvitationsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'invitations.updateOne');
        return changedOne('invitations', 'updateOne', { filter: match }, provider.from('invitations').update(data).match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'invitations', TColumns>>;
      },

      // Updates every row matching `filter` (at least one column) and returns them.
      updateMany: <TFilter extends Partial<Invitations>, TColumns extends ColumnsOf<'invitations'> | undefined = undefined>(
        filter: RowFilter<'invitations', TFilter>,
        data: InvitationsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'invitations.updateMany');
        return provider.from('invitations').update(data).match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'invitations', TColumns>[]>;
      },

      // Deletes the row matching `filter` and returns it; error NOT_FOUND_OR_DENIED
      // when nothing was deleted. More than one match is an error (PGRST116).
      deleteOne: <TFilter extends Partial<Invitations>, TColumns extends ColumnsOf<'invitations'> | undefined = undefined>(
        filter: RowFilter<'invitations', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'invitations.deleteOne');
        return changedOne('invitations', 'deleteOne', { filter: match }, provider.from('invitations').delete().match(match).select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<SelectedRow<'invitations', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them.
      deleteMany: <TFilter extends Partial<Invitations>, TColumns extends ColumnsOf<'invitations'> | undefined = undefined>(
        filter: RowFilter<'invitations', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'invitations.deleteMany');
        return provider.from('invitations').delete().match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'invitations', TColumns>[]>;
      },
    },

    rpc: {
      get_org_dashboard: (args: Functions['get_org_dashboard']['Args']) =>
        provider.rpc('get_org_dashboard', args) as unknown as QueryResult<Functions['get_org_dashboard']['Returns']>,

      accept_invitation: (args: Functions['accept_invitation']['Args']) =>
        provider.rpc('accept_invitation', args) as unknown as QueryResult<Functions['accept_invitation']['Returns']>,

      search_tasks: (args: Functions['search_tasks']['Args']) =>
        provider.rpc('search_tasks', args) as unknown as QueryResult<Functions['search_tasks']['Returns']>,

    },

    // Private Realtime channels (Broadcast / Presence). Who may join, receive
    // and send is decided by the realtime.messages policies of the schema.
    channels: {
      project_room: (id: string) =>
        openChannel(provider, 'project:' + id) as ChannelOf<TClient>,
      org_announcements: (id: string) =>
        openChannel(provider, 'org:' + id) as ChannelOf<TClient>,
    },

    // Edge Functions declared in the schema (POST, JSON). Errors come back in
    // `error` (supabase-js FunctionsHttpError: `await error.context.json()` is
    // `{ error: { code, message, issues? } }`).
    functions: {
      inviteMember: (input: InviteMemberInput, options?: FunctionInvokeOptions) =>
        invokeFunction(provider, 'invite-member', input, options) as unknown as QueryResult<InviteMemberOutput>,
      sendDigest: (input: SendDigestInput, options?: FunctionInvokeOptions) =>
        invokeFunction(provider, 'send-digest', input, options) as unknown as QueryResult<SendDigestOutput>,
    },

  };
}

/**
 * Type of a client from `createAccessNexusClient`. Pass your Supabase client type
 * to keep `auth` typed: `AccessNexusClient<SupabaseClient<Database>>`.
 */
export type AccessNexusClient<TClient extends AccessNexusProvider = AccessNexusProvider> =
  ReturnType<typeof createAccessNexusClient<TClient>>;