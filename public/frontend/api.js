/**
 * API wrappers — all fetch calls to the backend go through here.
 */

import {
  apiHeaders, connectedAddress, authSignature, authTimestamp,
  lastEventTimestamp, setLastEventTimestamp, captureSessionToken, clearSessionToken,
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

  captureSessionToken(res);

  if (!res.ok) {
    // A non-JSON body is a Cloudflare-level error page (worker crash 1101,
    // gateway 5xx) — extract the diagnostic instead of a bare "HTTP 500".
    if (!(res.headers.get('content-type') || '').includes('application/json')) {
      const text = await res.text().catch(() => '');
      const cfCode = text.match(/cf-error-code[^0-9]{0,40}(\d{3,4})/i)?.[1]
        || text.match(/\bError\s+(\d{3,4})\b/)?.[1];
      const ray = text.match(/Ray ID:\s*(?:<[^>]*>\s*)?([0-9a-f]{16})/i)?.[1];
      if (res.status === 401) {
        clearSessionToken();
      }
      throw new Error(
        `Service error (HTTP ${res.status}${cfCode ? `, Cloudflare ${cfCode}` : ''}${ray ? `, Ray ID ${ray}` : ''}) — please retry in a moment`,
      );
    }
    const errData = await res.json().catch(() => null);
    if (res.status === 401) {
      clearSessionToken();
    }
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
  captureSessionToken(res);
  if (res.status === 401) {
    clearSessionToken();
  }
  // A non-JSON body is a Cloudflare-level error page (worker crash, gateway
  // 5xx) — surface its code instead of an empty "Unknown error".
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    const text = await res.text().catch(() => '');
    const cfCode = text.match(/cf-error-code[^0-9]{0,40}(\d{3,4})/i)?.[1]
      || text.match(/\bError\s+(\d{3,4})\b/)?.[1];
    const ray = text.match(/Ray ID:\s*(?:<[^>]*>\s*)?([0-9a-f]{16})/i)?.[1];
    return {
      ok: false,
      status: res.status,
      data: {
        error: `Service error (HTTP ${res.status}${cfCode ? `, Cloudflare ${cfCode}` : ''}${ray ? `, Ray ID ${ray}` : ''}) — please retry in a moment`,
      },
    };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Fetch delegation status for a vault.
 */
export async function fetchDelegationStatus(vault, allChains = false) {
  const url = `/api/delegation/status?vaultAddress=${vault}${allChains ? '&allChains=true' : ''}`;
  const res = await fetch(url, { headers: apiHeaders() });
  captureSessionToken(res);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Fetch agent wallet ETH balance.
 */
export async function fetchAgentBalance(vault) {
  const res = await fetch(`/api/delegation/balance?vaultAddress=${vault}`, { headers: apiHeaders() });
  captureSessionToken(res);
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


