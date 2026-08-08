import type { Appointment, AuditEvent, ClientConfig, Lead, Reminder, Slot } from "./domain.js";

export interface LeadRepository {
  save(lead: Lead): Promise<void>;
  get(tenantId: string, leadId: string): Promise<Lead | undefined>;
}

export interface ClientConfigRepository {
  get(tenantId: string): Promise<ClientConfig | undefined>;
}

export interface SlotProvider {
  listAvailable(tenantId: string, serviceInterest?: string): Promise<Slot[]>;
  get(tenantId: string, slotId: string): Promise<Slot | undefined>;
  hold(tenantId: string, slotId: string, leadId: string): Promise<Appointment>;
  confirm(tenantId: string, appointmentId: string): Promise<Appointment>;
}

export interface PaymentProvider {
  createPayment(input: {
    tenantId: string;
    leadId: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ reference: string; paymentUrl: string }>;
}

export interface ReminderScheduler {
  schedule(reminder: Reminder): Promise<void>;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface Clock {
  now(): Date;
}
