import type { Appointment, AuditEvent, ClientConfig, Lead, Reminder, Slot } from "./domain.js";
import type { AuditLog, ClientConfigRepository, LeadRepository, ReminderScheduler, SlotProvider } from "./ports.js";

export class RuntimeStore {
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

  leadRepository(): LeadRepository {
    return {
      save: async (lead) => {
        this.leads.set(`${lead.tenantId}:${lead.id}`, structuredClone(lead));
      },
      get: async (tenantId, leadId) => {
        const lead = this.leads.get(`${tenantId}:${leadId}`);
        return lead ? structuredClone(lead) : undefined;
      },
    };
  }

  configRepository(): ClientConfigRepository {
    return {
      get: async (tenantId) => {
        const config = this.configs.get(tenantId);
        return config ? structuredClone(config) : undefined;
      },
    };
  }

  slotProvider(): SlotProvider {
    return {
      listAvailable: async (tenantId) => [...this.slots.values()]
        .filter((slot) => slot.tenantId === tenantId && slot.available)
        .map((slot) => structuredClone(slot)),
      get: async (tenantId, slotId) => {
        const slot = this.slots.get(`${tenantId}:${slotId}`);
        return slot ? structuredClone(slot) : undefined;
      },
      hold: async (tenantId, slotId, leadId) => {
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
      },
      confirm: async (tenantId, appointmentId) => {
        const appointment = this.appointments.get(appointmentId);
        if (!appointment || appointment.tenantId !== tenantId) throw new Error("Appointment not found");
        appointment.status = "CONFIRMED";
        return structuredClone(appointment);
      },
    };
  }

  reminderScheduler(): ReminderScheduler {
    return { schedule: async (reminder) => { this.reminders.push(structuredClone(reminder)); } };
  }

  auditLog(): AuditLog {
    return { append: async (event) => { this.auditEvents.push(structuredClone(event)); } };
  }

  async getLead(tenantId: string, leadId: string): Promise<Lead | undefined> {
    return this.leadRepository().get(tenantId, leadId);
  }

  async getConfig(tenantId: string): Promise<ClientConfig | undefined> {
    return this.configRepository().get(tenantId);
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
