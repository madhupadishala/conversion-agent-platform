import type { Appointment, AuditEvent, ClientConfig, Lead, Reminder, Slot } from "./domain.js";
import type {
  AuditLog,
  ClientConfigRepository,
  LeadRepository,
  ReminderScheduler,
  SlotProvider,
} from "./ports.js";

export class RuntimeStore implements LeadRepository, ClientConfigRepository, SlotProvider, ReminderScheduler, AuditLog {
  private readonly leads = new Map<string, Lead>();
  private readonly configs = new Map<string, ClientConfig>();
  private readonly slots = new Map<string, Slot>();
  private readonly appointments = new Map<string, Appointment>();
  readonly reminders: Reminder[] = [];
  readonly auditEvents: AuditEvent[] = [];

  setConfig(config: ClientConfig): void {
    this.configs.set(config.tenantId, structuredClone(config));
  }

  seedSlots(slots: Slot[]): void {
    for (const slot of slots) this.slots.set(`${slot.tenantId}:${slot.id}`, structuredClone(slot));
  }

  async save(lead: Lead): Promise<void> {
    this.leads.set(`${lead.tenantId}:${lead.id}`, structuredClone(lead));
  }

  async get(tenantId: string, id?: string): Promise<ClientConfig | Lead | Slot | undefined> {
    if (!id) return this.configs.get(tenantId);
    return this.leads.get(`${tenantId}:${id}`) ?? this.slots.get(`${tenantId}:${id}`);
  }

  async getLead(tenantId: string, leadId: string): Promise<Lead | undefined> {
    const lead = this.leads.get(`${tenantId}:${leadId}`);
    return lead ? structuredClone(lead) : undefined;
  }

  async getConfig(tenantId: string): Promise<ClientConfig | undefined> {
    const config = this.configs.get(tenantId);
    return config ? structuredClone(config) : undefined;
  }

  async listAvailable(tenantId: string): Promise<Slot[]> {
    return [...this.slots.values()]
      .filter((slot) => slot.tenantId === tenantId && slot.available)
      .map((slot) => structuredClone(slot));
  }

  async hold(tenantId: string, slotId: string, leadId: string): Promise<Appointment> {
    const key = `${tenantId}:${slotId}`;
    const slot = this.slots.get(key);
    if (!slot || !slot.available) throw new Error("Slot unavailable");
    slot.available = false;
    this.slots.set(key, slot);
    const appointment: Appointment = {
      id: `appt_${crypto.randomUUID()}`,
      tenantId,
      leadId,
      slotId,
      status: "HELD",
      createdAt: new Date().toISOString(),
    };
    this.appointments.set(appointment.id, appointment);
    return structuredClone(appointment);
  }

  async confirm(tenantId: string, appointmentId: string): Promise<Appointment> {
    const appointment = this.appointments.get(appointmentId);
    if (!appointment || appointment.tenantId !== tenantId) throw new Error("Appointment not found");
    appointment.status = "CONFIRMED";
    return structuredClone(appointment);
  }

  async getSlot(tenantId: string, slotId: string): Promise<Slot | undefined> {
    const slot = this.slots.get(`${tenantId}:${slotId}`);
    return slot ? structuredClone(slot) : undefined;
  }

  async schedule(reminder: Reminder): Promise<void> {
    this.reminders.push(structuredClone(reminder));
  }

  async append(event: AuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }

  snapshot(tenantId: string) {
    return {
      config: this.configs.get(tenantId),
      leads: [...this.leads.values()].filter((lead) => lead.tenantId === tenantId),
      slots: [...this.slots.values()].filter((slot) => slot.tenantId === tenantId),
      appointments: [...this.appointments.values()].filter((appointment) => appointment.tenantId === tenantId),
      reminders: this.reminders.filter((reminder) => reminder.tenantId === tenantId),
      auditEvents: this.auditEvents.filter((event) => event.tenantId === tenantId),
    };
  }
}
