import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientConfig } from "./domain.js";
import { ConversionOrchestrator } from "./conversion-orchestrator.js";
import { RuntimeStore } from "./runtime-store.js";
import { GovernedVoiceAgent } from "./voice-agent.js";
import {
  GoogleCalendarSlotProvider,
  RazorpayPaymentProvider,
  TwilioSmsReminderScheduler,
  TwilioSmsSender,
  TwilioVoiceProvider,
} from "./live-providers.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const optionalNumber = (name: string, fallback: number): number => {
  const value = process.env[name];
  return value ? Number(value) : fallback;
};

const publicBaseUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");
const websocketBaseUrl = publicBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const twilioAccountSid = required("TWILIO_ACCOUNT_SID");
const twilioAuthToken = required("TWILIO_AUTH_TOKEN");
const twilioFromNumber = required("TWILIO_FROM_NUMBER");
const razorpayKeyId = required("RAZORPAY_KEY_ID");
const razorpayKeySecret = required("RAZORPAY_KEY_SECRET");
const sarvamApiKey = required("SARVAM_API_KEY");
const sarvamModel = process.env.SARVAM_CHAT_MODEL ?? "sarvam-30b";
const tenantId = required("TEST_TENANT_ID");
const googleCalendarId = required("GOOGLE_CALENDAR_ID");
const googleCalendarAccessToken = required("GOOGLE_CALENDAR_ACCESS_TOKEN");
const adminKey = required("ADMIN_API_KEY");
const staffNotifyPhone = process.env.STAFF_NOTIFY_PHONE;
const validateTwilioSignature = (process.env.TWILIO_VALIDATE_SIGNATURE ?? "true").toLowerCase() !== "false";

const store = new RuntimeStore();
const initialConfig: ClientConfig = process.env.TENANT_CONFIG_JSON
  ? JSON.parse(process.env.TENANT_CONFIG_JSON) as ClientConfig
  : {
      tenantId,
      name: "Demo Dental Hospital",
      timezone: "Asia/Kolkata",
      contactWithinSeconds: 180,
      paymentRequired: true,
      bookingFeeMinor: 10000,
      currency: "INR",
      reminderOffsetsMinutes: [1440, 180, 30],
      escalationKeywords: ["doctor", "dentist", "human", "complaint", "refund", "emergency", "diagnosis", "medicine", "prescription", "severe pain", "bleeding", "swelling"],
      approvedKnowledge: [],
    };
if (initialConfig.tenantId !== tenantId) throw new Error("TENANT_CONFIG_JSON tenantId must match TEST_TENANT_ID");
store.setConfig(initialConfig);

