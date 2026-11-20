import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export const RUNGROW_PRODUCT_ID = "clinics-counter";
const READ_SCOPE = RUNGROW_PRODUCT_ID + ":read";
const WRITE_SCOPE = RUNGROW_PRODUCT_ID + ":write";
const HANDOFF_PATH = "/api/v1/workforce/prospects/handoff";
const SUMMARY_PATH = "/api/v1/workforce/summary";
const PROSPECTS_PATH = "/api/v1/workforce/prospects";
let pool: Pool | undefined;

function database(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw Object.assign(new Error("DATABASE_URL is not configured"), { status: 503 });
  if (!pool) pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  return pool;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function signWorkforceRequest(body: Buffer | string, timestamp: string, workforceTenantId: string,
  externalTenantId: string, scopes: string[], secret: string): string {
  const canonicalScopes = [...new Set(scopes)].sort().join(",");
  const digest = createHash("sha256").update(body).digest("hex");
  const binding = [timestamp, RUNGROW_PRODUCT_ID, workforceTenantId, externalTenantId, canonicalScopes, digest].join(".");
  return "sha256=" + createHmac("sha256", secret).update(binding).digest("hex");
}

export function verifyWorkforceRequest(headers: Record<string, string | string[] | undefined>, body: Buffer,
  requiredScope: string, nowSeconds = Date.now() / 1000) {
  const secret = process.env.RUNGROW_WORKFORCE_HMAC_SECRET;
  if (!secret) throw Object.assign(new Error("Workforce adapter is not configured"), { status: 503 });
  const signature = header(headers, "x-rungrow-signature");
  const timestamp = header(headers, "x-rungrow-timestamp");
  const productId = header(headers, "x-rungrow-product-id");
  const externalTenantId = header(headers, "x-rungrow-external-tenant-id");
  const workforceTenantId = header(headers, "x-rungrow-tenant-id");
  const scopesHeader = header(headers, "x-rungrow-scopes");
  const scopes = scopesHeader.split(",").map(value => value.trim()).filter(Boolean);
  const canonicalScopes = [...new Set(scopes)].sort().join(",");
  if (!signature || !timestamp || !externalTenantId || !workforceTenantId || productId !== RUNGROW_PRODUCT_ID
      || externalTenantId === workforceTenantId) {
    throw Object.assign(new Error("Missing or invalid product/tenant identity headers"), { status: 401 });
  }
  if (!/^\d{10}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300) {
    throw Object.assign(new Error("Timestamp outside the 300-second replay window"), { status: 401 });
  }
  if (!scopes.length || canonicalScopes !== scopesHeader || !scopes.includes(requiredScope)) {
    throw Object.assign(new Error("Missing required sorted product scope"), { status: 403 });
  }
  const expected = signWorkforceRequest(body, timestamp, workforceTenantId, externalTenantId, scopes, secret);
  const supplied = signature.startsWith("sha256=") ? signature : "sha256=" + signature;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Invalid workforce HMAC signature"), { status: 401 });
  }
  return { externalTenantId, workforceTenantId, scopes };
}

async function inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.external_tenant_id',$1,true)", [tenantId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordLifecycleEvent(tenantId: string, eventType: string, payload: Record<string, unknown>) {
  const invoiceEvent = eventType === "invoice.recognised" || eventType === "invoice.recognized";
  const revenue = invoiceEvent ? Math.max(0, Number(payload.recognised_revenue_inr ?? 0)) : 0;
  if (!Number.isFinite(revenue)) throw new Error("recognised_revenue_inr must be finite");
  return inTenant(tenantId, async client => {
    const result = await client.query(
      "INSERT INTO rungrow_telemetry_outbox (external_tenant_id,event_type,payload,recognised_revenue_inr) VALUES ($1,$2,$3,$4) RETURNING id",
      [tenantId, eventType, JSON.stringify(payload), revenue]
    );
    return result.rows[0].id as string;
  });
}

