/**
 * Chat UI module — message rendering, rich content, reasoning blocks, direct tool invocation.
 */

import {
  chatEl, inputEl, vaultInput,
  conversationHistory, setConversationHistory,
  currentChainId, connectedAddress, authSignature, authTimestamp,
  escapeHtml, copyToClipboard, apiHeaders,
} from "./state.js";

function makeReasoningBlock(text, startOpen = true) {
  const block = document.createElement('div');
  block.className = 'reasoning-block';
  const toggle = document.createElement('button');
  toggle.className = 'reasoning-toggle';
  toggle.innerHTML = `<span class="arrow${startOpen ? ' open' : ''}">▶</span> Reasoning`;
  const contentEl = document.createElement('div');
  contentEl.className = 'reasoning-content' + (startOpen ? ' open' : '');
  contentEl.textContent = text;
  toggle.onclick = () => {
    const isOpen = contentEl.classList.toggle('open');
    toggle.querySelector('.arrow').classList.toggle('open', isOpen);
  };
  block.appendChild(toggle);
  block.appendChild(contentEl);
  return block;
}

function appendMessage(role, content, extras, isRestore) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  if (role === 'assistant' && content) {
    // Rich rendering: markdown tables + clickable links
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.innerHTML = renderRichContent(content);
    div.appendChild(contentDiv);
  } else if (content) {
    div.textContent = content;
  }

  // Skip interactive elements (tool calls, tx cards, suggestions) on restore
  if (isRestore) {
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
    return;
  }

  if (extras?.toolCall) {
    const tc = document.createElement('div');
    tc.className = 'tool-call';
    tc.textContent = `⚡ ${extras.toolCall.name}(${JSON.stringify(extras.toolCall.args, null, 2)})`;
    div.appendChild(tc);
  }
  if (extras?.reasoning) {
    div.appendChild(makeReasoningBlock(extras.reasoning, true));
  }
  if (extras?.toolResult) {
    const tr = document.createElement('div');
    tr.className = `tool-result ${extras.toolError ? 'error-result' : ''}`;
    tr.textContent = extras.toolResult;
    div.appendChild(tr);
  }
  // model trace intentionally not shown to users
  if (extras?.suggestions?.length) {
    const chips = document.createElement('div');
    chips.className = 'suggestions';
    for (const label of extras.suggestions) {
      const chip = document.createElement('button');
      chip.className = 'suggestion-chip';
      chip.textContent = label;
      chip.onclick = () => {
        const direct = parseDirectToolCall(label);
        if (direct) {
          invokeDirectTool(direct);
        } else {
          inputEl.value = label;
          sendMessage();
        }
      };
      chips.appendChild(chip);
    }
    div.appendChild(chips);
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

/**
 * Render assistant text with markdown tables and clickable URLs.
 * Sanitizes HTML entities first, then processes patterns.
 */
function renderRichContent(text) {
  const lines = text.split('\n');
  let html = '';
  let inTable = false;
  let isHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect markdown table rows: | ... | ... |
    if (/^\|(.+)\|$/.test(line.trim())) {
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());

      // Skip separator rows (|---|---|)
      if (cells.every(c => /^[-:]+$/.test(c))) {
        continue;
      }

      if (!inTable) {
        html += '<table>';
        inTable = true;
        isHeader = true;
      }

      const tag = isHeader ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${linkifyMarkdownInCell(escapeHtml(c))}</${tag}>`).join('') + '</tr>';
      if (isHeader) isHeader = false;
      continue;
    }

    // Close table if we were in one
    if (inTable) {
      html += '</table></div>';
      inTable = false;
    }

    // Regular line: escape then linkify URLs
    html += linkifyUrls(escapeHtml(line)) + '\n';
  }

  if (inTable) html += '</table></div>';
  return html;
}

function linkifyMarkdownInCell(str) {
  return str.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function linkifyUrls(str) {
  return str.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

/**
 * Parse a suggestion chip label to see if it should bypass the LLM and
 * directly invoke a tool via /api/tools.
 * Returns null for normal chat-flow chips.
 */
function parseDirectToolCall(label) {
  // GMX position action chips: "<Action> <SYMBOL> <long|short>"
  const gmxMatch = label.match(/^(Close|Increase|Decrease|Add collateral to|Withdraw collateral from)\s+(\S+)\s+(long|short)$/i);
  if (gmxMatch) {
    const action = gmxMatch[1].toLowerCase();
    const market = gmxMatch[2].toUpperCase();
    const isLong = gmxMatch[3].toLowerCase() === 'long';
    if (action === 'close') {
      return { toolName: 'gmx_close_position', args: { market, isLong } };
    }
    if (action === 'increase') {
      return { toolName: 'gmx_increase_position', args: { market, isLong } };
    }
    if (action === 'decrease') {
      return { toolName: 'gmx_close_position', args: { market, isLong } };
    }
    if (action === 'add collateral to') {
      return { toolName: 'gmx_increase_position', args: { market, isLong, sizeDeltaUsd: '0' } };
    }
    if (action === 'withdraw collateral from') {
      return { toolName: 'gmx_close_position', args: { market, isLong, sizeDeltaUsd: '0' } };
    }
  }
  return null;
}

/**
 * Directly invoke a tool via /api/tools with prompt-based param collection.
 */
async function invokeDirectTool(toolInfo) {
  if (!connectedAddress) {
    appendMessage('system', '👛 Please connect your wallet first.');
    openWalletPicker();
    return;
  }
  const vault = vaultInput.value.trim();
  const effectiveVault = (vault && vault.length === 42) ? vault : '0x0000000000000000000000000000000000000000';

  // Ensure auth for vault owners
  const statusEl = document.getElementById('vault-status');
  const isOwner = !!(vault && vault.length === 42)
    && !!(statusEl && statusEl.textContent.includes('(owned)') && !statusEl.className.includes('error'));
  if (isOwner && !authSignature) {
    appendMessage('system', 'Signing authentication…');
    await signAuthMessage();
    if (!authSignature) {
      appendMessage('system', 'Sign cancelled. Please try again.');
      return;
    }
  }

  const args = { ...toolInfo.args };

  // Prompt for missing params based on tool
  if (toolInfo.toolName === 'gmx_close_position') {
    if (!args.sizeDeltaUsd) {
      const size = prompt(`Size to close in USD (e.g., 5000). Leave empty or type "all" to close fully:`);
      if (size === null) return; // cancelled
      args.sizeDeltaUsd = size.trim() || 'all';
    }
    if (args.sizeDeltaUsd === '0') {
      const col = prompt('Amount of collateral to withdraw:');
      if (col === null) return;
      args.collateralDeltaAmount = col.trim();
    }
  }
  if (toolInfo.toolName === 'gmx_increase_position') {
    if (args.sizeDeltaUsd === '0') {
      // Pure collateral add
      const col = prompt('Amount of collateral to add:');
      if (col === null) return;
      args.collateralAmount = col.trim();
    } else {
      const mode = prompt('Increase by: (1) notional USD amount, (2) size delta USD, (3) collateral amount + leverage');
      if (mode === null) return;
      const m = mode.trim();
      if (m === '1') {
        const notional = prompt('Additional notional size in USD (e.g., 1500):');
        if (notional === null) return;
        args.notionalUsd = notional.trim();
      } else if (m === '2') {
        const size = prompt('Additional size delta in USD (e.g., 1500):');
        if (size === null) return;
        args.sizeDeltaUsd = size.trim();
      } else if (m === '3') {
        const col = prompt('Collateral amount to add:');
        if (col === null) return;
        args.collateralAmount = col.trim();
        const lev = prompt('Leverage multiplier (e.g., 5):');
        if (lev === null) return;
        args.leverage = lev.trim();
      } else {
        appendMessage('system', 'Invalid choice. Please type 1, 2, or 3.');
        return;
      }
    }
  }

  const body = {
    arguments: args,
    chainId: 42161, // GMX is Arbitrum-only
    vaultAddress: effectiveVault,
  };
  if (isOwner && authSignature) {
    body.operatorAddress = connectedAddress;
    body.authSignature = authSignature;
    body.authTimestamp = authTimestamp;
  }

  appendMessage('user', `🔧 Direct: ${toolInfo.toolName}(${JSON.stringify(args)})`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`/api/tools?toolName=${toolInfo.toolName}`, {
      method: 'POST',
      headers: apiHeaders(),
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (!res.ok) {
      appendMessage('assistant', `❌ Error: ${data.error || data.message || 'Unknown error'}`, { toolError: true });
      return;
    }
    // Show the tool result message
    const msg = data.message || data.reply || JSON.stringify(data);
    const extras = {};
    if (data.transaction) {
      extras.toolResult = msg;
      appendMessage('assistant', msg, extras);
      // Open tx modal for signing
      showTransactionModal(data.transaction);
    } else {
      appendMessage('assistant', msg, extras);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    appendMessage('system', `Direct tool call failed: ${err.message}`);
  }
}


export {
  appendMessage, renderRichContent, makeReasoningBlock,
  parseDirectToolCall, invokeDirectTool,
};
