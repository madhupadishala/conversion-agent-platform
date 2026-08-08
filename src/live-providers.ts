import type { Appointment, Lead, Reminder, Slot } from "./domain.js";
import type { PaymentProvider, ReminderScheduler, SlotProvider } from "./ports.js";

const basicAuth = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

export class TwilioVoiceProvider {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly publicBaseUrl: string,
  ) {}

  async callLead(input: { tenantId: string; leadId: string; phone: string }): Promise<string> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls.json`;
    const form = new URLSearchParams({
      To: input.phone,
      From: this.fromNumber,
      Url: `${this.publicBaseUrl}/voice/twiml?tenantId=${encodeURIComponent(input.tenantId)}&leadId=${encodeURIComponent(input.leadId)}`,
      Method: "POST",
      StatusCallback: `${this.publicBaseUrl}/voice/status?tenantId=${encodeURIComponent(input.tenantId)}&leadId=${encodeURIComponent(input.leadId)}`,
      StatusCallbackMethod: "POST",
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(this.accountSid, this.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!response.ok) throw new Error(`Twilio call failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { sid?: string };
    if (!body.sid) throw new Error("Twilio did not return a call SID");
    return body.sid;
  }

  conversationRelayTwiml(input: { tenantId: string; leadId: string; websocketBaseUrl: string; greeting: string }): string {
    const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay url="${xml(input.websocketBaseUrl)}/voice/ws" welcomeGreeting="${xml(input.greeting)}" welcomeGreetingInterruptible="any"><Parameter name="tenantId" value="${xml(input.tenantId)}"/><Parameter name="leadId" value="${xml(input.leadId)}"/></ConversationRelay></Connect></Response>`;
  }
}

export class RazorpayPaymentProvider implements PaymentProvider {
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly callbackBaseUrl: string,
  ) {}

  async createPayment(input: { tenantId: string; leadId: string; amountMinor: number; currency: string }): Promise<{ reference: string; paymentUrl: string }> {
    const referenceId = `${input.tenantId.slice(0, 10)}_${input.leadId.slice(-20)}`.slice(0, 40);
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: basicAuth(this.keyId, this.keySecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency,
        reference_id: referenceId,
        description: "Appointment booking fee",
        callback_url: `${this.callbackBaseUrl}/payments/razorpay/callback?tenantId=${encodeURIComponent(input.tenantId)}&leadId=${encodeURIComponent(input.leadId)}`,
        callback_method: "get",
        reminder_enable: true,
        notes: { tenantId: input.tenantId, leadId: input.leadId },
      }),
    });
    if (!response.ok) throw new Error(`Razorpay payment-link creation failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { id?: string; short_url?: string };
    if (!body.id || !body.short_url) throw new Error("Razorpay response missing payment link id/url");
    return { reference: body.id, paymentUrl: body.short_url };
  }

  verifyCallback(params: URLSearchParams): boolean {
    const linkId = params.get("razorpay_payment_link_id") ?? "";
    const referenceId = params.get("razorpay_payment_link_reference_id") ?? "";
    const status = params.get("razorpay_payment_link_status") ?? "";
    const paymentId = params.get("razorpay_payment_id") ?? "";
    const signature = params.get("razorpay_signature") ?? "";
    if (!linkId || !referenceId || !status || !paymentId || !signature) return false;
    const payload = `${linkId}|${referenceId}|${status}|${paymentId}`;
    const expected = crypto.createHmac("sha256", this.keySecret).update(payload).digest("hex");
    return status === "paid" && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}

export interface GoogleCalendarOptions {
  accessToken: string;
  calendarId: string;
  tenantId: string;
  timezone: string;
  appointmentMinutes: number;
  dayStartHour: number;
  dayEndHour: number;
  horizonDays?: number;
}

export class GoogleCalendarSlotProvider implements SlotProvider {
  private readonly held = new Map<string, Appointment>();
  private readonly slotCache = new Map<string, Slot>();

  constructor(private readonly options: GoogleCalendarOptions) {}

