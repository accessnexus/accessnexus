// ============================================
// AccessNexus: Auto-generated types
// DO NOT EDIT — regenerate with `npx accessnexus generate`
// ============================================

// Same definition as the `Json` type `supabase gen types` emits, so json/jsonb
// columns are interchangeable with Supabase-generated types.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Profiles = {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string | null;
};

export type ProfilesCreate = Pick<Profiles, 'email' | 'name'> & Partial<Pick<Profiles, 'id' | 'avatar_url' | 'bio' | 'created_at' | 'updated_at'>>;
export type ProfilesUpdate = Partial<Omit<Profiles, 'id'>>;

export type Organizations = {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  logo_url: string | null;
  plan: 'free' | 'pro' | 'enterprise';
  settings: Json | null;
  created_at: string;
  updated_at: string | null;
};

export type OrganizationsCreate = Pick<Organizations, 'name' | 'slug' | 'owner_id' | 'plan'> & Partial<Pick<Organizations, 'id' | 'logo_url' | 'settings' | 'created_at' | 'updated_at'>>;
export type OrganizationsUpdate = Partial<Omit<Organizations, 'id'>>;

export type OrgMembers = {
  id: string;
  org_id: string;
  user_id: string;
  role: 'admin' | 'manager' | 'member' | 'viewer';
  invited_by: string | null;
  joined_at: string;
};

export type OrgMembersCreate = Pick<OrgMembers, 'org_id' | 'user_id' | 'role'> & Partial<Pick<OrgMembers, 'id' | 'invited_by' | 'joined_at'>>;
export type OrgMembersUpdate = Partial<Omit<OrgMembers, 'id'>>;

export type Projects = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived' | 'completed';
  created_by: string;
  is_public: boolean;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
};

export type ProjectsCreate = Pick<Projects, 'org_id' | 'name' | 'status' | 'created_by' | 'is_public'> & Partial<Pick<Projects, 'id' | 'description' | 'created_at' | 'updated_at' | 'deleted_at'>>;
export type ProjectsUpdate = Partial<Omit<Projects, 'id'>>;

export type Tasks = {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee_id: string | null;
  reporter_id: string;
  due_date: string | null;
  estimated_hours: number | null;
  tags: string[] | null;
  position: number;
  created_at: string;
  updated_at: string | null;
};

export type TasksCreate = Pick<Tasks, 'org_id' | 'project_id' | 'title' | 'status' | 'priority' | 'reporter_id' | 'position'> & Partial<Pick<Tasks, 'id' | 'description' | 'assignee_id' | 'due_date' | 'estimated_hours' | 'tags' | 'created_at' | 'updated_at'>>;
export type TasksUpdate = Partial<Omit<Tasks, 'id'>>;

export type Comments = {
  id: string;
  org_id: string;
  task_id: string;
  author_id: string;
  body: string;
  edited: boolean;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
};

export type CommentsCreate = Pick<Comments, 'org_id' | 'task_id' | 'author_id' | 'body' | 'edited'> & Partial<Pick<Comments, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>>;
export type CommentsUpdate = Partial<Omit<Comments, 'id'>>;

export type AuditLog = {
  id: number;
  table_name: string;
  operation: string;
  old_data: Json | null;
  new_data: Json | null;
  changed_at: string;
};

export type AuditLogCreate = Pick<AuditLog, 'table_name' | 'operation'> & Partial<Pick<AuditLog, 'id' | 'old_data' | 'new_data' | 'changed_at'>>;
export type AuditLogUpdate = Partial<Omit<AuditLog, 'id'>>;

export type Invitations = {
  id: string;
  org_id: string;
  email: string;
  role: 'manager' | 'member' | 'viewer';
  invited_by: string;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};

export type InvitationsCreate = Pick<Invitations, 'org_id' | 'email' | 'role' | 'invited_by' | 'token' | 'expires_at'> & Partial<Pick<Invitations, 'id' | 'accepted_at' | 'created_at'>>;
export type InvitationsUpdate = Partial<Omit<Invitations, 'id'>>;

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profiles;
        Insert: ProfilesCreate;
        Update: ProfilesUpdate;
        Relationships: [];
      };
      organizations: {
        Row: Organizations;
        Insert: OrganizationsCreate;
        Update: OrganizationsUpdate;
        Relationships: [];
      };
      org_members: {
        Row: OrgMembers;
        Insert: OrgMembersCreate;
        Update: OrgMembersUpdate;
        Relationships: [];
      };
      projects: {
        Row: Projects;
        Insert: ProjectsCreate;
        Update: ProjectsUpdate;
        Relationships: [];
      };
      tasks: {
        Row: Tasks;
        Insert: TasksCreate;
        Update: TasksUpdate;
        Relationships: [];
      };
      comments: {
        Row: Comments;
        Insert: CommentsCreate;
        Update: CommentsUpdate;
        Relationships: [];
      };
      audit_log: {
        Row: AuditLog;
        Insert: AuditLogCreate;
        Update: AuditLogUpdate;
        Relationships: [];
      };
      invitations: {
        Row: Invitations;
        Insert: InvitationsCreate;
        Update: InvitationsUpdate;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_org_dashboard: {
        Args: { p_org_id: string };
        Returns: Json;
      };
      accept_invitation: {
        Args: { p_token: string };
        Returns: string;
      };
      search_tasks: {
        Args: { p_org_id: string; p_query: string; p_limit: number };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
