# Payment Confirmation Specification

## Purpose

Defines how the system reacts to Stripe checkout and payment events to keep order payment state accurate (`pendiente`, `pagada`, `fallida`, `cancelada`) and to notify customers by WhatsApp. Handling must be idempotent and must not create retry storms for conditions replay cannot recover.

## Requirements

### Requirement: Verify Payment Before Marking Order Paid

When a `checkout.session.completed` event arrives, the system SHALL verify the session's `amount_total` and currency match the order before marking it paid. On a match it SHALL set the status to `pagada` and record the Stripe session identifier and payment timestamp. On a mismatch it SHALL NOT change the status, SHALL log the discrepancy, and SHALL acknowledge the event.

#### Scenario: Amount and currency match

- GIVEN a `checkout.session.completed` event for an order in `pendiente` state whose `amount_total` and currency equal the session values
- WHEN the event is processed
- THEN the order is marked `pagada` with the Stripe session id and payment timestamp recorded

#### Scenario: Amount or currency mismatch

- GIVEN a `checkout.session.completed` event whose `amount_total` or currency differs from the stored order
- WHEN the event is processed
- THEN the order remains `pendiente`, the discrepancy is logged, and the event acknowledged without retry

### Requirement: Mark Order Failed on Failed Payment

When a `payment_intent.payment_failed` event arrives, the system SHALL mark the referencing order `fallida`.

#### Scenario: Payment failure

- GIVEN a `payment_intent.payment_failed` event for an order in `pendiente` state
- WHEN the event is processed
- THEN the order is marked `fallida`

### Requirement: Mark Order Canceled on Expired Session

When a `checkout.session.expired` event arrives, the system SHALL mark the referencing order `cancelada`.

#### Scenario: Expired checkout session

- GIVEN a `checkout.session.expired` event for an order in `pendiente` state
- WHEN the event is processed
- THEN the order is marked `cancelada`

### Requirement: Send WhatsApp Payment Confirmation

After marking an order `pagada`, the system SHALL send a WhatsApp payment confirmation to the customer. If sending fails, it SHALL log the failure; the order SHALL remain `pagada` and the event SHALL be acknowledged.

#### Scenario: Confirmation delivered

- GIVEN an order just marked `pagada` by a completed checkout
- WHEN the payment confirmation is sent to the customer's WhatsApp number
- THEN the customer receives the confirmation

#### Scenario: Confirmation send fails

- GIVEN an order just marked `pagada`
- WHEN sending the WhatsApp confirmation fails
- THEN the failure is logged and the order remains `pagada`

### Requirement: Handle Events Idempotently

The system SHALL process duplicate Stripe events without error; re-applying the same status and fields SHALL yield the same final state.

#### Scenario: Duplicate completed event

- GIVEN an order already `pagada` from a prior `checkout.session.completed` event
- WHEN the same event is delivered again
- THEN processing succeeds and the order state is unchanged

### Requirement: Acknowledge Unrecoverable Events

The system SHALL acknowledge events it cannot act on — missing order metadata, order not found, or amount/currency mismatch — after logging, without signaling Stripe to retry.

#### Scenario: Missing order metadata

- GIVEN a `checkout.session.completed` event without an order identifier in its metadata
- WHEN the event is processed
- THEN the event is acknowledged and logged; no order update occurs

#### Scenario: Order not found

- GIVEN a `checkout.session.completed` event whose order identifier matches no existing order
- WHEN the event is processed
- THEN the event is acknowledged and logged; no order update occurs

### Requirement: Signal Retry for Transient Failures

If an order update fails due to a transient database error, the system SHALL respond with a retryable error so Stripe redelivers the event, and SHALL NOT acknowledge it as handled.

#### Scenario: Transient database failure

- GIVEN a `checkout.session.completed` event whose order update fails with a transient database error
- WHEN the event is processed
- THEN the system returns a retryable error so Stripe redelivers the event