export async function handleWorkforceRequest(input: {
  method: string; path: string; headers: Record<string, string | string[] | undefined>; rawBody: Buffer;
}): Promise<{ status: number; body: unknown }> {
  try {
    if (input.method === "GET" && input.path === SUMMARY_PATH) {
      const auth = verifyWorkforceRequest(input.headers, input.rawBody, READ_SCOPE);
      const result = await inTenant(auth.externalTenantId, async client => {
        const [total, qualified, converted, recent] = await Promise.all([
          client.query("SELECT count(*)::int AS count FROM rungrow_prospects WHERE external_tenant_id=$1", [auth.externalTenantId]),
          client.query("SELECT count(*)::int AS count FROM rungrow_prospects WHERE external_tenant_id=$1 AND status='QUALIFIED'", [auth.externalTenantId]),
          client.query("SELECT count(*)::int AS count FROM rungrow_prospects WHERE external_tenant_id=$1 AND status='CONVERTED'", [auth.externalTenantId]),
          client.query("SELECT id,name,status,created_at FROM rungrow_prospects WHERE external_tenant_id=$1 ORDER BY created_at DESC LIMIT 10", [auth.externalTenantId]),
        ]);
        return { product_id: RUNGROW_PRODUCT_ID, api_version: "v1", external_tenant_id: auth.externalTenantId,
          metrics: { total_prospects: total.rows[0].count, qualified_prospects: qualified.rows[0].count,
            converted_prospects: converted.rows[0].count }, recent_prospects: recent.rows };
      });
      return { status: 200, body: result };
    }
    if (input.method === "GET" && input.path === PROSPECTS_PATH) {
      const auth = verifyWorkforceRequest(input.headers, input.rawBody, READ_SCOPE);
      const result = await inTenant(auth.externalTenantId, async client => {
        const rows = await client.query(
          "SELECT id,name,status,source_url,correlation_id,approval_id,created_at,updated_at FROM rungrow_prospects WHERE external_tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
          [auth.externalTenantId]
        );
        return { product_id: RUNGROW_PRODUCT_ID, api_version: "v1",
          external_tenant_id: auth.externalTenantId, prospects: rows.rows };
      });
      return { status: 200, body: result };
    }
    if (input.method === "POST" && input.path === HANDOFF_PATH) {
      const auth = verifyWorkforceRequest(input.headers, input.rawBody, WRITE_SCOPE);
      const key = header(input.headers, "idempotency-key");
      if (!key || key.length > 200) return { status: 400, body: { error: "A valid Idempotency-Key is required" } };
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(input.rawBody.toString("utf8")) as Record<string, unknown>; }
      catch { return { status: 400, body: { error: "Invalid JSON body" } }; }
      if (payload.is_sandbox === true) return { status: 403, body: { error: "Sandbox handoff is disabled" } };
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      const sourceUrl = typeof payload.source_url === "string" ? payload.source_url : "";
      const correlationId = typeof payload.correlation_id === "string" ? payload.correlation_id : "";
      const approvalId = typeof payload.approval_id === "string" ? payload.approval_id : "";
      if (!name || (!phone && !email) || !/^https:\/\//i.test(sourceUrl) || !correlationId || !approvalId) {
        return { status: 422, body: { error: "name, phone or email, HTTPS source_url, correlation_id and approval_id are required" } };
      }
      const requestHash = createHash("sha256").update(input.rawBody).digest("hex");
      const response = await inTenant(auth.externalTenantId, async client => {
        await client.query("INSERT INTO rungrow_external_tenants (external_tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [auth.externalTenantId]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [auth.externalTenantId + ":" + (phone || email)]);
        const claim = await client.query(
          "INSERT INTO rungrow_idempotency (external_tenant_id,endpoint,idempotency_key,request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
          [auth.externalTenantId, HANDOFF_PATH, key, requestHash]
        );
        if (!claim.rowCount) {
          const existing = await client.query(
            "SELECT request_hash,response FROM rungrow_idempotency WHERE external_tenant_id=$1 AND endpoint=$2 AND idempotency_key=$3",
            [auth.externalTenantId, HANDOFF_PATH, key]
          );
          if (existing.rows[0]?.request_hash !== requestHash) return { conflict: true as const };
          return { replay: true as const, response: existing.rows[0]?.response ?? { status: "PROCESSING" } };
        }
        const existingProspect = await client.query(
          "SELECT id FROM rungrow_prospects WHERE external_tenant_id=$1 AND (($2<>'' AND phone=$2) OR ($3<>'' AND email=$3)) ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [auth.externalTenantId, phone, email]
        );
        let prospectId: string;
        if (existingProspect.rows[0]) {
          prospectId = existingProspect.rows[0].id;
          await client.query(
            "UPDATE rungrow_prospects SET name=$2,phone=coalesce(nullif($3,''),phone),email=coalesce(nullif($4,''),email),status='QUALIFIED',source_url=$5,correlation_id=$6,approval_id=$7,updated_at=now() WHERE external_tenant_id=$1 AND id=$8",
            [auth.externalTenantId, name, phone, email, sourceUrl, correlationId, approvalId, prospectId]
          );
        } else {
          const inserted = await client.query(
            "INSERT INTO rungrow_prospects (external_tenant_id,name,phone,email,source_url,correlation_id,approval_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [auth.externalTenantId, name, phone || null, email || null, sourceUrl, correlationId, approvalId]
          );
          prospectId = inserted.rows[0].id;
        }
        const result = { status: "ACCEPTED", product_id: RUNGROW_PRODUCT_ID, api_version: "v1",
          prospect_id: prospectId, external_tenant_id: auth.externalTenantId, correlation_id: correlationId, approval_id: approvalId };
        await client.query(
          "UPDATE rungrow_idempotency SET response=$4,completed_at=now() WHERE external_tenant_id=$1 AND endpoint=$2 AND idempotency_key=$3",
          [auth.externalTenantId, HANDOFF_PATH, key, JSON.stringify(result)]
        );
        await client.query(
          "INSERT INTO rungrow_telemetry_outbox (external_tenant_id,event_type,payload,recognised_revenue_inr) VALUES ($1,'prospect.qualified',$2,0)",
          [auth.externalTenantId, JSON.stringify({ prospect_id: prospectId, correlation_id: correlationId, approval_id: approvalId })]
        );
        return { replay: false as const, response: result };
      });
      if ("conflict" in response && response.conflict) return { status: 409, body: { error: "Idempotency-Key payload mismatch" } };
      return { status: response.replay ? 200 : 202, body: { ...response.response, ...(response.replay ? { replayed: true } : {}) } };
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (error) {
    const status = Number((error as { status?: number }).status) || 503;
    return { status, body: { error: error instanceof Error ? error.message : "Workforce adapter unavailable" } };
  }
}

export async function dispatchPendingTelemetry(batchSize = 25): Promise<{ delivered: number; failed: number }> {
  const endpoint = process.env.RUNGROW_WEBHOOK_URL;
  const secret = process.env.RUNGROW_WORKFORCE_HMAC_SECRET;
  const workforceTenantId = process.env.RUNGROW_WORKFORCE_TENANT_ID;
  if (!endpoint || !secret || !workforceTenantId) throw Object.assign(new Error("RunGrow telemetry is not configured"), { status: 503 });
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.pathname !== "/v1/adapters/" + RUNGROW_PRODUCT_ID + "/webhooks") {
    throw Object.assign(new Error("RUNGROW_WEBHOOK_URL must be the exact HTTPS RunGrow product webhook endpoint"), { status: 503 });
  }
  const tenants = await database().query("SELECT external_tenant_id FROM rungrow_external_tenants ORDER BY created_at LIMIT 1000");
  let delivered = 0, failed = 0;
  for (const item of tenants.rows as Array<{ external_tenant_id: string }>) {
    const tenantId = item.external_tenant_id;
    const pending = await inTenant(tenantId, client => client.query(
      "SELECT id,event_type,payload,recognised_revenue_inr::text FROM rungrow_telemetry_outbox WHERE external_tenant_id=$1 AND state='pending' AND next_attempt_at<=now() ORDER BY created_at LIMIT $2",
      [tenantId, Math.max(1, Math.min(100, batchSize))]
    ));
    for (const event of pending.rows as Array<{id:string;event_type:string;payload:Record<string,unknown>;recognised_revenue_inr:string}>) {
      const body = JSON.stringify({ product_id:RUNGROW_PRODUCT_ID, tenant_id:tenantId,
        event:{ event_id:event.id,event_type:event.event_type,
          recognised_revenue_inr:["invoice.recognised","invoice.recognized"].includes(event.event_type)?Number(event.recognised_revenue_inr):0,
          metadata:event.payload } });
      const timestamp = String(Math.floor(Date.now()/1000));
      const scopes = [WRITE_SCOPE];
      const signature = signWorkforceRequest(body,timestamp,workforceTenantId,tenantId,scopes,secret);
      try {
        const result = await fetch(url,{method:"POST",headers:{
          "Content-Type":"application/json","X-RunGrow-Signature":signature,"X-RunGrow-Timestamp":timestamp,
          "X-RunGrow-Product-Id":RUNGROW_PRODUCT_ID,"X-RunGrow-Tenant-Id":workforceTenantId,
          "X-RunGrow-External-Tenant-Id":tenantId,"X-RunGrow-Scopes":scopes.join(","),
          "Idempotency-Key":RUNGROW_PRODUCT_ID+":"+tenantId+":"+event.id,
          "X-Correlation-ID":String(event.payload.correlation_id??event.id),
        },body,signal:AbortSignal.timeout(10000)});
        if (!result.ok) throw new Error("RunGrow webhook returned HTTP "+result.status);
        await inTenant(tenantId,client=>client.query(
          "UPDATE rungrow_telemetry_outbox SET state='delivered',delivered_at=now(),last_error=NULL WHERE external_tenant_id=$1 AND id=$2",
          [tenantId,event.id]));
        delivered++;
      } catch(error) {
        await inTenant(tenantId,client=>client.query(
          "UPDATE rungrow_telemetry_outbox SET attempts=attempts+1,state=CASE WHEN attempts+1>=12 THEN 'dead' ELSE 'pending' END,next_attempt_at=now()+LEAST(power(2,LEAST(attempts+1,10))::int,3600)*interval '1 second',last_error=$3 WHERE external_tenant_id=$1 AND id=$2",
          [tenantId,event.id,error instanceof Error?error.message.slice(0,500):"Delivery failed"]));
        failed++;
      }
    }
  }
  return { delivered, failed };
}

export async function closeWorkforcePool(): Promise<void> {
  if (pool) { const current = pool; pool = undefined; await current.end(); }
}
