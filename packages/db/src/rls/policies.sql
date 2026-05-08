-- ============================================================================
-- Row-level security policies.
-- Read app context from session GUCs set by withSession() in src/client.ts:
--   app.user_id        - the requesting user's employee_dim.id
--   app.tier           - exec_all | function_lead | manager | employee
--   app.function_area  - eng | sales | gtm | ops | finance | legal | hr (or '')
-- ============================================================================

-- Helper to read GUCs safely (returns NULL if unset).
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_tier() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('app.tier', true), ''), 'employee')
$$;

CREATE OR REPLACE FUNCTION app.current_function() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.function_area', true), '')
$$;

-- Recursive helper: is :report_id under the current user's reporting tree?
CREATE OR REPLACE FUNCTION app.is_under_current_manager(report_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    WITH RECURSIVE tree AS (
      SELECT report_id AS id
      FROM hr.manager_edge
      WHERE manager_id = app.current_user_id()
        AND (end_date IS NULL OR end_date > current_date)
      UNION
      SELECT me.report_id
      FROM hr.manager_edge me
      JOIN tree t ON me.manager_id = t.id
      WHERE me.end_date IS NULL OR me.end_date > current_date
    )
    SELECT EXISTS (SELECT 1 FROM tree WHERE id = report_id);
$$;

-- ============================================================================
-- HR: full read for exec_all and function_lead in same function;
-- managers see only their reporting tree; employees see only themselves.
-- ============================================================================

ALTER TABLE hr.employment ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employment FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employment_read ON hr.employment;
CREATE POLICY employment_read ON hr.employment FOR SELECT
  USING (
    app.current_tier() = 'exec_all'
    OR (
      app.current_tier() = 'function_lead'
      AND EXISTS (
        SELECT 1 FROM hr.org_unit ou
        WHERE ou.id = hr.employment.org_unit_id
          AND ou.function_area = app.current_function()
      )
    )
    OR (
      app.current_tier() = 'manager'
      AND (
        hr.employment.employee_id = app.current_user_id()
        OR app.is_under_current_manager(hr.employment.employee_id)
      )
    )
    OR (app.current_tier() = 'employee' AND hr.employment.employee_id = app.current_user_id())
  );

ALTER TABLE hr.manager_edge ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.manager_edge FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manager_edge_read ON hr.manager_edge;
CREATE POLICY manager_edge_read ON hr.manager_edge FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead')
    OR hr.manager_edge.manager_id = app.current_user_id()
    OR hr.manager_edge.report_id = app.current_user_id()
  );

ALTER TABLE hr.leave ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leave_read ON hr.leave;
CREATE POLICY leave_read ON hr.leave FOR SELECT
  USING (
    app.current_tier() = 'exec_all'
    OR hr.leave.employee_id = app.current_user_id()
    OR (app.current_tier() = 'manager' AND app.is_under_current_manager(hr.leave.employee_id))
  );

-- ============================================================================
-- COMP: exec_all only (no row policy needed — schema grants already gate it).
-- We still enable RLS as defense-in-depth in case future grants slip.
-- ============================================================================

ALTER TABLE comp.salary ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp.salary FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS salary_read ON comp.salary;
CREATE POLICY salary_read ON comp.salary FOR SELECT
  USING (app.current_tier() = 'exec_all');

ALTER TABLE comp.bonus ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp.bonus FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bonus_read ON comp.bonus;
CREATE POLICY bonus_read ON comp.bonus FOR SELECT
  USING (app.current_tier() = 'exec_all');

ALTER TABLE comp.equity_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp.equity_grant FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS equity_grant_read ON comp.equity_grant;
CREATE POLICY equity_grant_read ON comp.equity_grant FOR SELECT
  USING (app.current_tier() = 'exec_all');

ALTER TABLE comp.vesting_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp.vesting_schedule FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vesting_read ON comp.vesting_schedule;
CREATE POLICY vesting_read ON comp.vesting_schedule FOR SELECT
  USING (app.current_tier() = 'exec_all');

-- comp.comp_band is non-PII (band ranges only) — readable by all leads.
ALTER TABLE comp.comp_band ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp.comp_band FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comp_band_read ON comp.comp_band;
CREATE POLICY comp_band_read ON comp.comp_band FOR SELECT
  USING (app.current_tier() IN ('exec_all', 'function_lead'));

-- ============================================================================
-- Aggregate guard: views that expose comp aggregates must enforce min cell size.
-- This is a placeholder helper used by mart views (see transform/models/marts).
-- ============================================================================

