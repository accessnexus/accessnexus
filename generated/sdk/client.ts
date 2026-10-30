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

// Internal, loosely typed view of the Supabase query builder. Results are
// typed per method below.
interface QueryBuilder extends PromiseLike<unknown> {
  select(columns?: string): QueryBuilder;
  insert(data: object): QueryBuilder;
  update(data: object): QueryBuilder;
  delete(): QueryBuilder;
  match(filter: object): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  is(column: string, value: null): QueryBuilder;
  single(): QueryBuilder;
  maybeSingle(): QueryBuilder;
}

type AccessNexusTransport = {
  from(table: string): QueryBuilder;
  rpc(name: string, args: object): QueryBuilder;
};

/**
 * Loose shape a real Supabase client satisfies (`createClient`, or
 * `createBrowserClient` / `createServerClient` from @supabase/ssr).
 */
export type AccessNexusProvider = {
  auth: unknown;
  from(table: string): unknown;
  rpc(name: string, args?: object): unknown;
};

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
type OrganizationsInclude = Partial<Record<keyof OrganizationsRelations, true>>;
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
type OrgMembersInclude = Partial<Record<keyof OrgMembersRelations, true>>;
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
type ProjectsInclude = Partial<Record<keyof ProjectsRelations, true>>;
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
type TasksInclude = Partial<Record<keyof TasksRelations, true>>;
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
type CommentsInclude = Partial<Record<keyof CommentsRelations, true>>;
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
type InvitationsInclude = Partial<Record<keyof InvitationsRelations, true>>;
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

      update: (id: string, data: ProfilesUpdate) =>
        provider.from('profiles').update(data).eq('id', id).select().single() as unknown as QueryResult<Profiles>,

      delete: (id: string) =>
        provider.from('profiles').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Profiles>, TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter: RowFilter<'profiles', TFilter>,
        data: ProfilesUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'profiles.updateOne');
        return provider.from('profiles').update(data).match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'profiles', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<Profiles>, TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(
        filter: RowFilter<'profiles', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'profiles.deleteOne');
        return provider.from('profiles').delete().match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'profiles', TColumns>>;
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

      update: (id: string, data: OrganizationsUpdate) =>
        provider.from('organizations').update(data).eq('id', id).select().single() as unknown as QueryResult<Organizations>,

      delete: (id: string) =>
        provider.from('organizations').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Organizations>, TColumns extends ColumnsOf<'organizations'> | undefined = undefined>(
        filter: RowFilter<'organizations', TFilter>,
        data: OrganizationsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'organizations.updateOne');
        return provider.from('organizations').update(data).match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'organizations', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<Organizations>, TColumns extends ColumnsOf<'organizations'> | undefined = undefined>(
        filter: RowFilter<'organizations', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'organizations.deleteOne');
        return provider.from('organizations').delete().match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'organizations', TColumns>>;
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

      update: (id: string, data: OrgMembersUpdate) =>
        provider.from('org_members').update(data).eq('id', id).select().single() as unknown as QueryResult<OrgMembers>,

      delete: (id: string) =>
        provider.from('org_members').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<OrgMembers>, TColumns extends ColumnsOf<'org_members'> | undefined = undefined>(
        filter: RowFilter<'org_members', TFilter>,
        data: OrgMembersUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'org_members.updateOne');
        return provider.from('org_members').update(data).match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'org_members', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<OrgMembers>, TColumns extends ColumnsOf<'org_members'> | undefined = undefined>(
        filter: RowFilter<'org_members', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'org_members.deleteOne');
        return provider.from('org_members').delete().match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'org_members', TColumns>>;
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

      update: (id: string, data: ProjectsUpdate) =>
        provider.from('projects').update(data).eq('id', id).select().single() as unknown as QueryResult<Projects>,

      delete: (id: string) =>
        provider.from('projects').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Projects>, TColumns extends ColumnsOf<'projects'> | undefined = undefined>(
        filter: RowFilter<'projects', TFilter>,
        data: ProjectsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'projects.updateOne');
        return provider.from('projects').update(data).match(match).is('deleted_at', null).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'projects', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches — and always on this soft-delete table, whose trigger turns the DELETE into an UPDATE).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<Projects>, TColumns extends ColumnsOf<'projects'> | undefined = undefined>(
        filter: RowFilter<'projects', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'projects.deleteOne');
        return provider.from('projects').delete().match(match).is('deleted_at', null).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'projects', TColumns>>;
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

      update: (id: string, data: TasksUpdate) =>
        provider.from('tasks').update(data).eq('id', id).select().single() as unknown as QueryResult<Tasks>,

      delete: (id: string) =>
        provider.from('tasks').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Tasks>, TColumns extends ColumnsOf<'tasks'> | undefined = undefined>(
        filter: RowFilter<'tasks', TFilter>,
        data: TasksUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'tasks.updateOne');
        return provider.from('tasks').update(data).match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'tasks', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<Tasks>, TColumns extends ColumnsOf<'tasks'> | undefined = undefined>(
        filter: RowFilter<'tasks', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'tasks.deleteOne');
        return provider.from('tasks').delete().match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'tasks', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them.
      deleteMany: <TFilter extends Partial<Tasks>, TColumns extends ColumnsOf<'tasks'> | undefined = undefined>(
        filter: RowFilter<'tasks', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'tasks.deleteMany');
        return provider.from('tasks').delete().match(match).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'tasks', TColumns>[]>;
      },
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

      update: (id: string, data: CommentsUpdate) =>
        provider.from('comments').update(data).eq('id', id).select().single() as unknown as QueryResult<Comments>,

      delete: (id: string) =>
        provider.from('comments').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Comments>, TColumns extends ColumnsOf<'comments'> | undefined = undefined>(
        filter: RowFilter<'comments', TFilter>,
        data: CommentsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'comments.updateOne');
        return provider.from('comments').update(data).match(match).is('deleted_at', null).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'comments', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches — and always on this soft-delete table, whose trigger turns the DELETE into an UPDATE).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<Comments>, TColumns extends ColumnsOf<'comments'> | undefined = undefined>(
        filter: RowFilter<'comments', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'comments.deleteOne');
        return provider.from('comments').delete().match(match).is('deleted_at', null).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'comments', TColumns>>;
      },

      // Deletes every row matching `filter` (at least one column) and returns them (`[]` on this soft-delete table).
      deleteMany: <TFilter extends Partial<Comments>, TColumns extends ColumnsOf<'comments'> | undefined = undefined>(
        filter: RowFilter<'comments', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'comments.deleteMany');
        return provider.from('comments').delete().match(match).is('deleted_at', null).select(selectClause(options?.columns)) as unknown as QueryResult<SelectedRow<'comments', TColumns>[]>;
      },
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

      update: (id: string, data: AuditLogUpdate) =>
        provider.from('audit_log').update(data).eq('id', id).select().single() as unknown as QueryResult<AuditLog>,

      delete: (id: string) =>
        provider.from('audit_log').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<AuditLog>, TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter: RowFilter<'audit_log', TFilter>,
        data: AuditLogUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'audit_log.updateOne');
        return provider.from('audit_log').update(data).match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'audit_log', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<AuditLog>, TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(
        filter: RowFilter<'audit_log', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'audit_log.deleteOne');
        return provider.from('audit_log').delete().match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'audit_log', TColumns>>;
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

      update: (id: string, data: InvitationsUpdate) =>
        provider.from('invitations').update(data).eq('id', id).select().single() as unknown as QueryResult<Invitations>,

      delete: (id: string) =>
        provider.from('invitations').delete().eq('id', id) as unknown as QueryResult<null>,

      // Updates the row matching `filter` (a unique column) and returns it in one
      // round trip; `data: null` when no visible row matches. More than one match
      // is an error (PGRST116) and nothing is updated.
      updateOne: <TFilter extends Partial<Invitations>, TColumns extends ColumnsOf<'invitations'> | undefined = undefined>(
        filter: RowFilter<'invitations', TFilter>,
        data: InvitationsUpdate,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'invitations.updateOne');
        return provider.from('invitations').update(data).match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'invitations', TColumns>>;
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

      // Deletes the row matching `filter` and returns it (`data: null` when none
      // matches).
      // More than one match is an error (PGRST116) and nothing is deleted.
      deleteOne: <TFilter extends Partial<Invitations>, TColumns extends ColumnsOf<'invitations'> | undefined = undefined>(
        filter: RowFilter<'invitations', TFilter>,
        options?: { columns?: TColumns },
      ) => {
        const match = requireFilter(filter, 'invitations.deleteOne');
        return provider.from('invitations').delete().match(match).select(selectClause(options?.columns)).maybeSingle() as unknown as QueryResult<SelectedRow<'invitations', TColumns>>;
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

  };
}

/**
 * Type of a client from `createAccessNexusClient`. Pass your Supabase client type
 * to keep `auth` typed: `AccessNexusClient<SupabaseClient<Database>>`.
 */
export type AccessNexusClient<TClient extends AccessNexusProvider = AccessNexusProvider> =
  ReturnType<typeof createAccessNexusClient<TClient>>;