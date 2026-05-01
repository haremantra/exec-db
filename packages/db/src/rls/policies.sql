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
