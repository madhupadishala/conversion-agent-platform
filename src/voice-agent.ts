import type { ClientConfig, Lead, Slot } from "./domain.js";
import type { ConversionOrchestrator } from "./conversion-orchestrator.js";

type AgentAction =
  | { action: "reply"; message: string }
  | { action: "qualify"; message: string; qualification: Record<string, string> }
  | { action: "list_slots"; message: string }
  | { action: "select_slot"; message: string; slotId: string }
  | { action: "handoff"; message: string; reason: string };

export interface AgentTurnResult {
  spokenText: string;
  paymentUrl?: string;
  handoff?: boolean;
}

export class GovernedVoiceAgent {
  constructor(
    private readonly orchestrator: ConversionOrchestrator,
    private readonly getLead: (tenantId: string, leadId: string) => Promise<Lead | undefined>,
    private readonly getConfig: (tenantId: string) => Promise<ClientConfig | undefined>,
    private readonly apiKey: string,
    private readonly model = "sarvam-105b",
  ) {}

  async handleTurn(tenantId: string, leadId: string, userText: string): Promise<AgentTurnResult> {
    const lead = await this.getLead(tenantId, leadId);
    const config = await this.getConfig(tenantId);
    if (!lead || !config) throw new Error("Voice session context not found");

    if (config.escalationKeywords.some((word) => userText.toLowerCase().includes(word.toLowerCase()))) {
      await this.orchestrator.handoff(tenantId, leadId, `Escalation keyword detected: ${userText.slice(0, 120)}`);
      return { spokenText: "I’ll connect this to a member of the team for you.", handoff: true };
    }

    let slots: Slot[] = [];
    if (lead.status === "QUALIFIED") {
      try { slots = await this.orchestrator.availableSlots(tenantId, leadId); } catch { /* ignore */ }
    }

    const decision = await this.askModel(config, lead, userText, slots);

    switch (decision.action) {
      case "handoff":
        await this.orchestrator.handoff(tenantId, leadId, decision.reason);
        return { spokenText: decision.message, handoff: true };
      case "qualify":
        if (lead.status === "CONTACTING") {
          await this.orchestrator.recordQualification(tenantId, leadId, decision.qualification);
          return { spokenText: decision.message };
        }
        return { spokenText: "I already have your booking details. I can show you available slots or answer an approved question." };
      case "list_slots": {
        const currentLead = await this.getLead(tenantId, leadId);
        if (currentLead?.status === "CONTACTING") {
          await this.orchestrator.recordQualification(tenantId, leadId, { intent: currentLead.serviceInterest ?? "consultation" });
        }
        const available = await this.orchestrator.availableSlots(tenantId, leadId);
        if (!available.length) return { spokenText: "I’m not seeing an available slot right now. I’ll ask the team to contact you." };
        const top = available.slice(0, 3).map((slot, index) => `${index + 1}: ${new Date(slot.startsAt).toLocaleString("en-IN", { timeZone: config.timezone })}`).join("; ");
        return { spokenText: `${decision.message} ${top}. Which one would you prefer?` };
      }
      case "select_slot": {
        if (lead.status !== "QUALIFIED") return { spokenText: "I need to finish the booking details before selecting a slot." };
        const selected = slots.find((slot) => slot.id === decision.slotId);
        if (!selected) return { spokenText: "That slot is no longer available. Let me check the latest availability again." };
        await this.orchestrator.selectSlot(tenantId, leadId, selected.id);
        const payment = await this.orchestrator.requestPayment(tenantId, leadId);
        if (payment.paymentUrl) return { spokenText: `${decision.message} I’ve reserved that slot temporarily and sent the payment step to complete the booking.`, paymentUrl: payment.paymentUrl };
        await this.orchestrator.confirmAppointment(tenantId, leadId);
        return { spokenText: `${decision.message} Your appointment is confirmed.` };
      }
      default:
        return { spokenText: decision.message };
    }
  }

  private async askModel(config: ClientConfig, lead: Lead, userText: string, slots: Slot[]): Promise<AgentAction> {
    const approved = config.approvedKnowledge.filter((item) => item.status === "APPROVED");
    const knownCustomer = {
      name: lead.name,
      phone: lead.phone,
      serviceInterest: lead.serviceInterest,
      qualification: lead.qualification,
    };
    const stateRules = lead.status === "CONTACTING"
      ? "You may choose qualify once if needed. Do not ask for name, phone, or service interest when they are already present in KNOWN CUSTOMER DATA."
      : lead.status === "QUALIFIED"
        ? "The lead is already qualified. NEVER choose qualify and NEVER ask again for name, full name, phone number, or information already present. Prefer list_slots when the customer wants to book, or select_slot when they choose one of the supplied slots."
        : "Do not restart qualification or ask again for known identity details. Continue only from the current workflow state.";
    const instructions = `You are the AI front desk for ${config.name}. You may ONLY state facts supported by APPROVED KNOWLEDGE below or explicit runtime data. Never diagnose, recommend treatment, invent pricing, promise outcomes, or answer clinical questions. For clinical/medical, complaint, legal, refund dispute, uncertainty, or human-request questions choose handoff. Your goal is to move the enquiry to booking with the fewest reasonable turns. Reuse all known customer data; never ask the customer to repeat information already present. ${stateRules} Return ONLY valid JSON matching one action: {"action":"reply","message":"..."}, {"action":"qualify","message":"...","qualification":{"key":"value"}}, {"action":"list_slots","message":"..."}, {"action":"select_slot","message":"...","slotId":"exact-slot-id"}, or {"action":"handoff","message":"...","reason":"..."}. KNOWN CUSTOMER DATA: ${JSON.stringify(knownCustomer)}. APPROVED KNOWLEDGE: ${JSON.stringify(approved.map(({ question, answer }) => ({ question, answer })))}. Current lead state: ${lead.status}. Available slots: ${JSON.stringify(slots.map((slot) => ({ id: slot.id, startsAt: slot.startsAt, mode: slot.mode })))}.`;

    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { "api-subscription-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        reasoning_effort: null,
        temperature: 0.1,
        max_tokens: 350,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: userText },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Sarvam response failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("Sarvam returned no text output");
    const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as AgentAction;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { action?: unknown }).action !== "string" || typeof (parsed as { message?: unknown }).message !== "string") throw new Error("Invalid agent action");
    return parsed;
  }
}
