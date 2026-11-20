import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  closeWorkforcePool, dispatchPendingTelemetry, handleWorkforceRequest,
  recordLifecycleEvent, signWorkforceRequest,
} from "../src/rungrow-workforce.js";

const secret = "ci-rungrow-workforce-secret-with-at-least-32-characters";
const workforceTenant = "rungrow-internal-workforce";
const tenantA = "clinic-tenant-" + randomUUID();
const tenantB = "clinic-tenant-" + randomUUID();
const productId = "clinics-counter";
let cleanupPool: Pool;

function request(method: string, path: string, tenant: string, scope: "read" | "write",
  payload?: Record<string, unknown>, idempotencyKey?: string) {
  const rawBody = Buffer.from(payload ? JSON.stringify(payload) : "");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const scopes = [productId + ":" + scope];
  const headers: Record<string, string> = {
    "x-rungrow-signature": signWorkforceRequest(rawBody, timestamp, workforceTenant, tenant, scopes, secret),
    "x-rungrow-timestamp": timestamp,
    "x-rungrow-product-id": productId,
    "x-rungrow-tenant-id": workforceTenant,
    "x-rungrow-external-tenant-id": tenant,
    "x-rungrow-scopes": scopes.join(","),
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return { method, path, headers, rawBody };
}

before(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rungrow:rungrow@localhost:5432/rungrow";
  process.env.RUNGROW_WORKFORCE_HMAC_SECRET = secret;
  cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL });
  await cleanupPool.query("SELECT 1");
});

after(async () => {
  for (const tenant of [tenantA, tenantB]) {
    const client = await cleanupPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.external_tenant_id',$1,true)", [tenant]);
      await client.query("DELETE FROM rungrow_idempotency WHERE external_tenant_id=$1", [tenant]);
      await client.query("DELETE FROM rungrow_prospects WHERE external_tenant_id=$1", [tenant]);
      await client.query("DELETE FROM rungrow_telemetry_outbox WHERE external_tenant_id=$1", [tenant]);
      await client.query("COMMIT");
      await client.query("DELETE FROM rungrow_external_tenants WHERE external_tenant_id=$1", [tenant]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  await cleanupPool.end();
  await closeWorkforcePool();
  delete process.env.RUNGROW_WORKFORCE_HMAC_SECRET;
  delete process.env.RUNGROW_WEBHOOK_URL;
  delete process.env.RUNGROW_WORKFORCE_TENANT_ID;
});

test("signed tenant summary is database-derived and isolated", async () => {
  const payloadA = { name: "Tenant A Prospect", phone: "+919876500001",
    source_url: "https://source.example/a", correlation_id: "corr-a", approval_id: "approval-a" };
  const payloadB = { name: "Tenant B Private Prospect", phone: "+919876500002",
    source_url: "https://source.example/b", correlation_id: "corr-b", approval_id: "approval-b" };
  const a = await handleWorkforceRequest(request("POST", "/api/v1/workforce/prospects/handoff", tenantA, "write", payloadA, "key-a"));
  const b = await handleWorkforceRequest(request("POST", "/api/v1/workforce/prospects/handoff", tenantB, "write", payloadB, "key-b"));
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  const summary = await handleWorkforceRequest(request("GET", "/api/v1/workforce/summary", tenantA, "read"));
  assert.equal(summary.status, 200);
  const body = summary.body as { metrics: { total_prospects: number }; recent_prospects: Array<{ name: string }> };
  assert.equal(body.metrics.total_prospects, 1);
  assert.equal(body.recent_prospects[0]?.name, "Tenant A Prospect");
  assert.equal(JSON.stringify(summary.body).includes("Tenant B Private Prospect"), false);

  const prospectList = await handleWorkforceRequest(request("GET", "/api/v1/workforce/prospects", tenantA, "read"));
  assert.equal(prospectList.status, 200);
  const listBody = prospectList.body as { prospects: Array<{ name: string }> };
  assert.equal(listBody.prospects.length, 1);
  assert.equal(listBody.prospects[0]?.name, "Tenant A Prospect");
  assert.equal(JSON.stringify(prospectList.body).includes("Tenant B Private Prospect"), false);
});

test("durable handoff idempotency replays identical payload and returns 409 on payload mismatch", async () => {
  const payload = { name: "Idempotent Prospect", email: "same@example.test",
    source_url: "https://source.example/idempotent", correlation_id: "corr-idem", approval_id: "approval-idem" };
  const first = await handleWorkforceRequest(request("POST", "/api/v1/workforce/prospects/handoff", tenantA, "write", payload, "same-key"));
  const replay = await handleWorkforceRequest(request("POST", "/api/v1/workforce/prospects/handoff", tenantA, "write", payload, "same-key"));
  const conflict = await handleWorkforceRequest(request("POST", "/api/v1/workforce/prospects/handoff", tenantA, "write",
    { ...payload, name: "Payload changed" }, "same-key"));
  assert.equal(first.status, 202);
  assert.equal(replay.status, 200);
  assert.equal((replay.body as { replayed: boolean }).replayed, true);
  assert.equal(conflict.status, 409);
  const countClient = await cleanupPool.connect();
  try {
    await countClient.query("BEGIN");
    await countClient.query("SELECT set_config('app.external_tenant_id',$1,true)", [tenantA]);
    const count = await countClient.query("SELECT count(*)::int AS count FROM rungrow_prospects WHERE external_tenant_id=$1 AND email=$2",
      [tenantA, payload.email]);
    assert.equal(count.rows[0].count, 1);
    await countClient.query("COMMIT");
  } catch (error) {
    await countClient.query("ROLLBACK");
    throw error;
  } finally { countClient.release(); }
});

test("lifecycle events carry zero revenue; only recognised invoice events carry recognised revenue", async () => {
  await recordLifecycleEvent(tenantA, "prospect.qualified", { recognised_revenue_inr: 9000 });
  await recordLifecycleEvent(tenantA, "invoice.recognised", { recognised_revenue_inr: 2500 });
  const client = await cleanupPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.external_tenant_id',$1,true)", [tenantA]);
    const rows = await client.query("SELECT event_type,recognised_revenue_inr::text FROM rungrow_telemetry_outbox WHERE external_tenant_id=$1 ORDER BY created_at",
      [tenantA]);
    assert.equal(rows.rows.find(row => row.event_type === "prospect.qualified")?.recognised_revenue_inr, "0.00");
    assert.equal(rows.rows.find(row => row.event_type === "invoice.recognised")?.recognised_revenue_inr, "2500.00");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

test("signed outbound telemetry is durable and only marked delivered after provider acceptance", async () => {
  process.env.RUNGROW_WEBHOOK_URL = "https://api.rungrow.example/v1/adapters/clinics-counter/webhooks";
  process.env.RUNGROW_WORKFORCE_TENANT_ID = workforceTenant;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.match(headers.get("X-RunGrow-Signature") ?? "", /^sha256=/);
    assert.equal(headers.get("X-RunGrow-Scopes"), "clinics-counter:write");
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  try {
    const result = await dispatchPendingTelemetry();
    assert.ok(result.delivered >= 1);
    assert.ok(calls >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