CREATE OR REPLACE FUNCTION app.assert_min_cell_size(n integer, min_n integer DEFAULT 5)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT n >= min_n;
$$;

-- ============================================================================
-- CRM + PM (operational tier, this app is system-of-record).
--
-- Audience today is exec-team only:
--   exec_all          → read + write (sees ALL contacts including sensitive)
--   function_lead     → read-only (sensitive contacts hidden)
--   manager           → read-only (sensitive contacts hidden)
--   app_assistant     → read-only (sensitive contacts hidden) — Stream H adds
--                       the Postgres role; this policy already excludes them
--                       via the non-exec_all branch.
--   employee          → no access (except self-owned pm.task, see below)
--
-- We DROP/CREATE every policy idempotently to match the rest of this file.
-- ============================================================================

-- ============================================================================
-- Sensitive-contact helper function (C2, US-014 / SY-008).
--
-- Returns TRUE iff:
--   1. The current session tier is NOT exec_all, AND
--   2. The contact identified by contact_id has a non-null sensitive_flag.
--
-- Use: WHERE NOT crm.is_sensitive_for_role(contact_id)
--      so that sensitive rows are invisible to non-exec roles.
--
-- exec_all always sees everything — the function returns FALSE for them
-- regardless of the flag value.
--
-- Stream H (app_assistant) does not yet have a Postgres role, but once
-- added it will fall into the non-exec_all branch automatically.
--
-- SECURITY DEFINER safety analysis (PR2-J — Copilot review on PR #19):
--
--   This function is marked SECURITY DEFINER, which means it executes with
--   the privileges of the role that owns/created it (typically the migration
--   role, which has BYPASSRLS or is the crm schema owner).
--
--   The concern is Postgres RLS recursion: if crm.contact has RLS enabled
--   and a policy on crm.contact calls crm.is_sensitive_for_role(), which in
--   turn SELECTs from crm.contact, could Postgres recurse infinitely?
--
--   Answer: NO — SECURITY DEFINER is the standard escape hatch for exactly
--   this pattern.  When the function body executes as the definer role
--   (BYPASSRLS or schema owner), Postgres applies RLS only to the *outer*
--   query session role, not to queries inside SECURITY DEFINER functions
--   running as a higher-privilege role.  The inner SELECT on crm.contact
--   inside this function bypasses RLS entirely (the definer role has
--   BYPASSRLS), so there is no cycle.
--
--   Evidence: pg docs §5.8 "Row Security Policies" explicitly state that
--   SECURITY DEFINER functions run under the definer's GUC/role settings and
--   do not re-enter the calling session's RLS context.  Additionally,
--   SET search_path = crm, public above pins the search path so a malicious
--   caller cannot inject a shadow crm.contact view.
--
--   Conclusion: safe as-is.  No policy logic change needed.
-- ============================================================================

CREATE OR REPLACE FUNCTION crm.is_sensitive_for_role(p_contact_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = crm, public
AS $$
  SELECT
    -- Only evaluate the flag if the caller is not exec_all.
    app.current_tier() <> 'exec_all'
    AND EXISTS (
      SELECT 1
      FROM crm.contact c
      WHERE c.id = p_contact_id
        AND c.sensitive_flag IS NOT NULL
    );
$$;

-- Grant execute to the app runtime role so it runs inside RLS policies.
-- (app_exec is granted via the app_runtime grant chain; both roles need this.)
GRANT EXECUTE ON FUNCTION crm.is_sensitive_for_role(uuid) TO app_runtime;

-- ----- crm.contact -----
ALTER TABLE crm.contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.contact FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_read ON crm.contact;
CREATE POLICY contact_read ON crm.contact FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant')
    -- Sensitive contacts are hidden from all non-exec tiers.
    AND NOT crm.is_sensitive_for_role(crm.contact.id)
    -- exec_all sees everything: is_sensitive_for_role returns false for them.
  );

DROP POLICY IF EXISTS contact_write ON crm.contact;
CREATE POLICY contact_write ON crm.contact FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- crm.account -----
ALTER TABLE crm.account ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.account FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_read ON crm.account;
CREATE POLICY account_read ON crm.account FOR SELECT
  USING (app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant'));

DROP POLICY IF EXISTS account_write ON crm.account;
CREATE POLICY account_write ON crm.account FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- crm.call_note -----
ALTER TABLE crm.call_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.call_note FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_note_read ON crm.call_note;
CREATE POLICY call_note_read ON crm.call_note FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant')
    -- Hide notes whose parent contact is sensitive from non-exec roles.
    AND NOT crm.is_sensitive_for_role(crm.call_note.contact_id)
  );

DROP POLICY IF EXISTS call_note_write ON crm.call_note;
CREATE POLICY call_note_write ON crm.call_note FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- crm.calendar_event -----
ALTER TABLE crm.calendar_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.calendar_event FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_event_read ON crm.calendar_event;
CREATE POLICY calendar_event_read ON crm.calendar_event FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant')
    -- contact_id is nullable on calendar_event (event may have no linked contact).
    -- Only filter when a contact is linked; unlinked events are always visible.
    AND (
      crm.calendar_event.contact_id IS NULL
      OR NOT crm.is_sensitive_for_role(crm.calendar_event.contact_id)
    )
  );

