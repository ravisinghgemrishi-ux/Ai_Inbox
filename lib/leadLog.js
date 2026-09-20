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
  const row = {
    timestamp: new Date().toISOString(),
    platform,
    contact,
    type,
    message,
    reply,
    leadStatus,
    productInterest,
    escalated: escalated ? 'Yes' : 'No',
    notes,
  };

  const url = process.env.LEAD_LOG_WEBHOOK_URL;
  if (!url) {
    console.log('[leadLog] LEAD_LOG_WEBHOOK_URL not set, skipping sheet write:', row);
    return;
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.error('[leadLog] failed to write to sheet:', err.message);
  }
}

module.exports = { logLead };
