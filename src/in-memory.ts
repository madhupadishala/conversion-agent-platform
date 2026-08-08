import type { Appointment, AuditEvent, ClientConfig, Lead, Reminder, Slot } from "./domain.js";
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

export class InMemoryLeadRepository implements LeadRepository {
  private readonly data = new Map<string, Lead>();
  async save(lead: Lead): Promise<void> {
    this.data.set(`${lead.tenantId}:${lead.id}`, structuredClone(lead));
  }
  async get(tenantId: string, leadId: string): Promise<Lead | undefined> {
    const lead = this.data.get(`${tenantId}:${leadId}`);
    return lead ? structuredClone(lead) : undefined;
  }
}

export class InMemoryClientConfigRepository implements ClientConfigRepository {
  constructor(private readonly configs: ClientConfig[]) {}
  async get(tenantId: string): Promise<ClientConfig | undefined> {
    return this.configs.find((config) => config.tenantId === tenantId);
  }
}

export class InMemorySlotProvider implements SlotProvider {
  public readonly appointments = new Map<string, Appointment>();
  constructor(public readonly slots: Slot[]) {}

  async listAvailable(tenantId: string): Promise<Slot[]> {
    return this.slots.filter((slot) => slot.tenantId === tenantId && slot.available).map(structuredClone);
  }

  async hold(tenantId: string, slotId: string, leadId: string): Promise<Appointment> {
    const slot = this.slots.find((candidate) => candidate.tenantId === tenantId && candidate.id === slotId && candidate.available);
    if (!slot) throw new Error("Slot unavailable");
    slot.available = false;
    const appointment: Appointment = {
      id: `appt_${this.appointments.size + 1}`,
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
}

export class InMemoryPaymentProvider implements PaymentProvider {
  public readonly created: Array<{ tenantId: string; leadId: string; amountMinor: number; currency: string }> = [];
  async createPayment(input: { tenantId: string; leadId: string; amountMinor: number; currency: string }) {
    this.created.push(input);
    const reference = `pay_${this.created.length}`;
    return { reference, paymentUrl: `https://payments.example/${reference}` };
  }
}

export class InMemoryReminderScheduler implements ReminderScheduler {
  public readonly reminders: Reminder[] = [];
  async schedule(reminder: Reminder): Promise<void> {
    this.reminders.push(structuredClone(reminder));
  }
}

export class InMemoryAuditLog implements AuditLog {
  public readonly events: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

export class IncrementingIdGenerator implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}_${this.value}`;
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(value: Date): void {
    this.current = value;
  }
}
