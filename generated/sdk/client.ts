// ============================================
// AccessNexus: Auto-generated client
// DO NOT EDIT — regenerate with `npx accessnexus generate`
// ============================================

import type { Database, Profiles, ProfilesCreate, ProfilesUpdate, Organizations, OrganizationsCreate, OrganizationsUpdate, OrgMembers, OrgMembersCreate, OrgMembersUpdate, Projects, ProjectsCreate, ProjectsUpdate, Tasks, TasksCreate, TasksUpdate, Comments, CommentsCreate, CommentsUpdate, AuditLog, AuditLogCreate, AuditLogUpdate, Invitations, InvitationsCreate, InvitationsUpdate } from './types.js';
type Tables = Database['public']['Tables'];
type Functions = Database['public']['Functions'];
type TableName = keyof Tables & string;
type FunctionName = keyof Functions & string;
type RowOf<T extends TableName> = Tables[T]['Row'];
type InsertOf<T extends TableName> = Tables[T]['Insert'];
type UpdateOf<T extends TableName> = Tables[T]['Update'];
type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;

interface SelectQuery<T extends TableName> {
  match(filter: Partial<RowOf<T>>): QueryResult<RowOf<T>[]>;
  eq(column: string, value: unknown): SelectQuery<T>;
  is(column: string, value: null): SelectQuery<T>;
  single(): QueryResult<RowOf<T>>;
}

interface MutationQuery<T extends TableName> {
  eq(column: string, value: unknown): MutationQuery<T>;
  select(): SelectQuery<T>;
}

interface DeleteQuery<T extends TableName> {
  eq(column: string, value: unknown): QueryResult<RowOf<T>[]>;
}

interface TableQuery<T extends TableName> {
  select(columns: string): SelectQuery<T>;
  insert(data: InsertOf<T>): MutationQuery<T>;
  update(data: UpdateOf<T>): MutationQuery<T>;
  delete(): DeleteQuery<T>;
}

type AccessNexusTransport = {
  auth: unknown;
  from<T extends TableName>(table: T): TableQuery<T>;
  rpc<F extends FunctionName>(name: F, args: Functions[F]['Args']): QueryResult<Functions[F]['Returns']>;
};

// Loose shape a real Supabase client satisfies (its builders are thenables,
// not Promises, so it cannot match AccessNexusTransport structurally).
type AccessNexusProvider = {
  auth: unknown;
  from: (table: any) => any;
  rpc: (name: any, args?: any) => any;
};

function buildSelectClause(
  base: string,
  joins: Record<string, string>,
  include?: Record<string, true | undefined>,
): string {
  if (!include) return base;
  const selected = Object.keys(include)
    .filter((key) => include[key] === true && joins[key])
    .map((key) => joins[key]);
  if (selected.length === 0) return base;
  return `${base}, ${selected.join(', ')}`;
}

