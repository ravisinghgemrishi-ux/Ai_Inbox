# GemRishi AI Inbox — Instagram/Facebook + WhatsApp auto-reply & lead qualification

**Phase 1 hardening in progress.** The production service is deployed on Vercel and the source of truth is the `main` branch of this repository.

## Phase 1 scope

This service receives inbound Instagram/Facebook comments and messages, and WhatsApp messages, through Zernio; generates a short GemRishi reply and lead classification with Gemini; sends the reply through Zernio when appropriate; and records the interaction through the configured lead logger.

Recent hardening includes:
- signed webhook validation in production;
- Redis-backed duplicate-event protection when Redis REST credentials are present;
- awaited webhook processing rather than deliberately detaching work after the HTTP response;
- Zernio reply idempotency for comment replies;
- bounded retries for transient Gemini failures;
- explicit handling for missing Gemini/Zernio credentials;
- live-price-only instructions for the AI (handbook/reference prices are not current selling prices);
- bounded lead-log HTTP timeout and HTTP-status checking.

## Current production status

The latest production deployments have been building successfully, but runtime logs showed Gemini 429 quota exhaustion and some transient `fetch failed` errors. The code now retries transient failures with bounded backoff and falls back safely instead of sending an invented product price.

## Configuration

Required production secrets/configuration are kept in Vercel environment variables and are never committed to this repository. See `.env.example` for variable names.

For the actual social accounts to receive events, Zernio must have the intended Instagram, Facebook Page, and WhatsApp Business accounts connected and the webhook must be registered for `comment.received` and `message.received`.

## Price safety

The AI must not treat Rudraksha Handbook indicative prices or historical catalog notes as current website selling prices. Current prices should only be supplied through a future live-product-data lookup. Until that lookup exists and returns a matching product, the safe response is to confirm the exact current price with the team and qualify the inquiry as appropriate.

## Phase 2

After Phase 1 is verified end-to-end, the next architecture will add live GemRishi/Rudraksha product lookup, conversation memory, richer intent routing, structured lead/CRM data, and stronger human-handoff workflows. These changes are intentionally not being mixed into Phase 1 unnecessarily.
