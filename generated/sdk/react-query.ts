// ============================================
// AccessNexus: Auto-generated TanStack Query helpers
// Requires @tanstack/react-query v5
// DO NOT EDIT — regenerate with `npx accessnexus generate`
// ============================================

import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { AccessNexusClient, AccessNexusProvider, ColumnsOf, OrganizationsInclude, OrgMembersInclude, ProjectsInclude, TasksInclude, CommentsInclude, InvitationsInclude } from './client.js';

type Client = AccessNexusClient;
type TableKey = Exclude<keyof Client, 'auth' | 'rpc' | 'channels'>;
type FilterOf<K extends TableKey> = NonNullable<Parameters<Client[K]['findMany']>[0]>;
type CreateOf<K extends TableKey> = Parameters<Client[K]['create']>[0];
type UpdateOf<K extends TableKey> = Parameters<Client[K]['update']>[1];
type Result<T> = PromiseLike<{ data: T | null; error: unknown }>;

// Supabase reports failures in `error`; TanStack Query needs a rejection.
// The thrown value is the Supabase error itself (PostgrestError: code, message, details).
async function unwrap<T>(result: Result<T>): Promise<T | null> {
  const { data, error } = await result;
  if (error) throw error;
  return data;
}
async function unwrapList<T>(result: Result<T[]>): Promise<T[]> {
  return (await unwrap(result)) ?? [];
}
async function unwrapRow<T>(result: Result<T>): Promise<T> {
  // create/update use .single(): no row is reported as an error, never as null.
  return (await unwrap(result)) as T;
}

/**
 * Query keys of the helpers below. Every key starts with `['accessnexus', <table>]`,
 * so `invalidateQueries({ queryKey: accessNexusKeys.<table>.all })` refreshes a table.
 */
