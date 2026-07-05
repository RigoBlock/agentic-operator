/**
 * Chat streaming module — sendMessage, handleChatResponse, auto-progress.
 */

import {
  chatEl, inputEl, sendBtn, vaultInput,
  activeAbortController, setActiveAbortController,
  currentChainId, setCurrentChainId,
  conversationHistory, setConversationHistory,
  pendingTx, setPendingTx,
  connectedAddress, authSignature, authTimestamp, setAuthSignature, setAuthTimestamp,
  executionMode, setExecutionMode,
  autoExecuteMode, setAutoExecuteMode,
  multiStepActive, setMultiStepActive,
  apiHeaders, escapeHtml, getExplorerUrl,
  CHAIN_NAMES, TESTNET_CHAINS_LIST,
  enterStoppingMode, exitStoppingMode, persistChat, restoreChat,
  commandHistory,
  setHistoryIndex, setHistoryDraft,
} from "./state.js";

import { sendChatMessage, callTool } from "./api.js";

import { makeReasoningBlock, appendMessage } from "./chat-ui.js";

import {
  getAiRequestParams, slippageOverrideKey, getSlippageBps,
  applyTestnetState, updateChainDisplay,
} from "./settings.js";

import { getSavedVaults } from "./vault.js";

import { refreshDelegationStatus } from "./delegation-status.js";

import { openWalletPicker, signAuthMessage, authKey } from "./wallet.js";

import { showTransactionModal } from "./tx-modal.js";

import {
  showDelegatedConfirmation, showMultiDelegatedConfirmation,
} from "./tx-delegated.js";

import { showManualTxCard, showTxReceiptCard } from "./tx-receipt.js";

function autoProgressAfterTx(description) {
  // Only auto-progress when we're in a multi-step flow
  if (!multiStepActive) return;
  const followUp = description
    ? `Transaction confirmed: ${description}. Continue to the next step.`
    : `Transaction confirmed. Continue to the next step.`;
  // Add to conversation history as if the user said it
  conversationHistory.push({ role: 'user', content: followUp });
  persistChat();
  // Show a subtle system message so the user sees the auto-progress
  appendMessage('system', '⏭️ Proceeding to next step…');
  // Trigger sendMessage with the follow-up already in history
  inputEl.value = followUp;
  sendMessage();
}

