import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
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

const publicBaseUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");
const websocketBaseUrl = publicBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const sarvamApiKey = required("SARVAM_API_KEY");
const sarvamModel = process.env.SARVAM_CHAT_MODEL ?? "sarvam-30b";
const tenantId = process.env.TEST_TENANT_ID ?? "demo-dental-hospital";
const port = Number(process.env.PORT ?? 3000);
const config = JSON.parse(required("TENANT_CONFIG_JSON")) as ClientConfig;
if (config.tenantId !== tenantId) throw new Error("TENANT_CONFIG_JSON tenantId mismatch");

const leads = new InMemoryLeadRepository();
const configs = new InMemoryClientConfigRepository([config]);
const now = new Date();
const demoSlots: Slot[] = Array.from({ length: 3 }, (_, index) => {
  const start = new Date(now.getTime() + (index + 1) * 86_400_000);
  start.setHours(10 + index, 0, 0, 0);
  return {
    id: `validation-slot-${index + 1}`,
    tenantId,
    providerId: "validation",
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    mode: "OFFLINE" as const,
    available: true,
  };
});
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
const agent = new GovernedVoiceAgent(orchestrator, (t, l) => leads.get(t, l), (t) => configs.get(t), sarvamApiKey, sarvamModel);

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const xmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const relayTwiml = (leadId: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay url="${xmlEscape(websocketBaseUrl)}/voice/ws" welcomeGreeting="Hi, welcome to the Demo Dental Hospital AI front desk. How can I help you today?" welcomeGreetingInterruptible="any"><Parameter name="tenantId" value="${xmlEscape(tenantId)}"/><Parameter name="leadId" value="${xmlEscape(leadId)}"/></ConversationRelay></Connect></Response>`;

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? "/", publicBaseUrl);
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, mode: "twilio-inbound-trial", agent: "sarvam" }));
    }
    if ((req.method === "POST" || req.method === "GET") && url.pathname === "/voice/inbound") {
      const body = req.method === "POST" ? new URLSearchParams(await readBody(req)) : url.searchParams;
      const caller = body.get("From") ?? "verified-caller";
      const lead = await orchestrator.ingestLead({ tenantId, name: "Inbound Validation Caller", phone: caller, source: "twilio-inbound-validation", serviceInterest: "dental consultation" });
      await orchestrator.markContactEligible(tenantId, lead.id);
      await orchestrator.startContact(tenantId, lead.id);
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(relayTwiml(lead.id));
    }
    res.writeHead(404);
    res.end("not found");
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(error instanceof Error ? error.message : "internal error");
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", publicBaseUrl);
  if (url.pathname !== "/voice/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

interface RelayMessage {
  type: string;
  customParameters?: { tenantId?: string; leadId?: string };
  voicePrompt?: string;
  last?: boolean;
}

wss.on("connection", (ws: WebSocket) => {
  let sessionTenantId = "";
  let sessionLeadId = "";
  ws.on("message", async (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as RelayMessage;
      if (message.type === "setup") {
        sessionTenantId = message.customParameters?.tenantId ?? "";
        sessionLeadId = message.customParameters?.leadId ?? "";
        return;
      }
      if (message.type === "prompt" && message.last && message.voicePrompt && sessionTenantId && sessionLeadId) {
        const result = await agent.handleTurn(sessionTenantId, sessionLeadId, message.voicePrompt);
        ws.send(JSON.stringify({ type: "text", token: result.spokenText, last: true, interruptible: true, preemptible: true }));
        if (result.handoff) ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reasonCode: "human-handoff", leadId: sessionLeadId }) }));
      }
    } catch (error) {
      console.error("inbound validation websocket error", error);
      ws.send(JSON.stringify({ type: "text", token: "I’m sorry, I need to hand this conversation to the team.", last: true }));
      ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reasonCode: "agent-error", leadId: sessionLeadId }) }));
    }
  });
});

server.listen(port, () => console.log(`inbound validation server listening on :${port} (${randomUUID().slice(0, 8)})`));