const calendar = new GoogleCalendarSlotProvider({
  accessToken: googleCalendarAccessToken,
  calendarId: googleCalendarId,
  tenantId,
  timezone: initialConfig.timezone,
  appointmentMinutes: optionalNumber("APPOINTMENT_MINUTES", 30),
  dayStartHour: optionalNumber("BUSINESS_DAY_START_HOUR", 9),
  dayEndHour: optionalNumber("BUSINESS_DAY_END_HOUR", 18),
  horizonDays: optionalNumber("CALENDAR_HORIZON_DAYS", 7),
});
const sms = new TwilioSmsSender(twilioAccountSid, twilioAuthToken, twilioFromNumber);
const reminders = new TwilioSmsReminderScheduler(sms, (t, l) => store.getLead(t, l));
const razorpay = new RazorpayPaymentProvider(razorpayKeyId, razorpayKeySecret, publicBaseUrl);
const twilio = new TwilioVoiceProvider(twilioAccountSid, twilioAuthToken, twilioFromNumber, publicBaseUrl);
let idCounter = 0;
const orchestrator = new ConversionOrchestrator(
  store.leadRepository(),
  store.configRepository(),
  calendar,
  razorpay,
  reminders,
  store.auditLog(),
  { next: (prefix) => `${prefix}_${++idCounter}_${randomUUID().slice(0, 8)}` },
  { now: () => new Date() },
);
const agent = new GovernedVoiceAgent(orchestrator, (t, l) => store.getLead(t, l), (t) => store.getConfig(t), sarvamApiKey, sarvamModel);

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const isAdmin = (req: IncomingMessage) => req.headers["x-admin-key"] === adminKey;

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", publicBaseUrl);

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(res, 200, { ok: true, version: "0.3.0-validation", tenantId, telephony: "twilio", agent: "sarvam" });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/leads") {
      const body = JSON.parse(await readBody(req)) as { tenantId?: string; name?: string; phone?: string; source?: string; serviceInterest?: string };
      if (!body.tenantId || !body.name || !body.phone) return sendJson(res, 400, { error: "tenantId, name and phone are required" });
      if (body.tenantId !== tenantId) return sendJson(res, 404, { error: "tenant not configured on this test deployment" });
      const lead = await orchestrator.ingestLead({ tenantId: body.tenantId, name: body.name, phone: body.phone, source: body.source ?? "website", serviceInterest: body.serviceInterest });
      await orchestrator.markContactEligible(body.tenantId, lead.id);
      await orchestrator.startContact(body.tenantId, lead.id);
      const callSid = await twilio.callLead({ tenantId: body.tenantId, leadId: lead.id, phone: body.phone });
      return sendJson(res, 202, { leadId: lead.id, callSid, status: "CONTACTING" });
    }

    if ((req.method === "GET" || req.method === "POST") && requestUrl.pathname === "/voice/twiml") {
      const t = requestUrl.searchParams.get("tenantId") ?? "";
      const leadId = requestUrl.searchParams.get("leadId") ?? "";
      const config = await store.getConfig(t);
      if (!config || !leadId) { res.writeHead(404); return res.end(); }
      const xml = twilio.conversationRelayTwiml({ tenantId: t, leadId, websocketBaseUrl, greeting: `Hi, this is the AI front desk for ${config.name}, calling about your recent enquiry. Is now a good time for a quick conversation?` });
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(xml);
    }

    if (requestUrl.pathname === "/voice/status") {
      res.writeHead(204); return res.end();
    }

    if (req.method === "GET" && requestUrl.pathname === "/payments/razorpay/callback") {
      const t = requestUrl.searchParams.get("tenantId") ?? "";
      const leadId = requestUrl.searchParams.get("leadId") ?? "";
      if (!razorpay.verifyCallback(requestUrl.searchParams)) return sendJson(res, 400, { error: "invalid payment signature/status" });
      const linkId = requestUrl.searchParams.get("razorpay_payment_link_id") ?? "";
      await orchestrator.confirmPayment(t, leadId, linkId);
      await orchestrator.confirmAppointment(t, leadId);
      const lead = await store.getLead(t, leadId);
      if (lead) await sms.send(lead.phone, "Payment received. Your appointment is confirmed. You will receive scheduled reminders before the appointment.");
      if (staffNotifyPhone && lead) await sms.send(staffNotifyPhone, `New confirmed appointment: ${lead.name} (${lead.phone}), lead ${lead.id}.`);
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<h2>Payment received. Your appointment is confirmed.</h2>");
    }

    if (req.method === "POST" && requestUrl.pathname === "/admin/config") {
      if (!isAdmin(req)) return sendJson(res, 401, { error: "unauthorized" });
      const config = JSON.parse(await readBody(req)) as ClientConfig;
      if (config.tenantId !== tenantId) return sendJson(res, 400, { error: "tenantId must match TEST_TENANT_ID" });
      store.setConfig(config);
      return sendJson(res, 200, { ok: true, tenantId: config.tenantId, approvedKnowledge: config.approvedKnowledge.filter((item) => item.status === "APPROVED").length });
    }

    if (req.method === "GET" && requestUrl.pathname === "/admin/snapshot") {
      if (!isAdmin(req)) return sendJson(res, 401, { error: "unauthorized" });
      return sendJson(res, 200, store.snapshot(tenantId));
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
  }
});

const wss = new WebSocketServer({ noServer: true });

const validTwilioWebSocketSignature = (req: IncomingMessage): boolean => {
  if (!validateTwilioSignature) return true;
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  const requestUrl = `${websocketBaseUrl}${req.url ?? "/voice/ws"}`;
  const expected = createHmac("sha1", twilioAuthToken).update(requestUrl).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
};

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url ?? "/", publicBaseUrl);
  if (requestUrl.pathname !== "/voice/ws" || !validTwilioWebSocketSignature(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
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
  description?: string;
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
        if (result.paymentUrl) {
          const lead = await store.getLead(sessionTenantId, sessionLeadId);
          if (lead) await sms.send(lead.phone, `Complete your booking payment here: ${result.paymentUrl}`);
        }
        ws.send(JSON.stringify({ type: "text", token: result.spokenText, last: true, interruptible: true, preemptible: true }));
        if (result.handoff) ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reasonCode: "human-handoff", leadId: sessionLeadId }) }));
      }
    } catch (error) {
      console.error("voice websocket error", error);
      ws.send(JSON.stringify({ type: "text", token: "I’m sorry, I need to hand this conversation to the team.", last: true }));
      ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reasonCode: "agent-error", leadId: sessionLeadId }) }));
    }
  });
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`conversion-agent-platform listening on :${port}`));
