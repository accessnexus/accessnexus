-- ============================================
-- AccessNexus: Auto-generated Realtime setup
-- ============================================

-- Postgres Changes: publication membership (supabase_realtime).
-- Subscribers only receive rows their SELECT policy shows them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE WARNING 'AccessNexus: publication supabase_realtime does not exist; Realtime table changes were not applied';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tasks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'comments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.comments;
  END IF;
END $$;

ALTER TABLE public.tasks REPLICA IDENTITY DEFAULT;
ALTER TABLE public.comments REPLICA IDENTITY DEFAULT;

-- Broadcast / Presence authorization: RLS on realtime.messages (private channels).
-- Drop channel policies of this prefix that the schema no longer declares.
DO $$
DECLARE
  stale record;
BEGIN
  FOR stale IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'realtime' AND tablename = 'messages'
      AND starts_with(policyname, 'accessnexus_rt_')
      AND policyname NOT IN ('accessnexus_rt_project_room_broadcast_receive', 'accessnexus_rt_project_room_broadcast_send', 'accessnexus_rt_project_room_presence_receive', 'accessnexus_rt_project_room_presence_send', 'accessnexus_rt_org_announcements_broadcast_receive', 'accessnexus_rt_org_announcements_broadcast_send')
  LOOP
    EXECUTE format('DROP POLICY %I ON realtime.messages', stale.policyname);
  END LOOP;
END $$;

-- Channel project_room: topic project:{id} (row of projects)
DROP POLICY IF EXISTS "accessnexus_rt_project_room_broadcast_receive" ON realtime.messages;
CREATE POLICY "accessnexus_rt_project_room_broadcast_receive"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND left(realtime.topic(), 8) = 'project:'
    AND length(realtime.topic()) > 8
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.projects WHERE projects.id = CASE WHEN substr(realtime.topic(), 9) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(realtime.topic(), 9)::uuid END)
  );
DROP POLICY IF EXISTS "accessnexus_rt_project_room_broadcast_send" ON realtime.messages;
CREATE POLICY "accessnexus_rt_project_room_broadcast_send"
  ON realtime.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND left(realtime.topic(), 8) = 'project:'
    AND length(realtime.topic()) > 8
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.projects WHERE projects.id = CASE WHEN substr(realtime.topic(), 9) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(realtime.topic(), 9)::uuid END)
  );
DROP POLICY IF EXISTS "accessnexus_rt_project_room_presence_receive" ON realtime.messages;
CREATE POLICY "accessnexus_rt_project_room_presence_receive"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'presence'
    AND left(realtime.topic(), 8) = 'project:'
    AND length(realtime.topic()) > 8
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.projects WHERE projects.id = CASE WHEN substr(realtime.topic(), 9) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(realtime.topic(), 9)::uuid END)
  );
DROP POLICY IF EXISTS "accessnexus_rt_project_room_presence_send" ON realtime.messages;
CREATE POLICY "accessnexus_rt_project_room_presence_send"
  ON realtime.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'presence'
    AND left(realtime.topic(), 8) = 'project:'
    AND length(realtime.topic()) > 8
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.projects WHERE projects.id = CASE WHEN substr(realtime.topic(), 9) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(realtime.topic(), 9)::uuid END)
  );

-- Channel org_announcements: topic org:{id} (row of organizations)
DROP POLICY IF EXISTS "accessnexus_rt_org_announcements_broadcast_receive" ON realtime.messages;
CREATE POLICY "accessnexus_rt_org_announcements_broadcast_receive"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND left(realtime.topic(), 4) = 'org:'
    AND length(realtime.topic()) > 4
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.organizations WHERE organizations.id = CASE WHEN substr(realtime.topic(), 5) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(realtime.topic(), 5)::uuid END)
  );
DROP POLICY IF EXISTS "accessnexus_rt_org_announcements_broadcast_send" ON realtime.messages;
CREATE POLICY "accessnexus_rt_org_announcements_broadcast_send"
  ON realtime.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND left(realtime.topic(), 4) = 'org:'
    AND length(realtime.topic()) > 4
    AND (((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin')
    AND EXISTS (SELECT 1 FROM public.organizations WHERE organizations.id = CASE WHEN substr(realtime.topic(), 5) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(realtime.topic(), 5)::uuid END)
  );
DROP POLICY IF EXISTS "accessnexus_rt_org_announcements_presence_receive" ON realtime.messages;
DROP POLICY IF EXISTS "accessnexus_rt_org_announcements_presence_send" ON realtime.messages;
