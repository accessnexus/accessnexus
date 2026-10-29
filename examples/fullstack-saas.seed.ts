// ============================================
// AccessNexus - Seed Data
// Project Management SaaS (multi-tenant)
// ============================================

import { defineSeed } from '../src/index.js';
import schema from './fullstack-saas.schema.js';

export default defineSeed(schema, {
  profiles: [
    { id: '00000000-0000-0000-0000-000000000001', email: 'admin@example.com', name: 'Admin User' },
    { id: '00000000-0000-0000-0000-000000000002', email: 'manager@example.com', name: 'Project Manager' },
    { id: '00000000-0000-0000-0000-000000000003', email: 'dev@example.com', name: 'Developer' },
  ],

  organizations: [
    { id: '10000000-0000-0000-0000-000000000001', name: 'Acme Corp', slug: 'acme', owner_id: '00000000-0000-0000-0000-000000000001', plan: 'pro' },
  ],

  org_members: [
    { id: '20000000-0000-0000-0000-000000000001', org_id: '10000000-0000-0000-0000-000000000001', user_id: '00000000-0000-0000-0000-000000000001', role: 'admin' },
    { id: '20000000-0000-0000-0000-000000000002', org_id: '10000000-0000-0000-0000-000000000001', user_id: '00000000-0000-0000-0000-000000000002', role: 'manager' },
    { id: '20000000-0000-0000-0000-000000000003', org_id: '10000000-0000-0000-0000-000000000001', user_id: '00000000-0000-0000-0000-000000000003', role: 'member' },
  ],

  projects: [
    { id: '30000000-0000-0000-0000-000000000001', org_id: '10000000-0000-0000-0000-000000000001', name: 'Website Redesign', status: 'active', created_by: '00000000-0000-0000-0000-000000000002', is_public: false },
  ],

  tasks: [
    { id: '40000000-0000-0000-0000-000000000001', org_id: '10000000-0000-0000-0000-000000000001', project_id: '30000000-0000-0000-0000-000000000001', title: 'Design homepage mockup', status: 'in_progress', priority: 'high', assignee_id: '00000000-0000-0000-0000-000000000003', reporter_id: '00000000-0000-0000-0000-000000000002', position: 1 },
    { id: '40000000-0000-0000-0000-000000000002', org_id: '10000000-0000-0000-0000-000000000001', project_id: '30000000-0000-0000-0000-000000000001', title: 'Set up CI/CD pipeline', status: 'todo', priority: 'medium', reporter_id: '00000000-0000-0000-0000-000000000002', position: 2 },
  ],
});
