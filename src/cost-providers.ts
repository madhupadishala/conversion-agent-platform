import type { Lead } from "./domain.js";

const basicAuth = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const xmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export class PlivoVoiceProvider {
  constructor(
    private readonly authId: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly publicBaseUrl: string,
  ) {}

  async callLead(input: { tenantId: string; leadId: string; phone: string }): Promise<string> {
    const response = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(this.authId)}/Call/`, {
      method: "POST",
      headers: {
        Authorization: basicAuth(this.authId, this.authToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.fromNumber,
        to: input.phone,
        answer_url: `${this.publicBaseUrl}/plivo/answer?tenantId=${encodeURIComponent(input.tenantId)}&leadId=${encodeURIComponent(input.leadId)}`,
        answer_method: "GET",
        hangup_url: `${this.publicBaseUrl}/plivo/hangup?tenantId=${encodeURIComponent(input.tenantId)}&leadId=${encodeURIComponent(input.leadId)}`,
        hangup_method: "POST",
      }),
    });
    if (!response.ok) throw new Error(`Plivo call failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { request_uuid?: string; call_uuid?: string };
    const id = body.request_uuid ?? body.call_uuid;
    if (!id) throw new Error("Plivo did not return a call identifier");
    return id;
  }

  streamXml(input: { tenantId: string; leadId: string; websocketBaseUrl: string }): string {
    const ws = `${input.websocketBaseUrl}/plivo/media?tenantId=${encodeURIComponent(input.tenantId)}&leadId=${encodeURIComponent(input.leadId)}`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000" statusCallbackUrl="${xmlEscape(this.publicBaseUrl)}/plivo/stream-status">${xmlEscape(ws)}</Stream></Response>`;
  }
}

export class RazorpayNotifyingPaymentClient {
  constructor(private readonly keyId: string, private readonly keySecret: string, private readonly callbackBaseUrl: string) {}

  async createForLead(input: {
    tenantId: string;
    lead: Lead;
    amountMinor: number;
    currency: string;
    email?: string;
  }): Promise<{ reference: string; paymentUrl: string }> {
    const referenceId = `${input.tenantId.slice(0, 10)}_${input.lead.id.slice(-20)}`.slice(0, 40);
    const customer: Record<string, string> = { name: input.lead.name, contact: input.lead.phone };
    if (input.email) customer.email = input.email;

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
        customer,
        notify: { sms: true, email: Boolean(input.email) },
        reminder_enable: true,
        callback_url: `${this.callbackBaseUrl}/payments/razorpay/callback?tenantId=${encodeURIComponent(input.tenantId)}&leadId=${encodeURIComponent(input.lead.id)}`,
        callback_method: "get",
        notes: { tenantId: input.tenantId, leadId: input.lead.id },
      }),
    });
    if (!response.ok) throw new Error(`Razorpay payment-link creation failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { id?: string; short_url?: string };
    if (!body.id || !body.short_url) throw new Error("Razorpay response missing payment link id/url");
    return { reference: body.id, paymentUrl: body.short_url };
  }
}

export const estimatedVariableCostInr = (input: {
  callMinutes: number;
  callerSpeechMinutes?: number;
  assistantCharacters?: number;
}) => {
  const telephony = input.callMinutes * 0.60;
  const stt = (input.callerSpeechMinutes ?? input.callMinutes * 0.5) * 0.50;
  const tts = ((input.assistantCharacters ?? input.callMinutes * 700) / 10_000) * 30;
  return {
    telephony,
    stt,
    tts,
    subtotalBeforeLlm: telephony + stt + tts,
  };
};
