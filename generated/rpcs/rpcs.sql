-- ============================================
-- AccessNexus: Auto-generated RPC functions
-- ============================================

CREATE OR REPLACE FUNCTION get_org_dashboard(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN (
          SELECT json_build_object(
            'total_projects', (SELECT count(*) FROM projects WHERE org_id = p_org_id AND deleted_at IS NULL),
            'total_tasks', (SELECT count(*) FROM tasks WHERE org_id = p_org_id),
            'tasks_done', (SELECT count(*) FROM tasks WHERE org_id = p_org_id AND status = 'done'),
            'total_members', (SELECT count(*) FROM org_members WHERE org_id = p_org_id),
            'overdue_tasks', (SELECT count(*) FROM tasks WHERE org_id = p_org_id AND due_date < CURRENT_DATE AND status != 'done')
          )
        );
END;
$$;

CREATE OR REPLACE FUNCTION accept_invitation(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
          v_invitation invitations%ROWTYPE;
          v_member_id uuid;
        BEGIN
          IF (SELECT auth.uid()) IS NULL THEN
            RAISE EXCEPTION 'Sign in to accept an invitation' USING ERRCODE = '42501';
          END IF;
          SELECT * INTO v_invitation FROM invitations
            WHERE token = p_token AND accepted_at IS NULL AND expires_at > NOW();
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid or expired invitation';
          END IF;
          -- Only the invited address can accept (the token alone is not enough)
          IF lower(v_invitation.email) IS DISTINCT FROM lower((SELECT auth.jwt()) ->> 'email') THEN
            RAISE EXCEPTION 'This invitation was sent to another email address';
          END IF;
          -- ...and only once that address is confirmed (projects with "Confirm email"
          -- off would otherwise let anyone sign up with the invitee's address)
          IF NOT EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid()) AND u.email_confirmed_at IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'Confirm your email address before accepting an invitation' USING ERRCODE = '42501';
          END IF;

          -- Each enum column has its own type: cast invitations.role to org_members.role
          INSERT INTO org_members (id, org_id, user_id, role, invited_by)
          VALUES (gen_random_uuid(), v_invitation.org_id, (SELECT auth.uid()), v_invitation.role::text::org_members_role_enum, v_invitation.invited_by)
          RETURNING id INTO v_member_id;

          UPDATE invitations SET accepted_at = NOW() WHERE id = v_invitation.id;
          RETURN v_member_id;
        END;
$$;
REVOKE EXECUTE ON FUNCTION accept_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_invitation(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION search_tasks(p_org_id UUID, p_query TEXT, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN (
          SELECT json_agg(t) FROM (
            SELECT * FROM tasks
            WHERE org_id = p_org_id
              AND (title ILIKE '%' || p_query || '%' OR description ILIKE '%' || p_query || '%')
            ORDER BY created_at DESC
            LIMIT COALESCE(p_limit, 20)
          ) t
        );
END;
$$;