  async listAvailable(tenantId: string): Promise<Slot[]> {
    if (tenantId !== this.options.tenantId) return [];
    const now = new Date();
    const horizon = new Date(now.getTime() + (this.options.horizonDays ?? 7) * 86_400_000);
    const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: now.toISOString(),
        timeMax: horizon.toISOString(),
        timeZone: this.options.timezone,
        items: [{ id: this.options.calendarId }],
      }),
    });
    if (!response.ok) throw new Error(`Google freeBusy failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> };
    const busy = body.calendars?.[this.options.calendarId]?.busy ?? [];
    const slots = this.generateSlots(now, horizon).filter((slot) => !busy.some((range) => new Date(slot.startsAt) < new Date(range.end) && new Date(slot.endsAt) > new Date(range.start)));
    for (const slot of slots) this.slotCache.set(slot.id, slot);
    return slots.slice(0, 20);
  }

  async get(tenantId: string, slotId: string): Promise<Slot | undefined> {
    const slot = this.slotCache.get(slotId);
    return slot?.tenantId === tenantId ? structuredClone(slot) : undefined;
  }

  async hold(tenantId: string, slotId: string, leadId: string): Promise<Appointment> {
    const slot = await this.get(tenantId, slotId);
    if (!slot) throw new Error("Calendar slot not found; refresh availability");
    if ([...this.held.values()].some((appointment) => appointment.slotId === slotId && appointment.status === "HELD")) throw new Error("Slot already held");
    const appointment: Appointment = { id: `appt_${crypto.randomUUID()}`, tenantId, leadId, slotId, status: "HELD", createdAt: new Date().toISOString() };
    this.held.set(appointment.id, appointment);
    return structuredClone(appointment);
  }

  async confirm(tenantId: string, appointmentId: string): Promise<Appointment> {
    const appointment = this.held.get(appointmentId);
    if (!appointment || appointment.tenantId !== tenantId) throw new Error("Appointment hold not found");
    const slot = await this.get(tenantId, appointment.slotId);
    if (!slot) throw new Error("Held slot missing");
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId)}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: `Booked consultation - ${appointment.leadId}`,
        description: `Conversion Agent appointment. Tenant: ${tenantId}. Lead: ${appointment.leadId}`,
        start: { dateTime: slot.startsAt, timeZone: this.options.timezone },
        end: { dateTime: slot.endsAt, timeZone: this.options.timezone },
      }),
    });
    if (!response.ok) throw new Error(`Google event creation failed: ${response.status} ${await response.text()}`);
    appointment.status = "CONFIRMED";
    return structuredClone(appointment);
  }

  private generateSlots(now: Date, horizon: Date): Slot[] {
    const result: Slot[] = [];
    const duration = this.options.appointmentMinutes * 60_000;
    for (let cursor = new Date(now); cursor < horizon; cursor = new Date(cursor.getTime() + 86_400_000)) {
      const year = cursor.getUTCFullYear();
      const month = cursor.getUTCMonth();
      const date = cursor.getUTCDate();
      for (let hour = this.options.dayStartHour; hour < this.options.dayEndHour; hour++) {
        for (let minute = 0; minute < 60; minute += this.options.appointmentMinutes) {
          const start = new Date(Date.UTC(year, month, date, hour, minute));
          const end = new Date(start.getTime() + duration);
          if (start <= now || end > horizon) continue;
          const id = `gcal_${start.getTime()}`;
          result.push({ id, tenantId: this.options.tenantId, providerId: this.options.calendarId, startsAt: start.toISOString(), endsAt: end.toISOString(), mode: "OFFLINE", available: true });
        }
      }
    }
    return result;
  }
}

export class TwilioSmsReminderScheduler implements ReminderScheduler {
  constructor(private readonly accountSid: string, private readonly authToken: string, private readonly fromNumber: string, private readonly leadLookup: (tenantId: string, leadId: string) => Promise<Lead | undefined>) {}

  async schedule(reminder: Reminder): Promise<void> {
    const delay = Math.max(0, new Date(reminder.sendAt).getTime() - Date.now());
    const timer = setTimeout(async () => {
      const lead = await this.leadLookup(reminder.tenantId, reminder.leadId);
      if (!lead) return;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`;
      const form = new URLSearchParams({ To: lead.phone, From: this.fromNumber, Body: "Reminder: your appointment is coming up. Reply to the business directly if you need to reschedule." });
      await fetch(url, { method: "POST", headers: { Authorization: basicAuth(this.accountSid, this.authToken), "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    }, delay);
    timer.unref();
  }
}
