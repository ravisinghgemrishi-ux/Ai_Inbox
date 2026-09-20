# GemRishi AI Inbox — Instagram/Facebook + WhatsApp auto-reply & lead qualification

**Phase 2 active.** Phase 1 webhook hardening is preserved; Phase 2 adds conversation memory, intent routing, live-product lookup adapter, structured lead context, and human-handoff foundations.

## Phase 1 guarantees
- one inbound customer comment/message -> one processing claim;
- Redis-backed duplicate protection;
- own-account comment filtering to prevent self-reply loops;
- Zernio comment reply idempotency;
- bounded Gemini retries;
- price-safety guard;
- human acknowledgement on escalation cases.

## Phase 2 architecture
Customer -> Zernio -> webhook -> Redis idempotency -> intent/context layer -> live product lookup -> conversation memory -> Gemini/Mannat -> reply -> lead log/CRM.

### Conversation memory
Recent customer turns are stored in Redis and passed back to Gemini so follow-up questions such as "iska price?", "Nepali wala hai?", or "how to order?" can be answered in context without making the customer repeat themselves.

### Intent routing
The webhook now prepares deterministic intent context for product/price/recommendation/authenticity/order/return/complaint/consultation/general requests. Gemini remains responsible for the final natural-language response and lead classification.

### Live product lookup
The code supports a `GEMRISH_PRODUCT_API_URL` adapter. The endpoint must return a product or product list containing current availability, price, title, URL, and relevant details. Until a verified GemRishi product API endpoint is connected, the bot continues to use the safe no-live-price behavior rather than inventing a price.

## Configuration
See `.env.example`. Secrets are never committed.
