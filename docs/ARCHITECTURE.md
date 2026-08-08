# V0 Architecture

## Product boundary

The platform converts an inbound enquiry into a governed appointment workflow. It is intentionally provider-independent and multi-tenant.

## Core flow

1. Lead is received through an API/webhook adapter.
2. Contact eligibility is evaluated before outreach.
3. Voice/messaging adapter starts the conversation.
4. Conversation layer may only use client-approved knowledge plus explicitly configured commercial data.
5. Qualification produces structured fields.
6. Scheduling adapter returns tenant-scoped availability.
7. Selected slot is held.
8. If required, payment adapter creates a payment request.
9. Verified payment webhook moves the lead to PAID.
10. Appointment is confirmed.
11. Reminder jobs are scheduled.
12. Any unsupported, sensitive, ambiguous, or human-requested interaction can transition to HUMAN_HANDOFF.

## Architecture rule

Business logic must not depend directly on Twilio, Exotel, Razorpay, Google Calendar, WhatsApp, a specific LLM, or a database vendor. Those capabilities implement ports around the conversion orchestrator.

## Tenant configuration

Each tenant owns configuration for:

- approved knowledge and versions
- contact timing
- services and qualification fields
- payment requirements and booking fee
- reminder policy
- escalation rules
- provider/calendar connections
- communication channels

Production agents must never consume DRAFT knowledge.

## V0 state model

RECEIVED → CONTACT_ELIGIBLE → CONTACTING → QUALIFIED → SLOT_HELD → PAYMENT_PENDING → PAID → CONFIRMED

Alternate governed paths include HUMAN_HANDOFF and CLOSED.

## Not in V0

- native mobile applications
- CRM replacement
- autonomous medical/clinical advice
- free-form price or policy invention
- marketing/ad buying
- complex analytics warehouse
- custom codebase per client