/** Build a collapsible reasoning block — shared by appendMessage and streaming paths. */
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  // Push to command history
  if (!commandHistory.length || commandHistory[commandHistory.length - 1] !== text) {
    commandHistory.push(text);
  }
  setHistoryIndex(-1);
  setHistoryDraft('');

  const vault = vaultInput.value.trim();
  // Allow empty vault — zero address means no pool yet (for deploy_smart_pool flow)
  const effectiveVault = (vault && vault.length === 42) ? vault : '0x0000000000000000000000000000000000000000';
  const chainId = currentChainId;

  // Chain mismatch warning removed — it was redundant (the backend already reports
  // chain switches via data.chainSwitch) and often wrong (delegated mode signs with
  // the agent wallet, and cross-chain ops auto-switch to the target chain).
  // Manual-mode users get a chain-switch prompt from their wallet when signing.

  if (!connectedAddress) {
    appendMessage('system', '👛 Please connect your wallet first to use the chat.');
    openWalletPicker();
    return;
  }

  // Check if user is the vault owner — requires valid vault address and explicit '(owned)' status.
  // Non-owners and no-vault users chat in read-only/deploy mode without auth signing.
  const statusEl = document.getElementById('vault-status');
  const isOwner = !!(vault && vault.length === 42)
    && !!(statusEl && statusEl.textContent.includes('(owned)') && !statusEl.className.includes('error'));

  // Vault owners must sign once per session (24h cache) — proves wallet ownership
  // for delegated execution and vault-specific tools.
  if (isOwner && !authSignature) {
    appendMessage('system', 'Signing authentication…');
    await signAuthMessage();
    if (!authSignature) {
      appendMessage('system', 'Sign cancelled. Please try again.');
      return;
    }
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';

  appendMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });
  persistChat();

  const typingEl = document.createElement('div');
  typingEl.className = 'msg assistant typing';
  const typingContent = document.createElement('div');
  typingContent.className = 'msg-content';
  typingContent.textContent = 'Thinking…';
  typingEl.appendChild(typingContent);
  chatEl.appendChild(typingEl);
  chatEl.scrollTop = chatEl.scrollHeight;

  const updateTypingStatus = (msg) => { typingContent.textContent = msg; };

  // Auth is handled via cached wallet signature headers (X-Auth-*); no session token is used.

  // 3-minute timeout — GMX and complex multi-RPC operations need more headroom
  const controller = new AbortController();
  let userStopped = false;
  const timeoutId = setTimeout(() => controller.abort(), 180000);
  enterStoppingMode(controller, () => { userStopped = true; controller.abort(); });

  try {
    const chatBody = {
      messages: conversationHistory,
      vaultAddress: effectiveVault,
      chainId,
      ...getAiRequestParams(),
    };
    // Only send per-request slippage when user explicitly overrides from UI.
    // Otherwise backend resolves from verified request -> KV -> default.
    const hasExplicitUiSlippageOverride = localStorage.getItem(slippageOverrideKey()) === 'true';
    if (hasExplicitUiSlippageOverride) {
      chatBody.slippageBps = getSlippageBps();
    }
    // Always send operatorAddress when connected — needed for calldata building
    // (pool deployment, swaps, etc.) regardless of vault ownership.
    if (connectedAddress) {
      chatBody.operatorAddress = connectedAddress;
    }
    // Include signed credentials only for vault owners — needed for delegated mode
    // and vault-specific tools. Non-owners do not send auth headers (x402 payment required).
    if (isOwner && authSignature) {
      chatBody.authSignature = authSignature;
      chatBody.authTimestamp = authTimestamp;
    }
    // Execution mode and delegated confirmation are vault-owner–only features.
    if (isOwner && authSignature) {
      chatBody.executionMode = executionMode;
      // In autonomous mode with delegation, pass confirmExecution for auto-execute
      if (executionMode === 'delegated' && autoExecuteMode === 'autonomous') {
        chatBody.confirmExecution = true;
      }
    }

    // Enable SSE streaming for real-time updates
    chatBody.stream = true;

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: apiHeaders(),
      signal: controller.signal,
      body: JSON.stringify(chatBody),
    });

    if (!res.ok) {
      // SSE stream won't start on error — try parsing JSON error
      const errData = await res.json().catch(() => null);
      const errMsg = errData?.error || `HTTP ${res.status}`;
      // If auth error and we're an owner with a cached sig, it may have expired — retry once
      if (res.status === 401 || res.status === 403) {
        if (!isOwner || !authSignature) { appendMessage('system', errMsg); return; }
        appendMessage('system', 'Session expired, re-authenticating…');
        setAuthSignature(null);
        setAuthTimestamp(null);
        localStorage.removeItem(authKey(connectedAddress));
        await signAuthMessage();
        if (authSignature) {
          const retryBody = {
            ...chatBody,
            authSignature,
            authTimestamp,
          };
          const retryRes = await fetch('/api/chat', {
            method: 'POST',
            headers: apiHeaders(),
            signal: controller.signal,
            body: JSON.stringify(retryBody),
          });
          if (retryRes.ok) {
            const retryType = retryRes.headers.get('content-type') || '';
            let retryData = null;
            if (retryType.includes('text/event-stream')) {
              const raw = await retryRes.text();
              for (const line of raw.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const event = JSON.parse(line.slice(6));
                  if (event.type === 'done' && event.response) {
                    retryData = event.response;
                  }
                } catch { /* ignore malformed retry SSE chunks */ }
              }
            } else {
              retryData = await retryRes.json().catch(() => null);
            }
            if (!retryData) throw new Error('Retry succeeded but returned no response payload');
            typingEl.remove();
            await handleChatResponse(retryData);
            return;
          }
        }
        throw new Error(`Auth: ${errMsg}`);
      }
      throw new Error(errMsg);
    }

    // Stream SSE events from the response
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResponse = null;
      let confirmationShown = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'status') {
              updateTypingStatus(event.message);
            } else if (event.type === 'reasoning') {
              const reasoningText = String(event.content || '').trim();
              const truncated = reasoningText.length > 3000 ? reasoningText.slice(0, 3000) + '...' : reasoningText;
              let reasoningEl = typingEl.querySelector('.reasoning-block');
              if (!reasoningEl) {
                reasoningEl = makeReasoningBlock(truncated, true);
                typingEl.appendChild(reasoningEl);
              } else {
                // Update text in place as tokens stream in
                const contentEl = reasoningEl.querySelector('.reasoning-content');
                if (contentEl) contentEl.textContent = truncated;
              }
              updateTypingStatus('Reasoning...');
              chatEl.scrollTop = chatEl.scrollHeight;
            } else if (event.type === 'tool_call') {
              // Show meaningful status for crosschain operations
              let callStatus = `Running ${event.name}…`;
              const a = event.arguments || {};
              if (event.name === 'crosschain_sync') {
                const src = a.sourceChain || a.srcChain || '';
                const dst = a.destinationChain || a.dstChain || '';
                const eq = a.equalizeNav ? ' (auto-calculate equalization amount)' : (a.amount ? ` ${a.amount} ${a.tokenSymbol || ''}` : '');
                callStatus = src && dst ? `Syncing NAV: ${src} → ${dst}${eq}…` : callStatus;
              } else if (event.name === 'crosschain_transfer') {
                const src = a.sourceChain || a.srcChain || '';
                const dst = a.destinationChain || a.dstChain || '';
                const amt = a.amount ? `${a.amount} ${a.tokenSymbol || ''}` : '';
                callStatus = src && dst ? `Bridging ${amt} ${src} → ${dst}…` : callStatus;
              } else if (event.name === 'get_aggregated_nav') {
                callStatus = 'Reading NAV across all chains…';
              }
              updateTypingStatus(callStatus);
            } else if (event.type === 'tool_result') {
              if (event.error) {
                // Show error details inline in the typing indicator, not just status
                updateTypingStatus(`${event.name} failed`);
                let errEl = typingEl.querySelector('.tool-error-block');
                if (!errEl) {
                  errEl = document.createElement('div');
                  errEl.className = 'tool-error-block';
                  errEl.style.cssText = 'margin-top:6px;font-size:0.83em;color:#f87171;border-left:2px solid #f87171;padding-left:8px;white-space:pre-wrap;word-break:break-word;';
                  typingEl.appendChild(errEl);
                }
                errEl.textContent = String(event.result || '').replace(/^Error:\s*/i, '');
                chatEl.scrollTop = chatEl.scrollHeight;
              } else {
                updateTypingStatus(`${event.name} done`);
              }
            } else if (event.type === 'text') {
              // Show the agent's thinking/plan text in real time.
              // Filter out any tool call JSON — only human-readable text belongs here.
              const planText = String(event.content || '').trim();
              const isToolCallJson =
                /<tool_call>/i.test(planText) ||
                /\{\s*"type"\s*:\s*"function"/i.test(planText) ||
                (/\{/.test(planText) && /"name"\s*:/.test(planText) && /"(?:parameters|arguments)"\s*:/.test(planText));
              if (planText && !isToolCallJson) {
                // Reuse existing plan block (overwrite) — prevents duplicate plan display
                // when reasoning text + follow-up produce the same or similar content.
                let planEl = typingEl.querySelector('.plan-block');
                if (!planEl) {
                  planEl = makeReasoningBlock('', true);
                  planEl.classList.add('plan-block');
                  const toggle = planEl.querySelector('.reasoning-toggle');
                  if (toggle) { const nodes = toggle.childNodes; if (nodes[1]) nodes[1].textContent = ' Agent thinking\u2026'; }
                  typingEl.appendChild(planEl);
                }
                const contentEl = planEl.querySelector('.reasoning-content');
                if (contentEl) contentEl.textContent = planText.length > 3000 ? planText.slice(0, 3000) + '...' : planText;
                chatEl.scrollTop = chatEl.scrollHeight;
              }
              updateTypingStatus('Agent thinking...');
            } else if (event.type === 'transaction') {
              updateTypingStatus('Transaction ready');
            } else if (event.type === 'confirmation_required') {
              const txs = event.transactions || [];
              if (txs.length > 0 && !confirmationShown) {
                confirmationShown = true;
                updateTypingStatus('Confirmation required');
                if (txs.length === 1) {
                  showDelegatedConfirmation(txs[0]);
                } else {
                  showMultiDelegatedConfirmation(txs);
                }
              }
            } else if (event.type === 'done') {
              finalResponse = event.response;
            }
          } catch { /* skip malformed events */ }
        }
      }

      // Persist reasoning/thinking/errors from typingEl into the chat
      // BEFORE removing typingEl — otherwise all visible agent output is destroyed.
      const persistBlocks = typingEl.querySelectorAll('.reasoning-block, .plan-block, .tool-error-block');
      const hasToolErrors = typingEl.querySelectorAll('.tool-error-block').length > 0;
      const hasPlanBlocks = typingEl.querySelectorAll('.plan-block').length > 0;
      if (persistBlocks.length > 0) {
        const thinkingMsg = document.createElement('div');
        thinkingMsg.className = 'msg assistant thinking-trace';
        const thinkingContent = document.createElement('div');
        thinkingContent.className = 'msg-content';
        thinkingContent.style.cssText = 'opacity:0.85;font-size:0.9em;';
        for (const block of persistBlocks) {
          if (block.classList.contains('reasoning-block')) {
            // Rebuild with live event listeners — cloneNode(true) copies DOM but not onclick.
            const text = block.querySelector('.reasoning-content')?.textContent || block.textContent || '';
            thinkingContent.appendChild(makeReasoningBlock(text, false));
          } else {
            thinkingContent.appendChild(block.cloneNode(true));
          }
        }
        thinkingMsg.appendChild(thinkingContent);
        chatEl.appendChild(thinkingMsg);
      }

      typingEl.remove();
      if (finalResponse) {
        // Skip reasoning in handleChatResponse — we already persisted it from the stream
        if (persistBlocks.length > 0) delete finalResponse.reasoning;
        // When stream already showed error/plan blocks, suppress duplicate display
        // of the reply text if it matches content we already persisted.
        if ((hasToolErrors || hasPlanBlocks) && finalResponse.reply) {
          const replyLower = (finalResponse.reply || '').toLowerCase();
          const isErrorEcho = replyLower.startsWith('error:') ||
            replyLower.startsWith('⚠️') ||
            replyLower.includes('insufficient') ||
            replyLower.includes('revert') ||
            replyLower.includes('sync failed') ||
            replyLower.includes('blocked') ||
            replyLower.includes('failed');
          if (isErrorEcho) finalResponse.reply = '';
        }
        // Mark that stream already displayed errors — suppress duplicate toolCall rendering
        if (hasToolErrors) finalResponse._streamShowedErrors = true;
        await handleChatResponse(finalResponse, { skipTransactions: confirmationShown });
      }
    } else {
      // Fallback: non-streaming JSON response
      const data = await res.json();
      typingEl.remove();
      await handleChatResponse(data);
    }
  } catch (err) {
    // Persist any reasoning/thinking blocks BEFORE removing typingEl
    // so the user can inspect what the agent was doing when it timed out.
    const persistBlocks = typingEl.querySelectorAll('.reasoning-block, .plan-block, .tool-error-block');
    if (persistBlocks.length > 0) {
      const thinkingMsg = document.createElement('div');
      thinkingMsg.className = 'msg assistant thinking-trace';
      const thinkingContent = document.createElement('div');
      thinkingContent.className = 'msg-content';
      thinkingContent.style.cssText = 'opacity:0.85;font-size:0.9em;';
      for (const block of persistBlocks) {
        if (block.classList.contains('reasoning-block')) {
          const text = block.querySelector('.reasoning-content')?.textContent || block.textContent || '';
          thinkingContent.appendChild(makeReasoningBlock(text, false));
        } else {
          thinkingContent.appendChild(block.cloneNode(true));
        }
      }
      thinkingMsg.appendChild(thinkingContent);
      chatEl.appendChild(thinkingMsg);
    }
    typingEl.remove();
    if (err.name === 'AbortError') {
      if (!userStopped) {
        appendMessage('system', 'Request timed out after 3 minutes. The agent may be overloaded — please try again.');
      }
      // User-initiated stop: just restore state silently
    } else {
      appendMessage('system', `Error: ${err.message}`);
    }
  } finally {
    clearTimeout(timeoutId);
    exitStoppingMode();
    inputEl.focus();
  }
}

