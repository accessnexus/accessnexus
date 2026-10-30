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