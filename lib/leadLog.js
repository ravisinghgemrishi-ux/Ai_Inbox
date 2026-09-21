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
  };

  const url = process.env.LEAD_LOG_WEBHOOK_URL;
  if (!url) {
    console.log('[leadLog] LEAD_LOG_WEBHOOK_URL not set, skipping sheet write:', row);
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`lead log endpoint returned ${res.status}`);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error('[leadLog] failed to write to sheet:', err.message);
  }
}

module.exports = { logLead };