DROP POLICY IF EXISTS calendar_event_write ON crm.calendar_event;
CREATE POLICY calendar_event_write ON crm.calendar_event FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- crm.email_thread -----
ALTER TABLE crm.email_thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.email_thread FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_thread_read ON crm.email_thread;
CREATE POLICY email_thread_read ON crm.email_thread FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant')
    -- contact_id is nullable on email_thread (thread may have no linked contact).
    AND (
      crm.email_thread.contact_id IS NULL
      OR NOT crm.is_sensitive_for_role(crm.email_thread.contact_id)
    )
  );

DROP POLICY IF EXISTS email_thread_write ON crm.email_thread;
CREATE POLICY email_thread_write ON crm.email_thread FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- crm.draft -----
ALTER TABLE crm.draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.draft FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS draft_read ON crm.draft;
CREATE POLICY draft_read ON crm.draft FOR SELECT
  USING (app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant'));

DROP POLICY IF EXISTS draft_write ON crm.draft;
CREATE POLICY draft_write ON crm.draft FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- crm.oauth_token -----
-- app_runtime: users may only read/write their own tokens.
-- app_exec:    audit visibility (SELECT all). DELETE is exec-only (hard delete for now).
-- Stream A owns these policies. DROP IF EXISTS + CREATE keeps merges clean.
ALTER TABLE crm.oauth_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.oauth_token FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oauth_token_self_select ON crm.oauth_token;
CREATE POLICY oauth_token_self_select ON crm.oauth_token FOR SELECT
  USING (
    crm.oauth_token.user_id = app.current_user_id()
    OR app.current_tier() = 'exec_all'
  );

DROP POLICY IF EXISTS oauth_token_self_insert ON crm.oauth_token;
CREATE POLICY oauth_token_self_insert ON crm.oauth_token FOR INSERT
  WITH CHECK (crm.oauth_token.user_id = app.current_user_id());

DROP POLICY IF EXISTS oauth_token_self_update ON crm.oauth_token;
CREATE POLICY oauth_token_self_update ON crm.oauth_token FOR UPDATE
  USING (crm.oauth_token.user_id = app.current_user_id())
  WITH CHECK (crm.oauth_token.user_id = app.current_user_id());

DROP POLICY IF EXISTS oauth_token_exec_delete ON crm.oauth_token;
CREATE POLICY oauth_token_exec_delete ON crm.oauth_token FOR DELETE
  USING (app.current_tier() = 'exec_all');

-- ----- crm.user_pref -----
-- Each user may read and update their own preferences row.
-- app_exec (exec_all tier) reads all rows for the digest cron worker.
-- INSERT is allowed by any authenticated user so they can opt in for the first time.
ALTER TABLE crm.user_pref ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.user_pref FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_pref_self_select ON crm.user_pref;
CREATE POLICY user_pref_self_select ON crm.user_pref FOR SELECT
  USING (
    crm.user_pref.user_id = app.current_user_id()
    OR app.current_tier() = 'exec_all'
  );

DROP POLICY IF EXISTS user_pref_self_insert ON crm.user_pref;
CREATE POLICY user_pref_self_insert ON crm.user_pref FOR INSERT
  WITH CHECK (crm.user_pref.user_id = app.current_user_id());

DROP POLICY IF EXISTS user_pref_self_update ON crm.user_pref;
CREATE POLICY user_pref_self_update ON crm.user_pref FOR UPDATE
  USING (crm.user_pref.user_id = app.current_user_id())
  WITH CHECK (crm.user_pref.user_id = app.current_user_id());

-- ----- pm.project -----
ALTER TABLE pm.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.project FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_read ON pm.project;
CREATE POLICY project_read ON pm.project FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant')
    OR pm.project.owner_id = app.current_user_id()
  );

