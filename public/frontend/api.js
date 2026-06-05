/**
 * API wrappers — all fetch calls to the backend go through here.
 */

import {
  apiHeaders, connectedAddress, authSignature, authTimestamp,
  lastEventTimestamp, setLastEventTimestamp,
} from './state.js';

/**
 * POST /api/chat with SSE streaming.
 * Returns the final parsed response object.
 */
export async function sendChatMessage(body, onStreamEvent, signal) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: apiHeaders(),
    signal,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.error || `HTTP ${res.status}`);
  }

  if (!body.stream) {
    return res.json();
  }

  // SSE streaming
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload);
          if (event.type === 'done') {
            finalResponse = event.response;
          }
          if (onStreamEvent) onStreamEvent(event);
        } catch { /* ignore malformed SSE line */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      reader.cancel();
    } else {
      throw err;
    }
  }

  return finalResponse;
}

/**
 * POST /api/tools?toolName={name}
 */
export async function callTool(toolName, body, signal) {
  const res = await fetch(`/api/tools?toolName=${toolName}`, {
    method: 'POST',
    headers: apiHeaders(),
    signal,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Fetch delegation status for a vault.
 */
export async function fetchDelegationStatus(vault, allChains = false) {
  const url = `/api/delegation/status?vaultAddress=${vault}${allChains ? '&allChains=true' : ''}`;
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Fetch agent wallet ETH balance.
 */
export async function fetchAgentBalance(vault) {
  const res = await fetch(`/api/agent/balance?vaultAddress=${vault}`, { headers: apiHeaders() });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Poll strategy events for a vault.
 */
export async function pollStrategyEvents(vault) {
  const res = await fetch(`/api/strategy-events?vault=${vault}&since=${lastEventTimestamp}`);
  if (!res.ok) return [];
  const { events } = await res.json();
  if (events && events.length > 0) {
    for (const ev of events) {
      if (ev.timestamp > lastEventTimestamp) setLastEventTimestamp(ev.timestamp);
    }
  }
  return events || [];
}

/**
 * Toggle sponsored gas for a vault.
 */
export async function setSponsoredGas(vault, enabled) {
  const res = await fetch('/api/agent/sponsored-gas', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ vaultAddress: vault, enabled }),
  });
  return res.ok;
}
