# Conversion Agent Platform

Multi-tenant AI conversion orchestration platform for turning inbound enquiries into qualified, scheduled, paid appointments with approved client knowledge and human handoff.

## V0 scope

Lead intake → contact eligibility → conversation orchestration → qualification → slot lookup → booking hold → payment → confirmation → reminders → human escalation.

> No production credentials or client data belong in this repository.

## RunGrow Workforce Adapter v1

The product adapter is mounted independently of the existing voice, calendar, payment, and in-memory orchestration runtime.

Required configuration:
- `DATABASE_URL`: PostgreSQL connection string for the adapter-owned prospect, idempotency, and telemetry tables.
- `RUNGROW_WORKFORCE_HMAC_SECRET`: shared per-product HMAC secret; configure the same value in RunGrow as `RUNGROW_ADAPTER_SECRET_CLINICS_COUNTER`.
- `RUNGROW_WORKFORCE_TENANT_ID`: internal RunGrow Workforce tenant ID.
- `RUNGROW_WEBHOOK_URL`: exact HTTPS URL `/v1/adapters/clinics-counter/webhooks` on RunGrow.
- `CRON_SECRET`: bearer secret for `GET /api/cron/rungrow-telemetry`.

Apply `migrations/001_rungrow_workforce_v1.sql` before enabling the adapter. Missing database or HMAC configuration returns HTTP 503. The adapter's summary is based on its persisted RunGrow-qualified prospects; the existing `RuntimeStore` for the voice/appointment workflow remains in-memory and is not represented as durable product history. Invoice revenue is emitted only from explicit recognised-invoice lifecycle events; payment confirmation alone is not recognised revenue.
