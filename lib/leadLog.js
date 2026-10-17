async function logLead({
  platform,
  contact,
  type,
  message,
  reply,
  leadStatus,
  productInterest,
  escalated,
  notes = '',
  // Added 2026-09-24 (Ravi): Gemini's own one-line self-critique of its reply
  // (see lib/replyEngine.js's replyImprovement field) - logged as its own
  // sheet column so the GemRishi team can review it and use it as a
  // self-learning record over time. Blank for the structured flows
  // (seller/kundli/consultation) that don't generate this field yet, and
  // blank whenever Gemini judged its own reply already fine.
  replySuggestion = '',
}) {
  const isHumanHandoff = Boolean(escalated);
  const row = {
    timestamp: new Date().toISOString(),
    platform,
    contact,
    type,
    message,
    reply,
    leadStatus,
    productInterest,
    escalated: isHumanHandoff ? 'Yes' : 'No',
    handoffStatus: isHumanHandoff ? 'HUMAN_REQUIRED' : 'AI_HANDLED',
    handoffAction: isHumanHandoff ? 'TRANSFER_TO_HUMAN' : 'CONTINUE_AI',
    notes,
    replySuggestion,
  };

  const url = process.env.LEAD_LOG_WEBHOOK_URL;
  if (!url) {
    console.log('[leadLog] LEAD_LOG_WEBHOOK_URL not set, skipping sheet write:', row);
    return;
  }

  // 2026-10-17 audit: was a 5-second limit with no retry - Google Apps
  // Script is often slower than that, and 3 rows were lost (latest 16 Oct).
  // Now 15s per try and one retry (runs in the background, so the customer's
  // reply is never held up by this).
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`lead log endpoint returned ${res.status}`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    } finally {
      clearTimeout(timeout);
    }
  }
  console.error('[leadLog] failed to write to sheet:', lastErr?.message);
}

module.exports = { logLead };
