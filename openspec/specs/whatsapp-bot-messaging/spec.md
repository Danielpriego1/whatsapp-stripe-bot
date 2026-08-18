# WhatsApp Bot Messaging Specification

## Purpose

Defines how the system turns inbound WhatsApp text messages into Sora-powered replies with immediate acknowledgment, asynchronous per-message processing, redelivery deduplication, and contained failures.

## Requirements

### Requirement: Acknowledge Inbound Deliveries Immediately

The system SHALL respond `200 EVENT_RECEIVED` to every valid `whatsapp_business_account` delivery before processing any message; processing SHALL NOT delay or alter that response.

#### Scenario: Delivery acknowledged before processing

- GIVEN a webhook delivery containing an inbound message
- WHEN the delivery is received
- THEN the system responds `200 EVENT_RECEIVED` immediately, before processing begins

### Requirement: Process Messages Asynchronously with Error Containment

The system SHALL process each message independently of the acknowledgment path. A failure on one message SHALL be logged, SHALL NOT crash the server, and SHALL NOT prevent other messages being processed.

#### Scenario: One message fails, others still processed

- GIVEN a delivery with two messages where processing the first throws an error
- WHEN the delivery is processed
- THEN the error is logged AND the second message is still processed and replied to

### Requirement: Process Every Message in a Delivery

The system SHALL process every message in a multi-message delivery, not only the first.

#### Scenario: Multiple messages in one delivery

- GIVEN a webhook delivery containing two text messages from the same sender
- WHEN the delivery is processed
- THEN each message receives its own Sora reply

### Requirement: Skip Messages Without a Sender or Text

The system SHALL skip any message that lacks a sender or has empty text, without sending a reply.

#### Scenario: Message with no text

- GIVEN an inbound message with no text body (e.g., media)
- WHEN the delivery is processed
- THEN the message is skipped, no reply is sent, and processing continues

### Requirement: Ignore Duplicate Message Deliveries

The system SHALL NOT process a message whose identifier was already processed within a recent window; a duplicate delivery SHALL be ignored without side effects. After the window expires, the identifier MAY be processed again.

#### Scenario: Meta redelivers the same message

- GIVEN a message already processed whose identifier is still within the deduplication window
- WHEN the same identifier is delivered again
- THEN it is ignored: no reply, no order, no state change

#### Scenario: Identifier outside the deduplication window

- GIVEN a message identifier processed before the deduplication window
- WHEN it is delivered again
- THEN the message MAY be processed normally

### Requirement: Send Exactly One Reply per Message

The system SHALL send at most one outbound message per inbound message. When processing indicates the reply was already sent (the payment branch sends its link during processing), the system SHALL NOT send a second message; otherwise it SHALL send the Sora reply.

#### Scenario: Payment request sends link exactly once

- GIVEN an inbound message requesting to pay or buy
- WHEN the message is processed
- THEN an order is created and the payment link is sent exactly once

#### Scenario: Regular question gets one reply

- GIVEN an inbound message asking about pricing
- WHEN the message is processed
- THEN the sender receives exactly one reply

### Requirement: Indicate Typing and Mark Messages Read

The system SHOULD send a combined read + typing indicator to the sender before processing a message. Failures of the indicator SHALL be logged and SHALL NOT block or cancel the reply. There is no explicit "typing off": the indicator auto-dismisses when the reply is delivered or after 25 seconds.

#### Scenario: Read receipt and typing indicator precede the reply

- GIVEN an inbound text message
- WHEN the message is processed
- THEN a combined read receipt + typing indicator is sent before processing, and the reply delivery dismisses the indicator

#### Scenario: Indicator fails to send

- GIVEN an inbound message whose read + typing indicator fails
- WHEN the message is processed
- THEN the failure is logged and the reply is still delivered