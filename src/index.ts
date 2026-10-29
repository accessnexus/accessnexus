// ============================================
// AccessNexus
// The missing schema layer for Supabase
// ============================================

// Core API
export { definePermissions } from './core/permissions/index.js';
export { policy } from './core/policy/index.js';
export { rpc } from './core/rpc/index.js';
export { defineConfig, defineSchema, table } from './core/schema/index.js';
export type { DefineConfigOptions, AccessNexusTarget, ResolvedConfig } from './core/schema/builders.js';
export { defineSeed } from './core/seed/builders.js';
export { trigger } from './core/triggers/index.js';

// Core types
export type {
  Adapter, AuditLogTrigger, ColumnDef, ColumnInput, ColumnType, CustomTrigger, ForeignKeyAction, FunctionNamesOf, FunctionsOf, GeneratedOutput, GenericSchema,
  GenericTable, InsertOf, AccessNexusConfig, NullableType,
  // Permissions types
  AnyPermission, PermissionLevel, PermissionsDef, PermissionsInput, ResourcePermissions, TenantConfig, TenantScope,
  PolicyOperation, PolicyRule, PublicSchema, RowOf,
  // RPC types
  RpcDef,
  RpcLanguage, RpcReturnType, RpcSecurity, ScalarType, SchemaDef, SeedSqlOptions, SoftDeleteTrigger, LockColumnsTrigger,
  // Supabase Database type helpers
  SupabaseDatabase,
  SupabaseSchemaInput,
  SupabaseTableDef, TableDef, TableNamesOf, TablePolicies, TableTriggers, TablesOf, TriggerEvent,
  TriggerForEach,
  // Trigger types
  TriggerRule, UpdateOf, UpdatedAtTrigger, WithCheckMode
} from './core/types/index.js';

// Adapters
export { SupabaseAdapter } from './adapters/supabase/index.js';
export type { SupabaseAdapterOptions } from './adapters/supabase/index.js';