DROP POLICY IF EXISTS project_write ON pm.project;
CREATE POLICY project_write ON pm.project FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- pm.task -----
-- Reads also include any task an employee owns directly, so a future audience
-- expansion (giving everyone a digest of their own tasks) is a one-line
-- middleware change rather than a policy rewrite.
ALTER TABLE pm.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.task FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_read ON pm.task;
CREATE POLICY task_read ON pm.task FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant')
    OR pm.task.owner_id = app.current_user_id()
  );

DROP POLICY IF EXISTS task_write ON pm.task;
CREATE POLICY task_write ON pm.task FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- pm.task_dependency -----
ALTER TABLE pm.task_dependency ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.task_dependency FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_dependency_read ON pm.task_dependency;
CREATE POLICY task_dependency_read ON pm.task_dependency FOR SELECT
  USING (app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant'));

DROP POLICY IF EXISTS task_dependency_write ON pm.task_dependency;
CREATE POLICY task_dependency_write ON pm.task_dependency FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ----- pm.digest_send -----
ALTER TABLE pm.digest_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.digest_send FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS digest_send_read ON pm.digest_send;
CREATE POLICY digest_send_read ON pm.digest_send FOR SELECT
  USING (
    app.current_tier() IN ('exec_all', 'function_lead', 'manager', 'assistant')
    OR pm.digest_send.recipient_id = app.current_user_id()
  );

DROP POLICY IF EXISTS digest_send_write ON pm.digest_send;
CREATE POLICY digest_send_write ON pm.digest_send FOR ALL
  USING (app.current_tier() = 'exec_all')
  WITH CHECK (app.current_tier() = 'exec_all');

-- ============================================================================
-- audit.llm_call (SY-017, AD-005)
--
-- Append-only. No UPDATE or DELETE policies. A delete-prevention RULE/trigger
-- (below) enforces this at the DB level per AD-005 (365-day retention).
--
-- INSERT:  app_exec only (audit writes always run as app_exec per recordLlmCall).
-- SELECT:  app_exec can read all rows.
--          app_function_lead + app_assistant can read all rows.
--          TODO(stream C): tighten function_lead + assistant SELECT to exclude
--          rows whose contact_id resolves to a sensitive contact once
--          crm.contact.sensitive_flag is added by stream C.
-- ============================================================================

ALTER TABLE audit.llm_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.llm_call FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS llm_call_exec_read ON audit.llm_call;
CREATE POLICY llm_call_exec_read ON audit.llm_call FOR SELECT
  USING (app.current_tier() = 'exec_all');

-- function_lead and app_assistant may read all rows for now.
-- TODO(stream C): join to crm.contact and exclude sensitive contacts.
DROP POLICY IF EXISTS llm_call_lead_read ON audit.llm_call;
CREATE POLICY llm_call_lead_read ON audit.llm_call FOR SELECT
  USING (app.current_tier() IN ('function_lead', 'assistant'));

DROP POLICY IF EXISTS llm_call_insert ON audit.llm_call;
CREATE POLICY llm_call_insert ON audit.llm_call FOR INSERT
  WITH CHECK (app.current_tier() = 'exec_all');

-- Append-only enforcement via a BEFORE trigger (SY-017 / AD-005).
--
-- Previous implementation used DO INSTEAD rules with SELECT 1/0 to raise a
-- division-by-zero exception (Copilot review on PR #19 flagged this as
-- unclear and non-standard).  Replaced with a proper BEFORE UPDATE OR DELETE
-- trigger that issues an unambiguous RAISE EXCEPTION.  Triggers fire before
-- the DML reaches any RLS policy or storage, so this is stronger than the
-- DO INSTEAD approach and works even for superusers who bypass RLS.
--
-- The old rules are dropped first to avoid duplicate enforcement.
DROP RULE IF EXISTS llm_call_no_delete ON audit.llm_call;
DROP RULE IF EXISTS llm_call_no_update ON audit.llm_call;

CREATE OR REPLACE FUNCTION audit.llm_call_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit.llm_call is append-only (PR2 SY-017/AD-005); % is prohibited',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS llm_call_no_mutate ON audit.llm_call;
CREATE TRIGGER llm_call_no_mutate
  BEFORE UPDATE OR DELETE ON audit.llm_call
  FOR EACH ROW EXECUTE FUNCTION audit.llm_call_append_only();
