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

type InventoryStatus = "AVAILABLE" | "HELD" | "BOOKED" | "BLOCKED";

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
const sarvamModel = process.env.SARVAM_CHAT_MODEL ?? "sarvam-105b";
const tenantId = process.env.TEST_TENANT_ID ?? "demo-dental-hospital";
const port = Number(process.env.PORT ?? 3100);
const config = JSON.parse(required("TENANT_CONFIG_JSON")) as ClientConfig;
if (config.tenantId !== tenantId) throw new Error("TENANT_CONFIG_JSON tenantId mismatch");

const leads = new InMemoryLeadRepository();
const configs = new InMemoryClientConfigRepository([config]);
const demoSlots: Slot[] = [];
const inventory = new Map<string, InventoryStatus>();
const now = new Date();

const isConvenienceWindow = (hour: number, minute: number) =>
  hour < 10 || (hour === 12 && minute >= 30) || hour === 13 || hour >= 17;

for (let day = 1; day <= 42; day++) {
  const date = new Date(now);
  date.setDate(date.getDate() + day);
  if (date.getDay() === 0) continue;
  let index = 0;
  for (let hour = 9; hour < 20; hour++) {
    for (const minute of [0, 30]) {
      const start = new Date(date);
      start.setHours(hour, minute, 0, 0);
      const id = `slot-${day}-${hour}-${minute}`;
      const protectedWindow = isConvenienceWindow(hour, minute);
      const seed = (day * 17 + hour * 7 + minute + index * 3) % 100;
      let status: InventoryStatus;
      if (hour === 14 && minute === 0) status = "BLOCKED";
      else if (protectedWindow) status = seed < 88 ? "AVAILABLE" : "HELD";
      else if (seed < 66) status = "AVAILABLE";
      else if (seed < 84) status = "BOOKED";
      else status = "HELD";
      const slot: Slot = {
        id,
        tenantId,
        providerId: index % 4 === 0 ? "demo-dentist-b" : "demo-dentist-a",
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
        mode: "OFFLINE",
        available: status === "AVAILABLE",
      };
      demoSlots.push(slot);
      inventory.set(id, status);
      index += 1;
    }
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

const effectiveStatus = (slot: Slot): InventoryStatus => {
  const appointment = Array.from(slots.appointments.values()).find((item) => item.slotId === slot.id);
  if (appointment?.status === "CONFIRMED") return "BOOKED";
  if (appointment?.status === "HELD") return "HELD";
  return inventory.get(slot.id) ?? (slot.available ? "AVAILABLE" : "BOOKED");
};

const publicSlot = (slot: Slot) => ({
  id: slot.id,
  startsAt: slot.startsAt,
  endsAt: slot.endsAt,
  providerId: slot.providerId,
  mode: slot.mode,
  status: effectiveStatus(slot),
});

const nearestAvailable = (target: Slot, limit = 4) => demoSlots
  .filter((slot) => slot.id !== target.id && effectiveStatus(slot) === "AVAILABLE" && new Date(slot.startsAt) > new Date())
  .sort((a, b) => Math.abs(new Date(a.startsAt).getTime() - new Date(target.startsAt).getTime()) - Math.abs(new Date(b.startsAt).getTime() - new Date(target.startsAt).getTime()))
  .slice(0, limit)
  .map(publicSlot);

let activityTick = 0;
setInterval(() => {
  activityTick += 1;
  const candidates = demoSlots.filter((slot) => {
    if (Array.from(slots.appointments.values()).some((appointment) => appointment.slotId === slot.id)) return false;
    const d = new Date(slot.startsAt);
    const hour = d.getHours();
    const minute = d.getMinutes();
    return d > new Date() && !isConvenienceWindow(hour, minute) && !(hour === 14 && minute === 0);
  });
  if (!candidates.length) return;
  const slot = candidates[activityTick % candidates.length];
  const current = inventory.get(slot.id);
  if (current === "AVAILABLE" && activityTick % 3 !== 0) {
    inventory.set(slot.id, "HELD");
    slot.available = false;
  } else if (current === "HELD") {
    inventory.set(slot.id, activityTick % 5 === 0 ? "BOOKED" : "AVAILABLE");
    slot.available = inventory.get(slot.id) === "AVAILABLE";
  } else if (current === "BOOKED" && activityTick % 7 === 0) {
    inventory.set(slot.id, "AVAILABLE");
    slot.available = true;
  }
}, 4000);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(htmlPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, mode: "live-inventory-calendar-demo", tenantId, agent: "sarvam", model: sarvamModel });
    }

    if (req.method === "GET" && url.pathname === "/api/web/calendar") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const fromTime = from ? new Date(from).getTime() : Date.now();
      const toTime = to ? new Date(to).getTime() : Date.now() + 42 * 24 * 60 * 60_000;
      const items = demoSlots
        .filter((slot) => {
          const time = new Date(slot.startsAt).getTime();
          return time >= fromTime && time <= toTime;
        })
        .map(publicSlot);
      const available = items.filter((item) => item.status === "AVAILABLE").length;
      return sendJson(res, 200, {
        demoMode: true,
        demoLabel: "Demo live activity",
        activeBookingCount: 4 + (activityTick % 9),
        refreshedAt: new Date().toISOString(),
        totals: { slots: items.length, available, unavailable: items.length - available },
        slots: items,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/web/session") {
      const body = JSON.parse(await readBody(req)) as {
        firstName?: string;
        lastName?: string;
        age?: string | number;
        gender?: string;
      };
      const firstName = body.firstName?.trim();
      const lastName = body.lastName?.trim();
      const gender = body.gender?.trim();
      const age = Number(body.age);
      if (!firstName || !lastName || !gender || !Number.isFinite(age) || age <= 0 || age > 120) {
        return sendJson(res, 400, { error: "first name, last name, valid age and gender are required" });
      }

      const lead = await orchestrator.ingestLead({
        tenantId,
        name: `${firstName} ${lastName}`,
        phone: "captured-by-channel",
        source: "web-booking",
        serviceInterest: "dental consultation",
      });
      await orchestrator.markContactEligible(tenantId, lead.id);
      await orchestrator.startContact(tenantId, lead.id);
      await orchestrator.recordQualification(tenantId, lead.id, {
        firstName,
        lastName,
        age: String(age),
        gender,
        intent: "appointment-booking",
      });
      return sendJson(res, 201, {
        leadId: lead.id,
        message: `Thanks ${firstName}. Choose a convenient appointment slot.`,
        lead: await publicLead(lead.id),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/web/slot") {
      const body = JSON.parse(await readBody(req)) as { leadId?: string; slotId?: string };
      const leadId = body.leadId?.trim();
      const slotId = body.slotId?.trim();
      if (!leadId || !slotId) return sendJson(res, 400, { error: "leadId and slotId are required" });
      const lead = await leads.get(tenantId, leadId);
      if (!lead) return sendJson(res, 404, { error: "session not found" });
      const selected = await slots.get(tenantId, slotId);
      if (!selected) return sendJson(res, 404, { error: "slot not found" });
      if (effectiveStatus(selected) !== "AVAILABLE") {
        return sendJson(res, 409, {
          error: "That slot is currently unavailable.",
          recovery: {
            waitlistAvailable: true,
            alternatives: nearestAvailable(selected),
          },
        });
      }

      await orchestrator.selectSlot(tenantId, leadId, slotId);
      inventory.set(slotId, "HELD");
      const payment = await orchestrator.requestPayment(tenantId, leadId);
      return sendJson(res, 200, {
        message: "Slot held. Complete the booking payment to confirm your appointment.",
        selectedSlot: publicSlot(selected),
        paymentReady: Boolean(payment.paymentUrl),
        paymentReference: payment.lead.paymentReference,
        bookingFeeMinor: config.bookingFeeMinor,
        currency: config.currency,
        lead: await publicLead(leadId),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/web/recovery") {
      const slotId = url.searchParams.get("slotId") ?? "";
      const target = await slots.get(tenantId, slotId);
      if (!target) return sendJson(res, 404, { error: "slot not found" });
      return sendJson(res, 200, {
        target: publicSlot(target),
        waitlistAvailable: true,
        alternatives: nearestAvailable(target),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/web/chat") {
      const body = JSON.parse(await readBody(req)) as { leadId?: string; message?: string };
      const leadId = body.leadId?.trim();
      const message = body.message?.trim();
      if (!leadId || !message) return sendJson(res, 400, { error: "leadId and message are required" });
      if (!(await leads.get(tenantId, leadId))) return sendJson(res, 404, { error: "session not found" });
      const result = await agent.handleTurn(tenantId, leadId, message);
      return sendJson(res, 200, { message: result.spokenText, handoff: Boolean(result.handoff), lead: await publicLead(leadId) });
    }

    if (req.method === "POST" && url.pathname === "/api/web/payment/confirm") {
      const body = JSON.parse(await readBody(req)) as { leadId?: string; paymentReference?: string };
      const leadId = body.leadId?.trim();
      const paymentReference = body.paymentReference?.trim();
      if (!leadId || !paymentReference) return sendJson(res, 400, { error: "leadId and paymentReference are required" });
      await orchestrator.confirmPayment(tenantId, leadId, paymentReference);
      const confirmed = await orchestrator.confirmAppointment(tenantId, leadId);
      const lead = await leads.get(tenantId, leadId);
      if (lead?.slotId) inventory.set(lead.slotId, "BOOKED");
      return sendJson(res, 200, {
        ok: true,
        message: "Payment received. Your appointment is confirmed.",
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
