import { describe, it, expect } from 'vitest';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';

// Mock Supabase Database type (same structure as `supabase gen types typescript`)
type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          name: string;
          email: string;
          role: string;
          shop_id: string | null;
        };
        Insert: {
          id: string;
          name: string;
          email: string;
          role?: string;
          shop_id?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          email?: string;
          role?: string;
          shop_id?: string | null;
        };
        Relationships: [];
      };
      shops: {
        Row: {
          id: string;
          name: string;
          owner_id: string;
          active: boolean;
        };
        Insert: {
          id?: string;
          name: string;
          owner_id: string;
          active?: boolean;
        };
        Update: {
          id?: string;
          name?: string;
          owner_id?: string;
          active?: boolean;
        };
        Relationships: [];
      };
      appointments: {
        Row: {
          id: string;
          user_id: string;
          barber_id: string;
          shop_id: string;
          date: string;
          status: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          barber_id: string;
          shop_id: string;
          date: string;
          status?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          barber_id?: string;
          shop_id?: string;
          date?: string;
          status?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

describe('defineSchema<Database> (Supabase mode)', () => {
  it('should create a valid schema without columns', () => {
    const schema = defineSchema<Database>({
      profiles: {
        primaryKey: 'id',
        policies: {
          select: policy.isAuthenticated(),
        },
      },
      shops: {
        policies: {
          select: policy.public(),
        },
      },
    });

    expect(Object.keys(schema)).toEqual(['profiles', 'shops']);
    expect(schema.profiles.policies?.select?.kind).toBe('authenticated');
    expect(schema.shops.policies?.select?.kind).toBe('public');
  });

  it('should auto-set enableRLS when policies are defined', () => {
    const schema = defineSchema<Database>({
      profiles: {
        policies: {
          select: policy.isAuthenticated(),
        },
      },
    });

    expect(schema.profiles.enableRLS).toBe(true);
  });

  it('should preserve primaryKey', () => {
    const schema = defineSchema<Database>({
      profiles: {
        primaryKey: 'id',
        policies: {
          select: policy.isAuthenticated(),
        },
      },
    });

    expect(schema.profiles.primaryKey).toBe('id');
  });

  it('should auto-add soft delete trigger from softDelete option', () => {
    const schema = defineSchema<Database>({
      profiles: {
        softDelete: 'id',
        policies: {
          select: policy.isAuthenticated(),
        },
      },
    });

    expect(schema.profiles.triggers).toHaveLength(1);
    expect(schema.profiles.triggers?.[0]).toEqual({
      kind: 'soft_delete',
      column: 'id',
    });
  });

  it('should add empty columns object internally', () => {
    const schema = defineSchema<Database>({
      profiles: {
        policies: {
          select: policy.isAuthenticated(),
        },
      },
    });

    expect(schema.profiles.columns).toEqual({});
  });

  it('should validate reference format', () => {
    expect(() => {
      defineSchema<Database>({
        profiles: {
          references: {
            id: 'invalid',
          },
          policies: {
            select: policy.isAuthenticated(),
          },
        },
      });
    }).toThrow('invalid reference "invalid"');
  });

  it('should validate referenced table exists', () => {
    expect(() => {
      defineSchema<Database>({
        profiles: {
          references: {
            shop_id: 'nonexistent.id',
          },
          policies: {
            select: policy.isAuthenticated(),
          },
        },
      });
    }).toThrow('references table "nonexistent" which is not defined');
  });

  it('should allow external schema references', () => {
    const schema = defineSchema<Database>({
      profiles: {
        references: {
          id: 'auth.users.id',
        },
        policies: {
          select: policy.isAuthenticated(),
        },
      },
    });

    expect(schema.profiles.references?.id).toBe('auth.users.id');
  });

  it('should allow cross-table references within schema', () => {
    const schema = defineSchema<Database>({
      profiles: {
        policies: {
          select: policy.isAuthenticated(),
        },
      },
      appointments: {
        references: {
          user_id: 'profiles.id',
        },
        policies: {
          select: policy.isOwner('user_id'),
        },
      },
    });

    expect(schema.appointments.references?.user_id).toBe('profiles.id');
  });

  it('should support full schema with all policy types', () => {
    const schema = defineSchema<Database>({
      profiles: {
        primaryKey: 'id',
        policies: {
          select: policy.any([
            policy.isOwner('id'),
            policy.hasRole('admin'),
          ]),
          insert: policy.isAuthenticated(),
          update: policy.isOwner('id'),
          delete: policy.none(),
        },
      },
      shops: {
        policies: {
          select: policy.public(),
          update: policy.isOwner('owner_id'),
        },
      },
      appointments: {
        policies: {
          select: policy.any([
            policy.isOwner('user_id'),
            policy.isOwner('barber_id'),
          ]),
          insert: policy.isAuthenticated(),
        },
      },
    });

    expect(schema.profiles.policies?.select?.kind).toBe('any');
    expect(schema.profiles.policies?.delete?.kind).toBe('none');
    expect(schema.shops.policies?.select?.kind).toBe('public');
    expect(schema.appointments.policies?.insert?.kind).toBe('authenticated');
  });
});

describe('SupabaseAdapter (Database mode)', () => {
  it('should generate RLS policies from Database mode schema', () => {
    const adapter = new SupabaseAdapter({
      policyPrefix: 'accessnexus',
      timestamps: false,
    });

    const schema = defineSchema<Database>({
      profiles: {
        primaryKey: 'id',
        policies: {
          select: policy.any([
            policy.isOwner('id'),
            policy.hasRole('admin'),
          ]),
          insert: policy.isAuthenticated(),
        },
      },
    });

    const outputs = adapter.generatePolicies(schema);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].path).toBe('profiles_rls.sql');
    expect(outputs[0].content).toContain('ALTER TABLE profiles ENABLE ROW LEVEL SECURITY');
    expect(outputs[0].content).toContain('accessnexus_profiles_select');
    expect(outputs[0].content).toContain('(SELECT auth.uid()) = id');
    expect(outputs[0].content).toContain('accessnexus_profiles_insert');
  });

  it('should generate Database mode client (single file, uses Database type)', () => {
    const adapter = new SupabaseAdapter({
      timestamps: false,
      databaseTypes: '../../src/database.types',
    });

    const schema = defineSchema<Database>({
      profiles: {
        primaryKey: 'id',
        policies: {
          select: policy.isAuthenticated(),
        },
      },
      shops: {
        policies: {
          select: policy.public(),
        },
      },
    });

    const outputs = adapter.generateClient(schema);

    // Database mode: only client.ts, no types.ts
    expect(outputs).toHaveLength(1);
    expect(outputs[0].path).toBe('client.ts');

    const client = outputs[0].content;

    // Should import from database.types.ts
    expect(client).toContain("import type { Database } from '../../src/database.types'");
    expect(client).toContain("type Tables = Database['public']['Tables']");

    // Should use RowOf helper + Tables[...]['Insert']/['Update']
    expect(client).toContain("RowOf<'profiles'>");
    expect(client).toContain("Tables['profiles']['Insert']");
    expect(client).toContain("Tables['profiles']['Update']");
    expect(client).toContain("RowOf<'shops'>");

    // Should use generic transport type
    expect(client).toContain('type TableName = keyof Tables & string;');
    expect(client).toContain('interface QueryBuilder extends PromiseLike<unknown> {');
    expect(client).toContain('type AccessNexusTransport = {');
    expect(client).toContain('auth: unknown;');
    expect(client).toContain("auth: providerRaw.auth as TClient['auth'],");
    expect(client).toContain("as unknown as QueryResult<RowOf<'profiles'>>,");
    expect(client).toContain('findOne');
    expect(client).toContain('createAccessNexusClient<TClient extends AccessNexusProvider>(providerRaw: TClient)');

    // Should have CRUD methods
    expect(client).toContain('createAccessNexusClient');
    expect(client).toContain('auth: providerRaw.auth');
    expect(client).toContain('findMany');
    expect(client).toContain('findById');
    expect(client).toContain('create');
    expect(client).toContain('update');
    expect(client).toContain('delete');

    // Should export AccessNexusClient type
    expect(client).toContain('export type AccessNexusClient');
  });

  it('should use default databaseTypes path when not configured', () => {
    const adapter = new SupabaseAdapter({ timestamps: false });

    const schema = defineSchema<Database>({
      profiles: {
        policies: { select: policy.isAuthenticated() },
      },
    });

    const outputs = adapter.generateClient(schema);
    const client = outputs[0].content;
    expect(client).toContain("import type { Database } from './database.types'");
  });

  it('should generate relation include types in Database mode when references are provided', () => {
    const adapter = new SupabaseAdapter({
      timestamps: false,
      databaseTypes: '../../src/database.types',
    });

    const schema = defineSchema<Database>({
      profiles: {
        primaryKey: 'id',
      },
      shops: {
        primaryKey: 'id',
      },
      appointments: {
        primaryKey: 'id',
        references: {
          user_id: 'profiles.id',
          shop_id: 'shops.id',
        },
      },
    });

    const outputs = adapter.generateClient(schema);
    const client = outputs[0].content;

    expect(client).toContain("type AppointmentsRelations = {");
    expect(client).toContain("'user': RowOf<'profiles'>;");
    expect(client).toContain("'shop': RowOf<'shops'>;");
    expect(client).toContain("type AppointmentsInclude = Partial<Record<keyof AppointmentsRelations, true>>;");
    expect(client).toContain("const appointmentsJoins: Record<keyof AppointmentsRelations & string, string> = {");
    expect(client).toContain("'user': 'user:profiles!appointments_user_id_fkey(*)'");
    expect(client).toContain("'shop': 'shop:shops!appointments_shop_id_fkey(*)'");
    expect(client).toContain("findMany: <TColumns extends ColumnsOf<'appointments'> | undefined = undefined, TInclude extends AppointmentsInclude | undefined = undefined>(");
    expect(client).toContain("as unknown as QueryResult<AppointmentsWithInclude<TInclude, SelectedRow<'appointments', TColumns>>[]>");
  });

  it('should still generate manual mode client when columns are present', () => {
    const adapter = new SupabaseAdapter({ timestamps: false });

    // Manual mode (with columns) — existing behavior should be unchanged
    const schema = defineSchema({
      users: table({
        columns: { id: 'uuid', name: 'text' },
        primaryKey: 'id',
        policies: { select: policy.isAuthenticated() },
      }),
    });

    const outputs = adapter.generateClient(schema);
    expect(outputs).toHaveLength(2);
    expect(outputs[0].path).toBe('types.ts');
    expect(outputs[1].path).toBe('client.ts');
    expect(outputs[0].content).toContain('export type Users = {');
  });

  it('should generate soft-delete-aware Database mode client when softDelete is configured', () => {
    const adapter = new SupabaseAdapter({
      timestamps: false,
      databaseTypes: '../../src/database.types',
    });

    const schema = defineSchema<Database>({
      profiles: {
        primaryKey: 'id',
        softDelete: 'shop_id',
        policies: {
          select: policy.isAuthenticated(),
        },
      },
    });

    const outputs = adapter.generateClient(schema);
    const client = outputs[0].content;

    expect(client).toContain(".is('shop_id', null).match(filter ?? {})");
    expect(client).toContain(".eq('id', id).is('shop_id', null).maybeSingle()");
    // delete() issues a DELETE; the soft-delete trigger turns it into SET shop_id = NOW()
    expect(client).toContain("from('profiles').delete().eq('id', id)");
    expect(client).not.toContain("['shop_id']: new Date().toISOString()");
  });
});