type OrganizationsRelations = {
  'owner': RowOf<'profiles'>;
};
type OrganizationsInclude = Partial<Record<keyof OrganizationsRelations, true>>;
type OrganizationsWithInclude<TInclude extends OrganizationsInclude | undefined> =
  RowOf<'organizations'>
  & (TInclude extends { 'owner': true } ? { 'owner': OrganizationsRelations['owner'] | null } : {})
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
type OrgMembersWithInclude<TInclude extends OrgMembersInclude | undefined> =
  RowOf<'org_members'>
  & (TInclude extends { 'org': true } ? { 'org': OrgMembersRelations['org'] | null } : {})
  & (TInclude extends { 'user': true } ? { 'user': OrgMembersRelations['user'] | null } : {})
  & (TInclude extends { 'invited_by': true } ? { 'invited_by': OrgMembersRelations['invited_by'] | null } : {})
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
type ProjectsWithInclude<TInclude extends ProjectsInclude | undefined> =
  RowOf<'projects'>
  & (TInclude extends { 'org': true } ? { 'org': ProjectsRelations['org'] | null } : {})
  & (TInclude extends { 'created_by': true } ? { 'created_by': ProjectsRelations['created_by'] | null } : {})
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
type TasksWithInclude<TInclude extends TasksInclude | undefined> =
  RowOf<'tasks'>
  & (TInclude extends { 'org': true } ? { 'org': TasksRelations['org'] | null } : {})
  & (TInclude extends { 'project': true } ? { 'project': TasksRelations['project'] | null } : {})
  & (TInclude extends { 'assignee': true } ? { 'assignee': TasksRelations['assignee'] | null } : {})
  & (TInclude extends { 'reporter': true } ? { 'reporter': TasksRelations['reporter'] | null } : {})
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
type CommentsWithInclude<TInclude extends CommentsInclude | undefined> =
  RowOf<'comments'>
  & (TInclude extends { 'org': true } ? { 'org': CommentsRelations['org'] | null } : {})
  & (TInclude extends { 'task': true } ? { 'task': CommentsRelations['task'] | null } : {})
  & (TInclude extends { 'author': true } ? { 'author': CommentsRelations['author'] | null } : {})
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
type InvitationsWithInclude<TInclude extends InvitationsInclude | undefined> =
  RowOf<'invitations'>
  & (TInclude extends { 'org': true } ? { 'org': InvitationsRelations['org'] | null } : {})
  & (TInclude extends { 'invited_by': true } ? { 'invited_by': InvitationsRelations['invited_by'] | null } : {})
;
const invitationsJoins: Record<keyof InvitationsRelations & string, string> = {
  'org': 'org:organizations!invitations_org_id_fkey(*)',
  'invited_by': 'invited_by:profiles!invitations_invited_by_fkey(*)',
};

