import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ClientConfig, Slot } from "./domain.js";
import { ConversionOrchestrator } from "./conversion-orchestrator.js";
import { GovernedVoiceAgent } from "./voice-agent.js";
import {
  InMemoryAuditLog,
  InMemoryClientConfigRepository,
  InMemoryLeadRepository,
  InMemoryPaymentProvider,
  InMemoryReminderScheduler,
  InMemorySlotProvider,
  IncrementingIdGenerator,
} from "./in-memory.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const sarvamApiKey = required("SARVAM_API_KEY");
const sarvamModel = process.env.SARVAM_CHAT_MODEL ?? "sarvam-30b";
const tenantId = process.env.TEST_TENANT_ID ?? "demo-dental-hospital";
const port = Number(process.env.PORT ?? 3100);
const config = JSON.parse(required("TENANT_CONFIG_JSON")) as ClientConfig;
if (config.tenantId !== tenantId) throw new Error("TENANT_CONFIG_JSON tenantId mismatch");

const leads = new InMemoryLeadRepository();
const configs = new InMemoryClientConfigRepository([config]);
const now = new Date();
const demoSlots: Slot[] = [];
for (let day = 1; day <= 3; day++) {
  for (const hour of [10, 12, 16]) {
    const start = new Date(now);
    start.setDate(start.getDate() + day);
    start.setHours(hour, 0, 0, 0);
    demoSlots.push({
      id: `slot-${day}-${hour}`,
      tenantId,
      providerId: "demo-dentist",
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
      mode: "OFFLINE",
      available: true,
    });
  }
}

const slots = new InMemorySlotProvider(demoSlots);
const payments = new InMemoryPaymentProvider();
const reminders = new InMemoryReminderScheduler();
const audit = new InMemoryAuditLog();
const ids = new IncrementingIdGenerator();
const orchestrator = new ConversionOrchestrator(
  leads,
  configs,
  slots,
  payments,
  reminders,
  audit,
  ids,
  { now: () => new Date() },
);
const agent = new GovernedVoiceAgent(
  orchestrator,
  (t, l) => leads.get(t, l),
  (t) => configs.get(t),
  sarvamApiKey,
  sarvamModel,
);

const currentDir = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(currentDir, "../../public/web-demo.html");

const publicLead = async (leadId: string) => {
  const lead = await leads.get(tenantId, leadId);
  if (!lead) return undefined;
  return {
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    serviceInterest: lead.serviceInterest,
    status: lead.status,
    paymentStatus: lead.paymentStatus,
    paymentReference: lead.paymentReference,
    slotId: lead.slotId,
    appointmentId: lead.appointmentId,
    handoffReason: lead.handoffReason,
    qualification: lead.qualification,
  };
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(htmlPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, mode: "web-conversion-demo", tenantId, agent: "sarvam" });
    }

    if (req.method === "POST" && url.pathname === "/api/web/session") {
      const body = JSON.parse(await readBody(req)) as { name?: string; phone?: string; serviceInterest?: string };
      const name = body.name?.trim();
      const phone = body.phone?.trim();
      if (!name || !phone) return sendJson(res, 400, { error: "name and phone are required" });
      const lead = await orchestrator.ingestLead({
        tenantId,
        name,
        phone,
        source: "web-demo",
        serviceInterest: body.serviceInterest?.trim() || "dental consultation",
      });
      await orchestrator.markContactEligible(tenantId, lead.id);
      await orchestrator.startContact(tenantId, lead.id);
      return sendJson(res, 201, {
        leadId: lead.id,
        greeting: `Hi ${name}, welcome to ${config.name}. I can answer approved questions and help you book a consultation. How can I help?`,
        lead: await publicLead(lead.id),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/web/chat") {
      const body = JSON.parse(await readBody(req)) as { leadId?: string; message?: string };
      const leadId = body.leadId?.trim();
      const message = body.message?.trim();
      if (!leadId || !message) return sendJson(res, 400, { error: "leadId and message are required" });
      if (!(await leads.get(tenantId, leadId))) return sendJson(res, 404, { error: "session not found" });

      const result = await agent.handleTurn(tenantId, leadId, message);
      const lead = await publicLead(leadId);
      return sendJson(res, 200, {
        message: result.spokenText,
        handoff: Boolean(result.handoff),
        paymentReady: Boolean(result.paymentUrl && lead?.paymentReference),
        paymentReference: lead?.paymentReference,
        bookingFeeMinor: config.bookingFeeMinor,
        currency: config.currency,
        lead,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/web/payment/confirm") {
      const body = JSON.parse(await readBody(req)) as { leadId?: string; paymentReference?: string };
      const leadId = body.leadId?.trim();
      const paymentReference = body.paymentReference?.trim();
      if (!leadId || !paymentReference) return sendJson(res, 400, { error: "leadId and paymentReference are required" });
      await orchestrator.confirmPayment(tenantId, leadId, paymentReference);
      const confirmed = await orchestrator.confirmAppointment(tenantId, leadId);
      return sendJson(res, 200, {
        ok: true,
        message: "Demo payment accepted. Your appointment is confirmed.",
        lead: await publicLead(leadId),
        appointmentId: confirmed.appointmentId,
        reminders: reminders.reminders.filter((item) => item.leadId === leadId),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/web/state") {
      const leadId = url.searchParams.get("leadId") ?? "";
      const lead = await publicLead(leadId);
      if (!lead) return sendJson(res, 404, { error: "session not found" });
      return sendJson(res, 200, {
        lead,
        audit: audit.events.filter((event) => event.leadId === leadId),
        reminders: reminders.reminders.filter((item) => item.leadId === leadId),
      });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`web conversion demo listening at http://127.0.0.1:${port}`);
});
