import type { AuditEvent, Lead, Reminder, Slot } from "./domain.js";
import type {
  AuditLog,
  ClientConfigRepository,
  Clock,
  IdGenerator,
  LeadRepository,
  PaymentProvider,
  ReminderScheduler,
  SlotProvider,
} from "./ports.js";

export class ConversionOrchestrator {
  constructor(
    private readonly leads: LeadRepository,
    private readonly configs: ClientConfigRepository,
    private readonly slots: SlotProvider,
    private readonly payments: PaymentProvider,
    private readonly reminders: ReminderScheduler,
    private readonly audit: AuditLog,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async ingestLead(input: {
    tenantId: string;
    name: string;
    phone: string;
    source: string;
    serviceInterest?: string;
  }): Promise<Lead> {
    const config = await this.requireConfig(input.tenantId);
    const now = this.clock.now().toISOString();
    const lead: Lead = {
      id: this.ids.next("lead"),
      tenantId: input.tenantId,
      name: input.name,
      phone: input.phone,
      source: input.source,
      serviceInterest: input.serviceInterest,
      status: "RECEIVED",
      paymentStatus: config.paymentRequired ? "PENDING" : "NOT_REQUIRED",
      createdAt: now,
      updatedAt: now,
      qualification: {},
    };
    await this.leads.save(lead);
    await this.record(lead, "LEAD_RECEIVED", { source: input.source });
    return lead;
  }

  async markContactEligible(tenantId: string, leadId: string): Promise<Lead> {
    const lead = await this.requireLead(tenantId, leadId);
    this.assertStatus(lead, ["RECEIVED"]);
    return this.transition(lead, "CONTACT_ELIGIBLE", "CONTACT_ELIGIBLE");
  }

  async startContact(tenantId: string, leadId: string): Promise<Lead> {
    const lead = await this.requireLead(tenantId, leadId);
    this.assertStatus(lead, ["CONTACT_ELIGIBLE"]);
    return this.transition(lead, "CONTACTING", "CONTACT_STARTED");
  }

  async recordQualification(
    tenantId: string,
    leadId: string,
    qualification: Record<string, string>,
  ): Promise<Lead> {
    const lead = await this.requireLead(tenantId, leadId);
    this.assertStatus(lead, ["CONTACTING"]);
    lead.qualification = { ...lead.qualification, ...qualification };
    return this.transition(lead, "QUALIFIED", "LEAD_QUALIFIED");
  }

  async availableSlots(tenantId: string, leadId: string): Promise<Slot[]> {
    const lead = await this.requireLead(tenantId, leadId);
    this.assertStatus(lead, ["QUALIFIED"]);
    return this.slots.listAvailable(tenantId, lead.serviceInterest);
  }

  async selectSlot(tenantId: string, leadId: string, slotId: string): Promise<Lead> {
    const lead = await this.requireLead(tenantId, leadId);
    this.assertStatus(lead, ["QUALIFIED"]);
    const appointment = await this.slots.hold(tenantId, slotId, lead.id);
    lead.slotId = slotId;
    lead.appointmentId = appointment.id;
    return this.transition(lead, "SLOT_HELD", "SLOT_HELD", { slotId, appointmentId: appointment.id });
  }

  async requestPayment(tenantId: string, leadId: string): Promise<{ lead: Lead; paymentUrl?: string }> {
    const lead = await this.requireLead(tenantId, leadId);
    this.assertStatus(lead, ["SLOT_HELD"]);
    const config = await this.requireConfig(tenantId);

    if (!config.paymentRequired) {
      lead.paymentStatus = "NOT_REQUIRED";
      await this.leads.save(lead);
      await this.record(lead, "PAYMENT_NOT_REQUIRED");
      return { lead };
    }

    const payment = await this.payments.createPayment({
      tenantId,
      leadId,
      amountMinor: config.bookingFeeMinor,
      currency: config.currency,
    });
    lead.paymentReference = payment.reference;
    lead.paymentStatus = "PENDING";
    const updated = await this.transition(lead, "PAYMENT_PENDING", "PAYMENT_LINK_CREATED", {
      paymentReference: payment.reference,
    });
    return { lead: updated, paymentUrl: payment.paymentUrl };
  }

  async confirmPayment(tenantId: string, leadId: string, paymentReference: string): Promise<Lead> {
    const lead = await this.requireLead(tenantId, leadId);
    this.assertStatus(lead, ["PAYMENT_PENDING"]);
    if (!lead.paymentReference || lead.paymentReference !== paymentReference) {
      throw new Error("Payment reference mismatch");
    }
    lead.paymentStatus = "PAID";
    return this.transition(lead, "PAID", "PAYMENT_CONFIRMED", { paymentReference });
  }

  async confirmAppointment(tenantId: string, leadId: string): Promise<Lead> {
    const lead = await this.requireLead(tenantId, leadId);
    const config = await this.requireConfig(tenantId);
    const allowed: Lead["status"][] = config.paymentRequired ? ["PAID"] : ["SLOT_HELD"];
    this.assertStatus(lead, allowed);
    if (!lead.appointmentId || !lead.slotId) throw new Error("Appointment hold missing");

    const slot = await this.slots.get(tenantId, lead.slotId);
    if (!slot) throw new Error("Held slot not found");

    const appointment = await this.slots.confirm(tenantId, lead.appointmentId);
    const updated = await this.transition(lead, "CONFIRMED", "APPOINTMENT_CONFIRMED", {
      appointmentId: appointment.id,
    });
    await this.scheduleAppointmentReminders(config.reminderOffsetsMinutes, updated, slot.startsAt);
    return updated;
  }

  async handoff(tenantId: string, leadId: string, reason: string): Promise<Lead> {
    const lead = await this.requireLead(tenantId, leadId);
    if (["CONFIRMED", "CLOSED"].includes(lead.status)) throw new Error(`Cannot hand off lead in ${lead.status}`);
    lead.handoffReason = reason;
    return this.transition(lead, "HUMAN_HANDOFF", "HUMAN_HANDOFF_REQUIRED", { reason });
  }

  private async scheduleAppointmentReminders(offsets: number[], lead: Lead, startsAt: string): Promise<void> {
    const start = new Date(startsAt).getTime();
    for (const offset of offsets) {
      const sendAt = new Date(start - offset * 60_000);
      if (sendAt <= this.clock.now()) continue;
      const reminder: Reminder = {
        id: this.ids.next("reminder"),
        tenantId: lead.tenantId,
        leadId: lead.id,
        appointmentId: lead.appointmentId!,
        sendAt: sendAt.toISOString(),
        channel: "WHATSAPP",
        status: "SCHEDULED",
      };
      await this.reminders.schedule(reminder);
      await this.record(lead, "REMINDER_SCHEDULED", { offsetMinutes: offset, sendAt: reminder.sendAt });
    }
  }

  private async transition(
    lead: Lead,
    status: Lead["status"],
    eventType: string,
    metadata?: AuditEvent["metadata"],
  ): Promise<Lead> {
    lead.status = status;
    lead.updatedAt = this.clock.now().toISOString();
    await this.leads.save(lead);
    await this.record(lead, eventType, metadata);
    return lead;
  }

  private async record(lead: Lead, eventType: string, metadata?: AuditEvent["metadata"]): Promise<void> {
    await this.audit.append({
      id: this.ids.next("audit"),
      tenantId: lead.tenantId,
      leadId: lead.id,
      eventType,
      at: this.clock.now().toISOString(),
      metadata,
    });
  }

  private assertStatus(lead: Lead, allowed: Lead["status"][]): void {
    if (!allowed.includes(lead.status)) {
      throw new Error(`Invalid lead transition from ${lead.status}; expected ${allowed.join(" or ")}`);
    }
  }

  private async requireLead(tenantId: string, leadId: string): Promise<Lead> {
    const lead = await this.leads.get(tenantId, leadId);
    if (!lead) throw new Error("Lead not found");
    return lead;
  }

  private async requireConfig(tenantId: string) {
    const config = await this.configs.get(tenantId);
    if (!config) throw new Error("Client configuration not found");
    return config;
  }
}