export function createAccessNexusClient<TClient extends AccessNexusProvider>(providerRaw: TClient) {
  // Accept a real Supabase client (loose AccessNexusProvider) and use the strict
  // AccessNexusTransport shape internally for the typed accessors below.
  const provider = providerRaw as unknown as AccessNexusTransport;
  return {
    auth: providerRaw.auth,

    profiles: {
      findMany: (filter?: Partial<Profiles>) =>
        provider.from('profiles').select('*').match(filter ?? {}),

      findById: (id: string) =>
        provider.from('profiles').select('*').eq('id', id).single(),

      create: (data: ProfilesCreate) =>
        provider.from('profiles').insert(data).select().single(),

      update: (id: string, data: ProfilesUpdate) =>
        provider.from('profiles').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('profiles').delete().eq('id', id),
    },

    organizations: {
      findMany: <TInclude extends OrganizationsInclude | undefined = undefined>(
        filter?: Partial<Organizations>,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', organizationsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('organizations').select(select).match(filter ?? {}) as QueryResult<OrganizationsWithInclude<TInclude>[]>;
      },

      findById: <TInclude extends OrganizationsInclude | undefined = undefined>(
        id: string,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', organizationsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('organizations').select(select).eq('id', id).single() as QueryResult<OrganizationsWithInclude<TInclude>>;
      },

      create: (data: OrganizationsCreate) =>
        provider.from('organizations').insert(data).select().single(),

      update: (id: string, data: OrganizationsUpdate) =>
        provider.from('organizations').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('organizations').delete().eq('id', id),
    },

    org_members: {
      findMany: <TInclude extends OrgMembersInclude | undefined = undefined>(
        filter?: Partial<OrgMembers>,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', org_membersJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('org_members').select(select).match(filter ?? {}) as QueryResult<OrgMembersWithInclude<TInclude>[]>;
      },

      findById: <TInclude extends OrgMembersInclude | undefined = undefined>(
        id: string,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', org_membersJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('org_members').select(select).eq('id', id).single() as QueryResult<OrgMembersWithInclude<TInclude>>;
      },

      create: (data: OrgMembersCreate) =>
        provider.from('org_members').insert(data).select().single(),

      update: (id: string, data: OrgMembersUpdate) =>
        provider.from('org_members').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('org_members').delete().eq('id', id),
    },

    projects: {
      findMany: <TInclude extends ProjectsInclude | undefined = undefined>(
        filter?: Partial<Projects>,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', projectsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('projects').select(select).is('deleted_at', null).match(filter ?? {}) as QueryResult<ProjectsWithInclude<TInclude>[]>;
      },

      findById: <TInclude extends ProjectsInclude | undefined = undefined>(
        id: string,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', projectsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('projects').select(select).eq('id', id).is('deleted_at', null).single() as QueryResult<ProjectsWithInclude<TInclude>>;
      },

      create: (data: ProjectsCreate) =>
        provider.from('projects').insert(data).select().single(),

      update: (id: string, data: ProjectsUpdate) =>
        provider.from('projects').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('projects').delete().eq('id', id),
    },

    tasks: {
      findMany: <TInclude extends TasksInclude | undefined = undefined>(
        filter?: Partial<Tasks>,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', tasksJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('tasks').select(select).match(filter ?? {}) as QueryResult<TasksWithInclude<TInclude>[]>;
      },

      findById: <TInclude extends TasksInclude | undefined = undefined>(
        id: string,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', tasksJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('tasks').select(select).eq('id', id).single() as QueryResult<TasksWithInclude<TInclude>>;
      },

      create: (data: TasksCreate) =>
        provider.from('tasks').insert(data).select().single(),

      update: (id: string, data: TasksUpdate) =>
        provider.from('tasks').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('tasks').delete().eq('id', id),
    },

    comments: {
      findMany: <TInclude extends CommentsInclude | undefined = undefined>(
        filter?: Partial<Comments>,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', commentsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('comments').select(select).is('deleted_at', null).match(filter ?? {}) as QueryResult<CommentsWithInclude<TInclude>[]>;
      },

      findById: <TInclude extends CommentsInclude | undefined = undefined>(
        id: string,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', commentsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('comments').select(select).eq('id', id).is('deleted_at', null).single() as QueryResult<CommentsWithInclude<TInclude>>;
      },

      create: (data: CommentsCreate) =>
        provider.from('comments').insert(data).select().single(),

      update: (id: string, data: CommentsUpdate) =>
        provider.from('comments').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('comments').delete().eq('id', id),
    },

    audit_log: {
      findMany: (filter?: Partial<AuditLog>) =>
        provider.from('audit_log').select('*').match(filter ?? {}),

      findById: (id: string) =>
        provider.from('audit_log').select('*').eq('id', id).single(),

      create: (data: AuditLogCreate) =>
        provider.from('audit_log').insert(data).select().single(),

      update: (id: string, data: AuditLogUpdate) =>
        provider.from('audit_log').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('audit_log').delete().eq('id', id),
    },

    invitations: {
      findMany: <TInclude extends InvitationsInclude | undefined = undefined>(
        filter?: Partial<Invitations>,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', invitationsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('invitations').select(select).match(filter ?? {}) as QueryResult<InvitationsWithInclude<TInclude>[]>;
      },

      findById: <TInclude extends InvitationsInclude | undefined = undefined>(
        id: string,
        options?: { include?: TInclude },
      ) => {
        const select = buildSelectClause('*', invitationsJoins, options?.include as Record<string, true | undefined> | undefined);
        return provider.from('invitations').select(select).eq('id', id).single() as QueryResult<InvitationsWithInclude<TInclude>>;
      },

      create: (data: InvitationsCreate) =>
        provider.from('invitations').insert(data).select().single(),

      update: (id: string, data: InvitationsUpdate) =>
        provider.from('invitations').update(data).eq('id', id).select().single(),

      delete: (id: string) =>
        provider.from('invitations').delete().eq('id', id),
    },

    rpc: {
      get_org_dashboard: (args: Functions['get_org_dashboard']['Args']) =>
        provider.rpc('get_org_dashboard', args),

      accept_invitation: (args: Functions['accept_invitation']['Args']) =>
        provider.rpc('accept_invitation', args),

      search_tasks: (args: Functions['search_tasks']['Args']) =>
        provider.rpc('search_tasks', args),

    },

  };
}

export type AccessNexusClient = ReturnType<typeof createAccessNexusClient>;