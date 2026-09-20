# GemRishi AI Inbox — Instagram/Facebook + WhatsApp auto-reply & lead qualification

**Status: deployed and live.** The webhook is running on Vercel and registered
with Zernio. What's left is one 5-minute step on your side (the lead-log
sheet connection) — see "One thing left to do" below.

What this does: whenever someone comments on a GemRishi Instagram/Facebook post or
reel, sends an Instagram/Facebook DM, or messages GemRishi's WhatsApp number, this
service reads it, replies in GemRishi's voice, and logs it as a Hot/Warm/Cold lead
in a Google Sheet — no scheduling or posting involved, purely inbound reply + lead
qualification, as requested.

## Live deployment

- **Webhook URL:** `https://gemrishi-ai-inbox.vercel.app/api/webhook`
- **Vercel project:** `gemrishi-ai-inbox` (in your Vercel account, hobby plan)
- **Registered with Zernio:** yes — webhook id `6aafbed90721c2181f6e47be`,
  subscribed to `comment.received` and `message.received`.
- **AI model:** Google Gemini `gemini-3.6-flash` (free tier), with
  "thinking" turned off (`thinkingBudget: 0`) since this task is a quick
  classify-and-reply, not something that needs extended reasoning — that
  also keeps replies fast and free-tier-friendly.
- **Deployment protection:** turned off for this project so Zernio's
  webhook calls (which carry no Vercel login) can reach it.

I tested the full chain end-to-end with a signed test event: signature
verification, the Gemini call, and the lead-classification logic all work
correctly — a price question about "13 Mukhi Rudraksha" correctly came back
classified as a HOT lead, with a Hinglish reply that avoided guessing an
unconfirmed price and flagged the conversation for your follow-up, exactly
per the rules in `lib/knowledgeBase.js`.

## How the pieces fit

```
Instagram/Facebook comment or DM  ─┐
WhatsApp message                  ─┼─> Zernio (connects your accounts, sends webhooks)
                                    │
                                    v
                        your deployed /api/webhook  (this code)
                                    │
                        Gemini reads the message + GemRishi's
                        knowledge base, writes a reply, scores the lead
                                    │
                    ┌───────────────┼────────────────┐
                    v                                 v
        reply sent back via Zernio          logged to Google Sheet
        (or held for you if it needs
         a human — refunds, complaints, etc.)
```

## What's in this folder

- `api/webhook.js` — the one URL Zernio calls for every event. Also has a
  small signature-gated `debug: true` diagnostic path (see below).
- `lib/knowledgeBase.js` — GemRishi's brand voice, catalog notes, escalation
  rules, and lead-scoring rubric. **Read and edit this before real customers
  rely on it** — especially the certification wording and any claims about
  benefits.
- `lib/replyEngine.js` — calls Google Gemini to generate the reply + lead score.
- `lib/zernioClient.js` — sends replies back through Zernio's API.
- `lib/leadLog.js` + `apps-script-webhook.gs` — writes each interaction to
  your Google Sheet.
- `.env.example` — the secrets/keys already set as Vercel environment variables.
- `sample-events.http` — test payloads to try locally.

## One thing left to do: connect the lead-log sheet

Right now `LEAD_LOG_WEBHOOK_URL` isn't set on Vercel, so every interaction
still gets classified and replied to correctly, but the row is only written
into the function's logs, not to your Google Sheet. To finish this:

1. Open the sheet: https://docs.google.com/spreadsheets/d/1EuMXyorMNdUNrnA4PHXJ_HZ7gKN9qS-B0X3oLLY3A6M/edit
2. Extensions → Apps Script.
3. Paste in the contents of `apps-script-webhook.gs` (included in this folder).
4. Deploy → New deployment → type "Web app" → Execute as "Me" → Who has
   access "Anyone with the link" → Deploy. Copy the resulting URL (ends in
   `/exec`).
5. Send me that URL and I'll add it as `LEAD_LOG_WEBHOOK_URL` on Vercel and
   redeploy — or add it yourself in the Vercel dashboard under this
   project's Settings → Environment Variables, then redeploy.

## Please also double-check on your end

- **Zernio dashboard → Connected accounts:** confirm Instagram, the
  Facebook Page, and the WhatsApp Business number all show as connected.
  I registered the webhook successfully, but I can't see your dashboard to
  confirm the three accounts are linked — if any isn't, events for that
  channel simply won't arrive yet.
- **Zernio dashboard → API Keys:** confirm the key has the "messages"
  resource group enabled, or sends/replies will fail with a 403 even though
  comments/DMs are received correctly.

## Diagnostic endpoint (safe to keep or remove)

`api/webhook.js` includes a small debug path: a request with a valid
`X-Zernio-Signature` (i.e., only someone who has your webhook secret) and
`{"debug": true, "message": "..."}` in the body gets back the AI's reply +
lead classification directly in the HTTP response, without touching Zernio
or the sheet. This is how I verified the Gemini key and prompt were working
correctly. It's harmless to leave in — Zernio's real events never set `debug` —
but say the word if you'd like it removed.

## Important before this goes live with real customers

- **Pricing accuracy**: only ~27 of GemRishi's Shopify products are currently
  published (ACTIVE) with real prices; the rest are drafts with a ₹100
  placeholder. The knowledge base is written to make the AI say "I'll confirm
  the exact price" rather than guess — but it's worth publishing/pricing the
  rest of the catalog properly, or telling me which products are truly for
  sale, so replies stay accurate.
- **Certification/benefit claims**: please review the wording in
  `knowledgeBase.js` about certification and traditional associations — I've
  deliberately kept it non-medical/non-guaranteed, but you know what GemRishi
  is comfortable claiming publicly.
- **Bot disclosure**: the AI will say it's GemRishi's assistant (not deny
  being AI) if a customer asks directly — this is both good practice and
  avoids consumer-protection issues in most markets.
- **WhatsApp's 24-hour window**: Zernio's send-message endpoint only allows
  free-form replies within 24 hours of the customer's last message; outside
  that window WhatsApp requires an approved template message. The current
  code doesn't handle that fallback — flag it if you want that added.

## If a field mapping ever looks wrong

`api/webhook.js` logs every raw event it receives (`console.log('[webhook]
received event:', ...)`, visible in Vercel's function logs). Zernio's
webhook shape was verified against their live docs, but if a real
comment/message ever gets misread (wrong text, wrong sender), that log line
shows exactly what Zernio actually sent — paste it here and it's a one-line fix.
