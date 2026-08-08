export type LeadStatus =
  | "RECEIVED"
  | "CONTACT_ELIGIBLE"
  | "CONTACTING"
  | "QUALIFIED"
  | "SLOT_HELD"
  | "PAYMENT_PENDING"
  | "PAID"
  | "CONFIRMED"
  | "HUMAN_HANDOFF"
  | "CLOSED";

export type PaymentStatus = "NOT_REQUIRED" | "PENDING" | "PAID" | "FAILED" | "REFUNDED";

export interface ApprovedKnowledgeItem {
  id: string;
  question: string;
  answer: string;
  status: "DRAFT" | "APPROVED" | "RETIRED";
  version: number;
}

export interface ClientConfig {
  tenantId: string;
  name: string;
  timezone: string;
  contactWithinSeconds: number;
  paymentRequired: boolean;
  bookingFeeMinor: number;
  currency: string;
  reminderOffsetsMinutes: number[];
  escalationKeywords: string[];
  approvedKnowledge: ApprovedKnowledgeItem[];
}

export interface Lead {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  source: string;
  serviceInterest?: string;
  status: LeadStatus;
  paymentStatus: PaymentStatus;
  createdAt: string;
  updatedAt: string;
  qualification: Record<string, string>;
  slotId?: string;
  paymentReference?: string;
  appointmentId?: string;
  handoffReason?: string;
}

export interface Slot {
  id: string;
  tenantId: string;
  providerId: string;
  startsAt: string;
  endsAt: string;
  mode: "ONLINE" | "OFFLINE";
  available: boolean;
}

export interface Reminder {
  id: string;
  tenantId: string;
  leadId: string;
  appointmentId: string;
  sendAt: string;
  channel: "VOICE" | "WHATSAPP" | "SMS" | "EMAIL";
  status: "SCHEDULED" | "SENT" | "CANCELLED";
}

export interface Appointment {
  id: string;
  tenantId: string;
  leadId: string;
  slotId: string;
  status: "HELD" | "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  leadId: string;
  eventType: string;
  at: string;
  metadata?: Record<string, string | number | boolean>;
}