/** Handle the parsed API response — display tool results, reply, chain switch, transaction modal */
async function handleChatResponse(data, options = {}) {
  let modelTraceShown = false;
  const withModelTrace = (extras = {}) => {
    if (!modelTraceShown && data.modelsUsed?.length) {
      modelTraceShown = true;
      return { ...extras, modelsUsed: data.modelsUsed, finalModel: data.finalModel };
    }
    return extras;
  };

  // Show reasoning trace (collapsible)
  if (data.reasoning) {
    appendMessage('assistant', '', withModelTrace({ reasoning: data.reasoning }));
  }

  // Show tool results but skip the verbose tool call name/args when a transaction is present.
  // When reply is empty (e.g. autonomous execution), the else-if block below renders tool
  // results as the main message — don't duplicate them here.
  if (data.toolCalls?.length > 0 && !data._streamShowedErrors && data.reply) {
    // Normalize whitespace for comparison: collapse multiple spaces/newlines and trim.
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const suppressEcho = !!(
      data.toolCalls.length === 1 &&
      !data.toolCalls[0].error &&
      normalize(data.toolCalls[0].result) === normalize(data.reply)
    );

    for (const tc of data.toolCalls) {
      if (suppressEcho) continue;
      // Only show the result, not the tool call name/args — the result already describes the swap
      if (tc.result || tc.error) {
        const toolExtras = withModelTrace({
          toolResult: tc.result,
          toolError: tc.error,
        });
        appendMessage('assistant', '', toolExtras);
      }
    }
  }

  if (data.reply) {
    const extras = withModelTrace({ suggestions: data.suggestions });
    if (data.metadata?.gmxPositions) {
      extras.gmxPositions = data.metadata.gmxPositions;
    }
    appendMessage('assistant', data.reply, extras);
    // Store tool results inline so the LLM has full context.
    // IMPORTANT: Do NOT use any bracket/prefix format that looks like a tool call —
    // gpt-4.1-nano reproduced such patterns as text instead of calling actual tools.
    let historyContent = data.reply;
    if (data.toolCalls?.length > 0) {
      const resultsText = data.toolCalls
        .filter(tc => !tc.error && tc.result)
        .map(tc => tc.result)
        .join('\n');
      if (resultsText) {
        historyContent = resultsText + '\n\n' + data.reply;
      }
    }
    conversationHistory.push({ role: 'assistant', content: historyContent });
    persistChat();

    // Detect multi-step plans: auto-progress only fires when the agent
    // signals it has more steps to do (e.g. "Step 1 of 3", "next I'll").
    const stepPattern = /step\s+\d+\s*(of|\/)\s*\d+|next\s+(step|i['']ll|we['']ll)|after\s+this|then\s+(i['']ll|we['']ll)|following\s+step|first,?\s+.*then/i;
    setMultiStepActive(stepPattern.test(data.reply));
  } else if (data.toolCalls?.length > 0) {
    // Reply is empty — still show tool results in the UI and push to history
    const resultsText = data.toolCalls
      .filter(tc => !tc.error && tc.result)
      .map(tc => tc.result)
      .join('\n');
    if (resultsText) {
      const extras = withModelTrace({ suggestions: data.suggestions });
      if (data.metadata?.gmxPositions) {
        extras.gmxPositions = data.metadata.gmxPositions;
      }
      appendMessage('assistant', resultsText, extras);
      conversationHistory.push({ role: 'assistant', content: resultsText });
      persistChat();
    }
  }

  if (data.chainSwitch) {
    setCurrentChainId(data.chainSwitch);
    updateChainDisplay();
    const isTestnet = TESTNET_CHAINS_LIST.some(c => c.id === currentChainId);
    const toggle = document.getElementById('testnet-toggle');
    if (toggle.checked !== isTestnet) {
      toggle.checked = isTestnet;
      applyTestnetState(isTestnet);
      localStorage.setItem('rigoblock_testnet', isTestnet);
    }
    appendMessage('system', `Switched to ${CHAIN_NAMES[data.chainSwitch] || 'chain ' + data.chainSwitch}`);
    // Re-fetch delegation status for the new chain so executionMode is accurate
    await refreshDelegationStatus();
  }

  // Update DEX provider (internal tracking only, no badge)
  if (data.dexProvider) {
    // DEX badge removed — dexProvider tracked internally
  }

  // Ensure execution mode is fresh before deciding how to render transactions.
  // Delegation status may have changed during chain switch or async operations.
  syncExecutionMode();

  if (!options.skipTransactions) {
    // Handle multiple transactions (multi-chain swaps)
    const txList = data.transactions && data.transactions.length > 0
      ? data.transactions
      : data.transaction ? [data.transaction] : [];

    // operatorOnly transactions always go through standard wallet modal
    const anyOperatorOnly = txList.some(tx => tx.operatorOnly);
    if (txList.length > 1 && executionMode === 'delegated' && !anyOperatorOnly) {
      // Multi-transaction delegated mode: show combined card
      console.log('[tx-modal] Showing multi-tx delegated confirmation:', txList.length, 'transactions');
      showMultiDelegatedConfirmation(txList);
    } else if (txList.length > 1 && (executionMode !== 'delegated' || anyOperatorOnly)) {
      // Multi-transaction manual mode: show each as individual in-chat card
      console.log('[tx-modal] Showing multi-tx manual cards:', txList.length, 'transactions');
      for (const tx of txList) {
        showManualTxCard(tx);
      }
    } else if (data.transaction) {
      console.log('[tx-modal] Showing transaction modal:', data.transaction);
      if (executionMode === 'delegated' && !data.transaction.operatorOnly) {
        // In delegated mode: show in-chat confirmation instead of wallet modal
        showDelegatedConfirmation(data.transaction);
      } else {
        showTransactionModal(data.transaction);
      }
    } else if (data.executionResult) {
      // Agent already executed the transaction (delegated auto-execute fallback)
      const r = data.executionResult;
      showTxReceiptCard(r, data.transaction?.swapMeta);
    } else if (data.executionResults && data.executionResults.length > 0) {
      // Agent already executed multiple transactions
      for (const r of data.executionResults) {
        showTxReceiptCard(r);
      }
    } else if (!data.reply && !data.metadata) {
      // Only warn when there's truly nothing useful in the response
      console.log('[tx-modal] No transaction in response:', Object.keys(data));
    }
  }

  // Defensive: if the tool result looks like it should have a transaction but none was found,
  // log details so we can diagnose why the modal/card didn't appear.
  const hasToolTx = data.toolCalls?.some(tc => tc.result?.includes('ready') || tc.result?.includes('Execute'));
  if (hasToolTx && txList.length === 0) {
    console.warn('[tx-modal] Tool result suggests a transaction but txList is empty. data keys:', Object.keys(data), 'toolCalls:', data.toolCalls?.map(tc => tc.name));
  }
}

/* ================================================================
   Transaction confirmation
   ================================================================ */

export { sendMessage, handleChatResponse, autoProgressAfterTx };