export const accessNexusKeys = {
  all: ['accessnexus'] as const,
  profiles: {
    all: ['accessnexus', 'profiles'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'profiles', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'profiles', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'profiles', 'byId', id, options ?? {}] as const,
  },
  organizations: {
    all: ['accessnexus', 'organizations'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'organizations', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'organizations', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'organizations', 'byId', id, options ?? {}] as const,
  },
  org_members: {
    all: ['accessnexus', 'org_members'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'org_members', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'org_members', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'org_members', 'byId', id, options ?? {}] as const,
  },
  projects: {
    all: ['accessnexus', 'projects'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'projects', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'projects', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'projects', 'byId', id, options ?? {}] as const,
  },
  tasks: {
    all: ['accessnexus', 'tasks'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'tasks', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'tasks', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'tasks', 'byId', id, options ?? {}] as const,
  },
  comments: {
    all: ['accessnexus', 'comments'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'comments', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'comments', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'comments', 'byId', id, options ?? {}] as const,
  },
  audit_log: {
    all: ['accessnexus', 'audit_log'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'audit_log', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'audit_log', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'audit_log', 'byId', id, options ?? {}] as const,
  },
  invitations: {
    all: ['accessnexus', 'invitations'] as const,
    list: (filter?: unknown, options?: unknown) => ['accessnexus', 'invitations', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,
    one: (filter: unknown, options?: unknown) => ['accessnexus', 'invitations', 'one', { filter, options: options ?? {} }] as const,
    byId: (id: string, options?: unknown) => ['accessnexus', 'invitations', 'byId', id, options ?? {}] as const,
  },
  rpc: {
    all: ['accessnexus', 'rpc'] as const,
    get_org_dashboard: (args?: unknown) => ['accessnexus', 'rpc', 'get_org_dashboard', args ?? {}] as const,
    accept_invitation: (args?: unknown) => ['accessnexus', 'rpc', 'accept_invitation', args ?? {}] as const,
    search_tasks: (args?: unknown) => ['accessnexus', 'rpc', 'search_tasks', args ?? {}] as const,
  },
};

export interface AccessNexusQueriesOptions {
  /**
   * When set, each mutation invalidates on success the queries it can change:
   * its table, the tables that embed it via `include`, and every query for an RPC
   * mutation. Without it, mutations invalidate nothing.
   */
  queryClient?: QueryClient;
}

/**
 * TanStack Query v5 helpers over a client from `createAccessNexusClient`:
 * reads return `queryOptions` (`useQuery(q.tasks.findMany({ project_id }))`),
 * writes return mutation options (`useMutation(q.tasks.create())`). Spread to add
 * your own options: `useQuery({ ...q.tasks.findById(id), enabled: !!id })`.
 */
export function createAccessNexusQueries<TClient extends AccessNexusProvider>(
  client: AccessNexusClient<TClient>,
  { queryClient }: AccessNexusQueriesOptions = {},
) {
  const invalidate = (...keys: ReadonlyArray<readonly unknown[]>) => async () => {
    if (!queryClient) return;
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
  return {
    profiles: {
      findMany: <TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(filter?: FilterOf<'profiles'>, options?: { columns?: TColumns }) =>
        queryOptions({
          queryKey: accessNexusKeys.profiles.list(filter, options),
          queryFn: () => unwrapList(client.profiles.findMany<TColumns>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(filter: FilterOf<'profiles'>, options?: { columns?: TColumns }) =>
        queryOptions({
          queryKey: accessNexusKeys.profiles.one(filter, options),
          queryFn: () => unwrap(client.profiles.findOne<TColumns>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'profiles'> | undefined = undefined>(id: string, options?: { columns?: TColumns }) =>
        queryOptions({
          queryKey: accessNexusKeys.profiles.byId(id, options),
          queryFn: () => unwrap(client.profiles.findById<TColumns>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.profiles.all, 'create'] as const,
        mutationFn: (data: CreateOf<'profiles'>) => unwrapRow(client.profiles.create(data)),
        onSuccess: invalidate(accessNexusKeys.profiles.all, accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.profiles.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'profiles'> }) => unwrapRow(client.profiles.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.profiles.all, accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.profiles.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.profiles.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.profiles.all, accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.profiles.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'profiles'>; data: UpdateOf<'profiles'> }) => unwrap(client.profiles.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.profiles.all, accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.profiles.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'profiles'>; data: UpdateOf<'profiles'> }) => unwrapList(client.profiles.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.profiles.all, accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.profiles.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'profiles'>) => unwrap(client.profiles.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.profiles.all, accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.profiles.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'profiles'>) => unwrapList(client.profiles.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.profiles.all, accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
    },

    organizations: {
      findMany: <TColumns extends ColumnsOf<'organizations'> | undefined = undefined, TInclude extends OrganizationsInclude | undefined = undefined>(filter?: FilterOf<'organizations'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.organizations.list(filter, options),
          queryFn: () => unwrapList(client.organizations.findMany<TColumns, TInclude>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'organizations'> | undefined = undefined, TInclude extends OrganizationsInclude | undefined = undefined>(filter: FilterOf<'organizations'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.organizations.one(filter, options),
          queryFn: () => unwrap(client.organizations.findOne<TColumns, TInclude>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'organizations'> | undefined = undefined, TInclude extends OrganizationsInclude | undefined = undefined>(id: string, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.organizations.byId(id, options),
          queryFn: () => unwrap(client.organizations.findById<TColumns, TInclude>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.organizations.all, 'create'] as const,
        mutationFn: (data: CreateOf<'organizations'>) => unwrapRow(client.organizations.create(data)),
        onSuccess: invalidate(accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.organizations.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'organizations'> }) => unwrapRow(client.organizations.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.organizations.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.organizations.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.organizations.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'organizations'>; data: UpdateOf<'organizations'> }) => unwrap(client.organizations.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.organizations.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'organizations'>; data: UpdateOf<'organizations'> }) => unwrapList(client.organizations.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.organizations.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'organizations'>) => unwrap(client.organizations.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.organizations.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'organizations'>) => unwrapList(client.organizations.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.organizations.all, accessNexusKeys.org_members.all, accessNexusKeys.projects.all, accessNexusKeys.tasks.all, accessNexusKeys.comments.all, accessNexusKeys.invitations.all),
      }),
    },

    org_members: {
      findMany: <TColumns extends ColumnsOf<'org_members'> | undefined = undefined, TInclude extends OrgMembersInclude | undefined = undefined>(filter?: FilterOf<'org_members'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.org_members.list(filter, options),
          queryFn: () => unwrapList(client.org_members.findMany<TColumns, TInclude>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'org_members'> | undefined = undefined, TInclude extends OrgMembersInclude | undefined = undefined>(filter: FilterOf<'org_members'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.org_members.one(filter, options),
          queryFn: () => unwrap(client.org_members.findOne<TColumns, TInclude>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'org_members'> | undefined = undefined, TInclude extends OrgMembersInclude | undefined = undefined>(id: string, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.org_members.byId(id, options),
          queryFn: () => unwrap(client.org_members.findById<TColumns, TInclude>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.org_members.all, 'create'] as const,
        mutationFn: (data: CreateOf<'org_members'>) => unwrapRow(client.org_members.create(data)),
        onSuccess: invalidate(accessNexusKeys.org_members.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.org_members.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'org_members'> }) => unwrapRow(client.org_members.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.org_members.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.org_members.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.org_members.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.org_members.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.org_members.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'org_members'>; data: UpdateOf<'org_members'> }) => unwrap(client.org_members.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.org_members.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.org_members.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'org_members'>; data: UpdateOf<'org_members'> }) => unwrapList(client.org_members.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.org_members.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.org_members.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'org_members'>) => unwrap(client.org_members.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.org_members.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.org_members.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'org_members'>) => unwrapList(client.org_members.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.org_members.all),
      }),
    },

    projects: {
      findMany: <TColumns extends ColumnsOf<'projects'> | undefined = undefined, TInclude extends ProjectsInclude | undefined = undefined>(filter?: FilterOf<'projects'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.projects.list(filter, options),
          queryFn: () => unwrapList(client.projects.findMany<TColumns, TInclude>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'projects'> | undefined = undefined, TInclude extends ProjectsInclude | undefined = undefined>(filter: FilterOf<'projects'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.projects.one(filter, options),
          queryFn: () => unwrap(client.projects.findOne<TColumns, TInclude>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'projects'> | undefined = undefined, TInclude extends ProjectsInclude | undefined = undefined>(id: string, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.projects.byId(id, options),
          queryFn: () => unwrap(client.projects.findById<TColumns, TInclude>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.projects.all, 'create'] as const,
        mutationFn: (data: CreateOf<'projects'>) => unwrapRow(client.projects.create(data)),
        onSuccess: invalidate(accessNexusKeys.projects.all, accessNexusKeys.tasks.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.projects.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'projects'> }) => unwrapRow(client.projects.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.projects.all, accessNexusKeys.tasks.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.projects.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.projects.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.projects.all, accessNexusKeys.tasks.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.projects.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'projects'>; data: UpdateOf<'projects'> }) => unwrap(client.projects.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.projects.all, accessNexusKeys.tasks.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.projects.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'projects'>; data: UpdateOf<'projects'> }) => unwrapList(client.projects.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.projects.all, accessNexusKeys.tasks.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.projects.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'projects'>) => unwrap(client.projects.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.projects.all, accessNexusKeys.tasks.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.projects.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'projects'>) => unwrapList(client.projects.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.projects.all, accessNexusKeys.tasks.all),
      }),
    },

    tasks: {
      findMany: <TColumns extends ColumnsOf<'tasks'> | undefined = undefined, TInclude extends TasksInclude | undefined = undefined>(filter?: FilterOf<'tasks'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.tasks.list(filter, options),
          queryFn: () => unwrapList(client.tasks.findMany<TColumns, TInclude>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'tasks'> | undefined = undefined, TInclude extends TasksInclude | undefined = undefined>(filter: FilterOf<'tasks'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.tasks.one(filter, options),
          queryFn: () => unwrap(client.tasks.findOne<TColumns, TInclude>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'tasks'> | undefined = undefined, TInclude extends TasksInclude | undefined = undefined>(id: string, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.tasks.byId(id, options),
          queryFn: () => unwrap(client.tasks.findById<TColumns, TInclude>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.tasks.all, 'create'] as const,
        mutationFn: (data: CreateOf<'tasks'>) => unwrapRow(client.tasks.create(data)),
        onSuccess: invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.tasks.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'tasks'> }) => unwrapRow(client.tasks.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.tasks.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.tasks.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.tasks.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'tasks'>; data: UpdateOf<'tasks'> }) => unwrap(client.tasks.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.tasks.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'tasks'>; data: UpdateOf<'tasks'> }) => unwrapList(client.tasks.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.tasks.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'tasks'>) => unwrap(client.tasks.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.tasks.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'tasks'>) => unwrapList(client.tasks.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all),
      }),
      // Keeps queries fresh: on every Realtime change of tasks (that RLS lets this
      // user see), invalidates tasks and the tables that embed it. Call it in an
      // effect and return its result: useEffect(() => q.tasks.invalidateOnChange(), []).
      invalidateOnChange: (options?: Parameters<Client['tasks']['subscribe']>[1]) => {
        if (!queryClient) throw new Error('[AccessNexus] tasks.invalidateOnChange needs createAccessNexusQueries(client, { queryClient })');
        const refresh = invalidate(accessNexusKeys.tasks.all, accessNexusKeys.comments.all);
        return client.tasks.subscribe(() => { void refresh(); }, options);
      },
    },

    comments: {
      findMany: <TColumns extends ColumnsOf<'comments'> | undefined = undefined, TInclude extends CommentsInclude | undefined = undefined>(filter?: FilterOf<'comments'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.comments.list(filter, options),
          queryFn: () => unwrapList(client.comments.findMany<TColumns, TInclude>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'comments'> | undefined = undefined, TInclude extends CommentsInclude | undefined = undefined>(filter: FilterOf<'comments'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.comments.one(filter, options),
          queryFn: () => unwrap(client.comments.findOne<TColumns, TInclude>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'comments'> | undefined = undefined, TInclude extends CommentsInclude | undefined = undefined>(id: string, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.comments.byId(id, options),
          queryFn: () => unwrap(client.comments.findById<TColumns, TInclude>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.comments.all, 'create'] as const,
        mutationFn: (data: CreateOf<'comments'>) => unwrapRow(client.comments.create(data)),
        onSuccess: invalidate(accessNexusKeys.comments.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.comments.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'comments'> }) => unwrapRow(client.comments.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.comments.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.comments.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.comments.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.comments.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.comments.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'comments'>; data: UpdateOf<'comments'> }) => unwrap(client.comments.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.comments.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.comments.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'comments'>; data: UpdateOf<'comments'> }) => unwrapList(client.comments.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.comments.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.comments.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'comments'>) => unwrap(client.comments.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.comments.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.comments.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'comments'>) => unwrapList(client.comments.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.comments.all),
      }),
      // Keeps queries fresh: on every Realtime change of comments (that RLS lets this
      // user see), invalidates comments and the tables that embed it. Call it in an
      // effect and return its result: useEffect(() => q.comments.invalidateOnChange(), []).
      invalidateOnChange: (options?: Parameters<Client['comments']['subscribe']>[1]) => {
        if (!queryClient) throw new Error('[AccessNexus] comments.invalidateOnChange needs createAccessNexusQueries(client, { queryClient })');
        const refresh = invalidate(accessNexusKeys.comments.all);
        return client.comments.subscribe(() => { void refresh(); }, options);
      },
    },

    audit_log: {
      findMany: <TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(filter?: FilterOf<'audit_log'>, options?: { columns?: TColumns }) =>
        queryOptions({
          queryKey: accessNexusKeys.audit_log.list(filter, options),
          queryFn: () => unwrapList(client.audit_log.findMany<TColumns>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(filter: FilterOf<'audit_log'>, options?: { columns?: TColumns }) =>
        queryOptions({
          queryKey: accessNexusKeys.audit_log.one(filter, options),
          queryFn: () => unwrap(client.audit_log.findOne<TColumns>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'audit_log'> | undefined = undefined>(id: string, options?: { columns?: TColumns }) =>
        queryOptions({
          queryKey: accessNexusKeys.audit_log.byId(id, options),
          queryFn: () => unwrap(client.audit_log.findById<TColumns>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.audit_log.all, 'create'] as const,
        mutationFn: (data: CreateOf<'audit_log'>) => unwrapRow(client.audit_log.create(data)),
        onSuccess: invalidate(accessNexusKeys.audit_log.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.audit_log.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'audit_log'> }) => unwrapRow(client.audit_log.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.audit_log.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.audit_log.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.audit_log.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.audit_log.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.audit_log.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'audit_log'>; data: UpdateOf<'audit_log'> }) => unwrap(client.audit_log.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.audit_log.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.audit_log.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'audit_log'>; data: UpdateOf<'audit_log'> }) => unwrapList(client.audit_log.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.audit_log.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.audit_log.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'audit_log'>) => unwrap(client.audit_log.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.audit_log.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.audit_log.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'audit_log'>) => unwrapList(client.audit_log.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.audit_log.all),
      }),
    },

    invitations: {
      findMany: <TColumns extends ColumnsOf<'invitations'> | undefined = undefined, TInclude extends InvitationsInclude | undefined = undefined>(filter?: FilterOf<'invitations'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.invitations.list(filter, options),
          queryFn: () => unwrapList(client.invitations.findMany<TColumns, TInclude>(filter, options)),
        }),
      findOne: <TColumns extends ColumnsOf<'invitations'> | undefined = undefined, TInclude extends InvitationsInclude | undefined = undefined>(filter: FilterOf<'invitations'>, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.invitations.one(filter, options),
          queryFn: () => unwrap(client.invitations.findOne<TColumns, TInclude>(filter, options)),
        }),
      findById: <TColumns extends ColumnsOf<'invitations'> | undefined = undefined, TInclude extends InvitationsInclude | undefined = undefined>(id: string, options?: { columns?: TColumns; include?: TInclude }) =>
        queryOptions({
          queryKey: accessNexusKeys.invitations.byId(id, options),
          queryFn: () => unwrap(client.invitations.findById<TColumns, TInclude>(id, options)),
        }),
      create: () => ({
        mutationKey: [...accessNexusKeys.invitations.all, 'create'] as const,
        mutationFn: (data: CreateOf<'invitations'>) => unwrapRow(client.invitations.create(data)),
        onSuccess: invalidate(accessNexusKeys.invitations.all),
      }),
      update: () => ({
        mutationKey: [...accessNexusKeys.invitations.all, 'update'] as const,
        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'invitations'> }) => unwrapRow(client.invitations.update(id, data)),
        onSuccess: invalidate(accessNexusKeys.invitations.all),
      }),
      delete: () => ({
        mutationKey: [...accessNexusKeys.invitations.all, 'delete'] as const,
        mutationFn: async (id: string) => { await unwrap(client.invitations.delete(id)); },
        onSuccess: invalidate(accessNexusKeys.invitations.all),
      }),
      // Filtered writes: an empty filter throws before any request (see client.ts).
      updateOne: () => ({
        mutationKey: [...accessNexusKeys.invitations.all, 'updateOne'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'invitations'>; data: UpdateOf<'invitations'> }) => unwrap(client.invitations.updateOne(filter, data)),
        onSuccess: invalidate(accessNexusKeys.invitations.all),
      }),
      updateMany: () => ({
        mutationKey: [...accessNexusKeys.invitations.all, 'updateMany'] as const,
        mutationFn: ({ filter, data }: { filter: FilterOf<'invitations'>; data: UpdateOf<'invitations'> }) => unwrapList(client.invitations.updateMany(filter, data)),
        onSuccess: invalidate(accessNexusKeys.invitations.all),
      }),
      deleteOne: () => ({
        mutationKey: [...accessNexusKeys.invitations.all, 'deleteOne'] as const,
        mutationFn: (filter: FilterOf<'invitations'>) => unwrap(client.invitations.deleteOne(filter)),
        onSuccess: invalidate(accessNexusKeys.invitations.all),
      }),
      deleteMany: () => ({
        mutationKey: [...accessNexusKeys.invitations.all, 'deleteMany'] as const,
        mutationFn: (filter: FilterOf<'invitations'>) => unwrapList(client.invitations.deleteMany(filter)),
        onSuccess: invalidate(accessNexusKeys.invitations.all),
      }),
    },

    // Each RPC as a query (reads) and as a mutation (writes; invalidates every query).
    rpc: {
      get_org_dashboard: {
        query: (...args: Parameters<Client['rpc']['get_org_dashboard']>) =>
          queryOptions({
            queryKey: accessNexusKeys.rpc.get_org_dashboard(args[0]),
            queryFn: () => unwrap(client.rpc.get_org_dashboard(...args)),
          }),
        mutation: () => ({
          mutationKey: [...accessNexusKeys.rpc.all, 'get_org_dashboard'] as const,
          mutationFn: (args: Parameters<Client['rpc']['get_org_dashboard']>[0]) => unwrap(client.rpc.get_org_dashboard(args)),
          onSuccess: invalidate(accessNexusKeys.all),
        }),
      },
      accept_invitation: {
        query: (...args: Parameters<Client['rpc']['accept_invitation']>) =>
          queryOptions({
            queryKey: accessNexusKeys.rpc.accept_invitation(args[0]),
            queryFn: () => unwrap(client.rpc.accept_invitation(...args)),
          }),
        mutation: () => ({
          mutationKey: [...accessNexusKeys.rpc.all, 'accept_invitation'] as const,
          mutationFn: (args: Parameters<Client['rpc']['accept_invitation']>[0]) => unwrap(client.rpc.accept_invitation(args)),
          onSuccess: invalidate(accessNexusKeys.all),
        }),
      },
      search_tasks: {
        query: (...args: Parameters<Client['rpc']['search_tasks']>) =>
          queryOptions({
            queryKey: accessNexusKeys.rpc.search_tasks(args[0]),
            queryFn: () => unwrap(client.rpc.search_tasks(...args)),
          }),
        mutation: () => ({
          mutationKey: [...accessNexusKeys.rpc.all, 'search_tasks'] as const,
          mutationFn: (args: Parameters<Client['rpc']['search_tasks']>[0]) => unwrap(client.rpc.search_tasks(args)),
          onSuccess: invalidate(accessNexusKeys.all),
        }),
      },
    },

  };
}

/** Type of the helpers returned by `createAccessNexusQueries`. */
export type AccessNexusQueries = ReturnType<typeof createAccessNexusQueries>;
