-- ============================================================================
-- Roles for the three-tier RBAC model.
-- Run as a superuser (the DATABASE_URL principal). Idempotent.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PROD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_exec') THEN
    CREATE ROLE app_exec NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_function_lead') THEN
    CREATE ROLE app_function_lead NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_manager') THEN
    CREATE ROLE app_manager NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_employee') THEN
    CREATE ROLE app_employee NOLOGIN;
  END IF;
  -- app_assistant: Chief-of-Staff / EA role. Read-only on CRM + PM;
  -- sensitive contacts are still hidden (enforced by CRM RLS policies).
  -- Added in PR2-H to satisfy AD-002 (US-023, W7.1).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_assistant') THEN
    CREATE ROLE app_assistant NOLOGIN;
  END IF;
END$$;

-- The login role inherits whichever tier role the app SET ROLEs into per-request.
GRANT app_exec, app_function_lead, app_manager, app_employee, app_assistant TO app_runtime;

-- Schema-level grants. Note: comp is restricted to app_exec only.
GRANT USAGE ON SCHEMA core, hr, fin, legal, ops, audit TO
  app_exec, app_function_lead, app_manager, app_employee, app_assistant;
GRANT USAGE ON SCHEMA comp TO app_exec;
-- CRM + PM (operational tier): read for exec/function_lead/manager/assistant, write for exec only.
GRANT USAGE ON SCHEMA crm, pm TO app_exec, app_function_lead, app_manager, app_assistant;

-- Default privileges so future tables created by the migration role inherit grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA core, hr, fin, legal, ops
  GRANT SELECT ON TABLES TO app_exec, app_function_lead, app_manager, app_employee, app_assistant;
ALTER DEFAULT PRIVILEGES IN SCHEMA comp GRANT SELECT ON TABLES TO app_exec;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT INSERT ON TABLES TO app_exec, app_function_lead, app_manager, app_employee, app_assistant;
-- audit.llm_call SELECT: app_exec only; app_function_lead + app_assistant get SELECT
-- via their own RLS policies (see policies.sql) but no schema-default SELECT here.
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT ON TABLES TO app_exec;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm, pm
  GRANT SELECT ON TABLES TO app_exec, app_function_lead, app_manager, app_assistant;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm, pm
  GRANT INSERT, UPDATE, DELETE ON TABLES TO app_exec;

-- Apply to existing tables right now (default privs only affect future tables).
GRANT SELECT ON ALL TABLES IN SCHEMA core, hr, fin, legal, ops TO
  app_exec, app_function_lead, app_manager, app_employee, app_assistant;
GRANT SELECT ON ALL TABLES IN SCHEMA comp TO app_exec;
GRANT INSERT ON ALL TABLES IN SCHEMA audit TO
  app_exec, app_function_lead, app_manager, app_employee, app_assistant;
GRANT SELECT ON ALL TABLES IN SCHEMA audit TO app_exec;
GRANT SELECT ON ALL TABLES IN SCHEMA crm, pm TO
  app_exec, app_function_lead, app_manager, app_assistant;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crm, pm TO app_exec;
