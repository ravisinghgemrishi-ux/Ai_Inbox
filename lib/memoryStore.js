const DEFAULT_TTL = 60 * 60 * 24 * 30;
const MAX_TURNS = 12;

function redisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function redis(path, method = 'GET') {
  const { url, token } = redisConfig();
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis memory error ${res.status}`);
  return res.json().catch(() => ({}));
}

function key(scope, id) {
  const safe = String(id || 'unknown').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 180);
  return `gemrishi:conversation:${scope}:${safe}`;
}

async function getMemory(scope, id) {
  const k = key(scope, id);
  const data = await redis(`/lrange/${encodeURIComponent(k)}/0/-1`);
  if (!data?.result) return [];
  return data.result.map((item) => {
    try { return JSON.parse(item); } catch { return null; }
  }).filter(Boolean).slice(-MAX_TURNS);
}

async function addTurn(scope, id, turn) {
  const k = key(scope, id);
  const value = JSON.stringify({
    role: turn.role,
    text: String(turn.text || '').slice(0, 4000),
    timestamp: turn.timestamp || new Date().toISOString(),
  });
  await redis(`/rpush/${encodeURIComponent(k)}/${encodeURIComponent(value)}`, 'POST');
  await redis(`/ltrim/${encodeURIComponent(k)}/-${MAX_TURNS}/-1`, 'POST');
  await redis(`/expire/${encodeURIComponent(k)}/${DEFAULT_TTL}`, 'POST');
}

function formatMemory(turns = []) {
  return turns.map((t) => `${t.role === 'assistant' ? 'Mannat' : 'Customer'}: ${t.text}`).join('\n');
}

module.exports = { getMemory, addTurn, formatMemory };
