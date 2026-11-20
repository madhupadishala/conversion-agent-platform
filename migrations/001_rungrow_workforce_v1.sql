CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS rungrow_external_tenants (
  external_tenant_id varchar(160) PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rungrow_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_tenant_id varchar(160) NOT NULL,
  name varchar(160) NOT NULL,
  phone varchar(32),
  email varchar(254),
  status varchar(24) NOT NULL DEFAULT 'QUALIFIED' CHECK (status IN ('QUALIFIED','CONTACTED','CONVERTED','LOST')),
  source_url text NOT NULL,
  correlation_id varchar(128) NOT NULL,
  approval_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS rungrow_prospect_tenant_phone
  ON rungrow_prospects(external_tenant_id,phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rungrow_prospect_tenant_email
  ON rungrow_prospects(external_tenant_id,email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS rungrow_prospect_tenant_created
  ON rungrow_prospects(external_tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS rungrow_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_tenant_id varchar(160) NOT NULL,
  endpoint varchar(160) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(external_tenant_id,endpoint,idempotency_key)
);

CREATE TABLE IF NOT EXISTS rungrow_telemetry_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_tenant_id varchar(160) NOT NULL,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type varchar(100) NOT NULL,
  payload jsonb NOT NULL,
  recognised_revenue_inr numeric(14,2) NOT NULL DEFAULT 0 CHECK (recognised_revenue_inr >= 0),
  state varchar(16) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(external_tenant_id,event_id)
);
CREATE INDEX IF NOT EXISTS rungrow_telemetry_due
  ON rungrow_telemetry_outbox(external_tenant_id,next_attempt_at) WHERE state='pending';

DO $policy$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['rungrow_prospects','rungrow_idempotency','rungrow_telemetry_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS rungrow_tenant_isolation ON %I',table_name);
    EXECUTE format(
      'CREATE POLICY rungrow_tenant_isolation ON %I USING (external_tenant_id = current_setting(''app.external_tenant_id'',true)) WITH CHECK (external_tenant_id = current_setting(''app.external_tenant_id'',true))',
      table_name
    );
  END LOOP;
END
$policy$;
