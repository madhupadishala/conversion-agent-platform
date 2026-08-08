import assert from "node:assert/strict";
import test from "node:test";
import { ConversionOrchestrator } from "../src/conversion-orchestrator.js";
import {
  FixedClock,
  InMemoryAuditLog,
  InMemoryClientConfigRepository,
  InMemoryLeadRepository,
  InMemoryPaymentProvider,
  InMemoryReminderScheduler,
  InMemorySlotProvider,
  IncrementingIdGenerator,
} from "../src/in-memory.js";

function fixture() {
  const clock = new FixedClock(new Date("2026-08-09T04:00:00.000Z"));
  const leads = new InMemoryLeadRepository();
  const configs = new InMemoryClientConfigRepository([
    {
      tenantId: "tenant_dental",
      name: "Demo Dental",
      timezone: "Asia/Kolkata",
      contactWithinSeconds: 180,
      paymentRequired: true,
      bookingFeeMinor: 50000,
      currency: "INR",
      reminderOffsetsMinutes: [1440, 180, 30],
      escalationKeywords: ["doctor", "medical advice", "complaint"],
      approvedKnowledge: [
        {
          id: "faq_1",
          question: "What is the consultation fee?",
          answer: "The consultation booking fee is ₹500.",
          status: "APPROVED",
          version: 1,
        },
      ],
    },
  ]);
  const slots = new InMemorySlotProvider([
    {
      id: "slot_1",
      tenantId: "tenant_dental",
      providerId: "doctor_1",
      startsAt: "2026-08-11T10:30:00.000Z",
      endsAt: "2026-08-11T11:00:00.000Z",
      mode: "OFFLINE",
      available: true,
    },
  ]);
  const payments = new InMemoryPaymentProvider();
  const reminders = new InMemoryReminderScheduler();
  const audit = new InMemoryAuditLog();
  const ids = new IncrementingIdGenerator();
  const orchestrator = new ConversionOrchestrator(leads, configs, slots, payments, reminders, audit, ids, clock);
  return { orchestrator, leads, slots, payments, reminders, audit };
}

test("paid lead completes the V0 conversion happy path", async () => {
  const { orchestrator, payments, reminders, audit } = fixture();

  const lead = await orchestrator.ingestLead({
    tenantId: "tenant_dental",
    name: "Rahul",
    phone: "+919999999999",
    source: "website",
    serviceInterest: "implant-consultation",
  });

  await orchestrator.markContactEligible(lead.tenantId, lead.id);
  await orchestrator.startContact(lead.tenantId, lead.id);
  await orchestrator.recordQualification(lead.tenantId, lead.id, { preferredMode: "OFFLINE" });
  const slots = await orchestrator.availableSlots(lead.tenantId, lead.id);
  assert.equal(slots.length, 1);

  await orchestrator.selectSlot(lead.tenantId, lead.id, slots[0].id);
  const payment = await orchestrator.requestPayment(lead.tenantId, lead.id);
  assert.equal(payments.created[0].amountMinor, 50000);
  assert.ok(payment.paymentUrl);

  const paid = await orchestrator.confirmPayment(lead.tenantId, lead.id, payment.lead.paymentReference!);
  assert.equal(paid.status, "PAID");

  const confirmed = await orchestrator.confirmAppointment(lead.tenantId, lead.id);
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(confirmed.paymentStatus, "PAID");
  assert.equal(reminders.reminders.length, 3);
  assert.ok(audit.events.some((event) => event.eventType === "APPOINTMENT_CONFIRMED"));
});

test("tenant isolation prevents cross-tenant lead access", async () => {
  const { orchestrator } = fixture();
  const lead = await orchestrator.ingestLead({
    tenantId: "tenant_dental",
    name: "Anita",
    phone: "+918888888888",
    source: "website",
  });

  await assert.rejects(() => orchestrator.markContactEligible("wrong_tenant", lead.id), /Lead not found/);
});

test("lead can be escalated to human before confirmation", async () => {
  const { orchestrator } = fixture();
  const lead = await orchestrator.ingestLead({
    tenantId: "tenant_dental",
    name: "Maya",
    phone: "+917777777777",
    source: "website",
  });

  await orchestrator.markContactEligible(lead.tenantId, lead.id);
  const handedOff = await orchestrator.handoff(lead.tenantId, lead.id, "Customer requested doctor");
  assert.equal(handedOff.status, "HUMAN_HANDOFF");
});
