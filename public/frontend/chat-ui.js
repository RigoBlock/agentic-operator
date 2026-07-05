/**
 * Chat UI module — message rendering, rich content, reasoning blocks, direct tool invocation.
 */

import {
  chatEl, inputEl, vaultInput,
  conversationHistory, setConversationHistory,
  currentChainId, connectedAddress, authSignature, authTimestamp,
  escapeHtml, copyToClipboard, apiHeaders,
  setLastGmxPositions, executionMode, delegationState, autoExecuteMode,
  setAuthSignature, setAuthTimestamp,
} from "./state.js";

import { openWalletPicker, signAuthMessage, authKey } from "./wallet.js";

import { showTransactionModal } from "./tx-modal.js";

function makeReasoningBlock(text, startOpen = false) {
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

  if (role === 'assistant' && (content || extras?.gmxPositions?.length > 0)) {
    // Rich rendering: markdown tables + clickable links
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.innerHTML = renderRichContent(content || '');
    div.appendChild(contentDiv);
  } else if (content) {
    div.textContent = content;
  }

  // On restore, skip dynamic one-shot elements (tx actions, suggestion chips)
  // but still enhance GMX tables if we have cached position data.
  if (isRestore) {
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
    if (extras?.gmxPositions?.length > 0) {
      enhanceGmxPositions(div, extras.gmxPositions);
    }
    return;
  }

  if (extras?.toolCall) {
    const tc = document.createElement('div');
    tc.className = 'tool-call';
    tc.textContent = `⚡ ${extras.toolCall.name}(${JSON.stringify(extras.toolCall.args, null, 2)})`;
    div.appendChild(tc);
  }
  if (extras?.reasoning) {
    div.appendChild(makeReasoningBlock(extras.reasoning));
  }
  if (extras?.toolResult) {
    const tr = document.createElement('div');
    tr.className = `tool-result ${extras.toolError ? 'error-result' : ''}`;
    tr.textContent = extras.toolResult;
    div.appendChild(tr);
  }
  if (extras?.transaction && !isRestore) {
    const tx = extras.transaction;
    const actionDiv = document.createElement('div');
    actionDiv.className = 'tx-actions';
    actionDiv.style.marginTop = '12px';
    const execBtn = document.createElement('button');
    execBtn.className = 'btn-confirm';
    execBtn.textContent = tx.description?.toLowerCase().includes('gmx') ? 'Execute Position Change'
      : tx.description?.toLowerCase().includes('deploy') ? 'Deploy'
      : tx.description?.toLowerCase().includes('liquidity') ? 'Add Liquidity'
      : 'Execute';
    execBtn.onclick = () => showTransactionModal(tx);
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn-cancel';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = () => actionDiv.remove();
    actionDiv.appendChild(execBtn);
    actionDiv.appendChild(dismissBtn);
    div.appendChild(actionDiv);
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
          window.sendMessage();
        }
      };
      chips.appendChild(chip);
    }
    div.appendChild(chips);
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  // Post-process GMX positions message to add inline action buttons
  if (extras?.gmxPositions?.length > 0) {
    setLastGmxPositions(extras.gmxPositions);
    enhanceGmxPositions(div, extras.gmxPositions);
  }

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
      html += '</table>';
      inTable = false;
    }

    // Regular line: convert markdown links, escape, then linkify raw URLs
    const placeholders = [];
    let processed = line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, text, url) => {
      const key = `__MDLINK_${placeholders.length}__`;
      placeholders.push(`<a href="${url}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`);
      return key;
    });
    processed = escapeHtml(processed);
    processed = linkifyUrls(processed);
    processed = processed.replace(/__MDLINK_(\d+)__/g, (match, idx) => placeholders[idx]);
    html += processed + '\n';
  }

  if (inTable) html += '</table>';
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
  // Exact-match chips that bypass the LLM entirely
  const lower = label.toLowerCase().trim();
  if (lower === 'refresh positions') {
    return { toolName: 'gmx_get_positions', args: {} };
  }
  if (lower === 'show gmx markets') {
    return { toolName: 'gmx_get_markets', args: {} };
  }
  if (lower === 'open new position' || lower === 'open a position') {
    return { toolName: 'gmx_increase_position', args: {} };
  }
  if (lower === 'open a long') {
    return { toolName: 'gmx_increase_position', args: { isLong: true } };
  }
  if (lower === 'open a short') {
    return { toolName: 'gmx_increase_position', args: { isLong: false } };
  }

  // GMX position action chips: "<Action> <SYMBOL> <long|short>"
  const gmxMatch = label.match(/^(Close|Increase|Decrease|Add collateral to|Withdraw collateral from)\s+(\S+)\s+(long|short)$/i);
  if (gmxMatch) {
    const action = gmxMatch[1].toLowerCase();
    const market = gmxMatch[2].toUpperCase();
    const isLong = gmxMatch[3].toLowerCase() === 'long';
    if (action === 'close') {
      return { toolName: 'gmx_decrease_position', args: { market, isLong } };
    }
    if (action === 'increase') {
      return { toolName: 'gmx_increase_position', args: { market, isLong } };
    }
    if (action === 'decrease') {
      return { toolName: 'gmx_decrease_position', args: { market, isLong } };
    }
    if (action === 'add collateral to') {
      return { toolName: 'gmx_increase_position', args: { market, isLong, sizeDeltaUsd: '0' } };
    }
    if (action === 'withdraw collateral from') {
      return { toolName: 'gmx_decrease_position', args: { market, isLong, sizeDeltaUsd: '0' } };
    }
  }
  return null;
}

/**
 * Directly invoke a tool via /api/tools with prompt-based param collection.
 */
function formatDirectToolLabel(toolName, args) {
  if (toolName === 'gmx_decrease_position') {
    const side = args.isLong ? 'long' : 'short';
    if (args.sizeDeltaUsd === '0' && args.collateralDeltaAmount) {
      return `Withdraw collateral from ${args.market} ${side}`;
    }
    return `Close ${args.market} ${side}`;
  }
  if (toolName === 'gmx_increase_position') {
    const side = args.isLong ? 'long' : 'short';
    if (args.sizeDeltaUsd === '0') return `Add collateral to ${args.market} ${side}`;
    return `Increase ${args.market} ${side}`;
  }
  if (toolName === 'build_vault_swap') {
    return `Swap ${args.amountIn} ${args.tokenIn} → ${args.tokenOut}`;
  }
  if (toolName === 'gmx_get_positions') return 'Refresh GMX positions';
  if (toolName === 'gmx_claim_funding_fees') return 'Claim GMX funding fees';
  if (toolName === 'crosschain_transfer') return `Bridge ${args.amount} ${args.token} to ${args.destinationChain}`;
  if (toolName === 'deploy_smart_pool') return `Deploy pool: ${args.name}`;
  if (toolName === 'fund_pool') return `Fund pool with ${args.amount} ${args.token}`;
  if (toolName === 'setup_delegation') return 'Set up delegation';
  if (toolName === 'revoke_delegation') return 'Revoke delegation';
  if (toolName === 'add_liquidity') return `Add liquidity: ${args.tokenA}/${args.tokenB}`;
  if (toolName === 'remove_liquidity') return `Remove liquidity: ${args.tokenA}/${args.tokenB}`;
  if (toolName === 'grg_stake') return `Stake ${args.amount} GRG`;
  if (toolName === 'grg_unstake') return `Unstake ${args.amount} GRG`;
  if (toolName === 'grg_claim_rewards') return 'Claim GRG rewards';
  return toolName.replace(/_/g, ' ');
}

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
  if (toolInfo.toolName === 'gmx_decrease_position') {
    if (!args.market) {
      const market = prompt('Market symbol to decrease (e.g. ETH):');
      if (market === null) return;
      const trimmed = market.trim().toUpperCase();
      if (!trimmed) {
        appendMessage('system', 'Market symbol is required.');
        return;
      }
      args.market = trimmed;
    }
    if (args.isLong === undefined) {
      const side = prompt('Side (long or short):');
      if (side === null) return;
      const s = side.trim().toLowerCase();
      if (s !== 'long' && s !== 'short') {
        appendMessage('system', 'Side must be "long" or "short".');
        return;
      }
      args.isLong = s === 'long';
    }
    if (!args.sizeDeltaUsd) {
      // Default to full close — user can type a partial close in chat if needed
      args.sizeDeltaUsd = 'all';
    }
    // Only prompt for collateral withdraw amount if caller didn't already provide it
    if (args.sizeDeltaUsd === '0' && !args.collateralDeltaAmount) {
      const col = prompt('Amount of collateral to withdraw:');
      if (col === null) return;
      args.collateralDeltaAmount = col.trim();
    }
  }
  if (toolInfo.toolName === 'gmx_increase_position') {
    if (!args.market) {
      const market = prompt('Market symbol to trade (e.g. ETH):');
      if (market === null) return;
      const trimmed = market.trim().toUpperCase();
      if (!trimmed) {
        appendMessage('system', 'Market symbol is required.');
        return;
      }
      args.market = trimmed;
    }
    if (args.isLong === undefined) {
      const side = prompt('Side (long or short):');
      if (side === null) return;
      const s = side.trim().toLowerCase();
      if (s !== 'long' && s !== 'short') {
        appendMessage('system', 'Side must be "long" or "short".');
        return;
      }
      args.isLong = s === 'long';
    }
    // Pure collateral add (sizeDeltaUsd already set to '0' by caller)
    if (args.sizeDeltaUsd === '0' && !args.collateralAmount) {
      const col = prompt('Collateral amount to add:');
      if (col === null) return;
      args.collateralAmount = col.trim();
    }
    // Fallback: if caller didn't set notionalUsd or sizeDeltaUsd, prompt once
    if (!args.notionalUsd && !args.sizeDeltaUsd && !args.collateralAmount) {
      const notional = prompt('USD amount to increase:');
      if (notional === null) return;
      args.notionalUsd = notional.trim();
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
    // If delegated mode is active and delegation is confirmed on this chain,
    // auto-execute ONLY when in autonomous mode. In confirm-trades mode, the
    // user must review and approve each action before execution.
    const isDelegated = delegationState && (delegationState.enabled || delegationState.isActiveOnChain);
    const isAutonomous = autoExecuteMode === 'autonomous';
    if (executionMode === 'delegated' && isDelegated && isAutonomous) {
      body.executionMode = 'delegated';
      body.confirmExecution = true;
    }
  }

  appendMessage('user', `🔧 ${formatDirectToolLabel(toolInfo.toolName, args)}`);

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
      // Auth expired — clear cached signature and prompt user to re-sign
      if (res.status === 401 && authSignature) {
        setAuthSignature(null);
        setAuthTimestamp(null);
        localStorage.removeItem(authKey(connectedAddress));
        appendMessage('system', '🔐 Session expired. Please sign the authentication message to continue.');
        await signAuthMessage();
        if (authSignature) {
          // Retry the same tool call with fresh auth
          return invokeDirectTool(toolInfo);
        }
        appendMessage('system', 'Sign cancelled. Please try again.');
        return;
      }
      appendMessage('assistant', `❌ Error: ${data.error || data.message || 'Unknown error'}`, { toolError: true });
      return;
    }
    // Show the tool result message
    const msg = data.message || data.reply || JSON.stringify(data);
    const extras = {};
    if (data.metadata?.gmxPositions) {
      extras.gmxPositions = data.metadata.gmxPositions;
    }
    if (data.suggestions) {
      extras.suggestions = data.suggestions;
    }
    appendMessage('assistant', msg, extras);
    // In delegated confirm-trades mode, show the delegated confirmation card
    // instead of manual wallet-sign buttons.
    if (data.transaction && executionMode === 'delegated' && !data.transaction.operatorOnly) {
      window.showDelegatedConfirmation(data.transaction);
    } else if (data.transaction) {
      // Manual mode or operator-only: show standard wallet modal
      showTransactionModal(data.transaction);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    appendMessage('system', `Direct tool call failed: ${err.message}`);
  }
}


/**
 * Enhance a GMX positions message with inline action buttons.
 * Replaces the plain markdown table with an interactive version:
 * - Refresh button above the table
 * - Expandable per-row details (size in tokens, collateral, fee breakdown)
 * - Actions dropdown per position (increase/decrease size, add/withdraw collateral, close)
 */
function enhanceGmxPositions(msgDiv, positions) {
  const contentDiv = msgDiv.querySelector('.msg-content');
  if (!contentDiv) return;

  // Idempotent: skip if already enhanced
  if (contentDiv.dataset.gmxEnhanced === 'true') return;

  // Find the positions table (first table after the summary line)
  const posTable = contentDiv.querySelector('table');
  if (!posTable) return;
  const rows = posTable.querySelectorAll('tr');
  if (rows.length < 2) return; // header + at least one data row

  // Skip header row
  const dataRows = Array.from(rows).slice(1);
  if (dataRows.length !== positions.length) return;

  // Add subtle refresh link above the table
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'gmx-refresh-btn';
  refreshBtn.textContent = '🔄 Refresh';
  refreshBtn.title = 'Update positions (no LLM cost)';
  refreshBtn.onclick = () => refreshGmxPositions(msgDiv);
  posTable.parentElement.insertBefore(refreshBtn, posTable);

  // Add Actions header cell
  const headerRow = rows[0];
  const actionsTh = document.createElement('th');
  actionsTh.textContent = 'Actions';
  headerRow.appendChild(actionsTh);

  // Enhance each data row
  dataRows.forEach((row, idx) => {
    const pos = positions[idx];
    if (!pos) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 9) return;

    const market = pos.indexTokenSymbol;
    const isLong = pos.isLong;
    const collateralSymbol = pos.collateralSymbol;

    // Expand icon in the Market cell — toggles the fee-breakdown details row
    const marketCell = cells[0];
    const expandIcon = document.createElement('span');
    expandIcon.className = 'gmx-expand-icon';
    expandIcon.textContent = '▶';
    expandIcon.title = 'Show fee breakdown';
    marketCell.insertBefore(expandIcon, marketCell.firstChild);

    const detailsRow = document.createElement('tr');
    detailsRow.className = 'gmx-details-row';
    detailsRow.style.display = 'none';
    const detailsTd = document.createElement('td');
    detailsTd.colSpan = 10;
    detailsTd.innerHTML = buildGmxDetailsHtml(pos);
    detailsRow.appendChild(detailsTd);
    row.parentNode.insertBefore(detailsRow, row.nextSibling);

    expandIcon.onclick = (e) => {
      e.stopPropagation();
      const isOpen = detailsRow.style.display !== 'none';
      detailsRow.style.display = isOpen ? 'none' : 'table-row';
      expandIcon.textContent = isOpen ? '▶' : '▼';
    };

    // Actions dropdown cell
    const actionsCell = document.createElement('td');
    actionsCell.style.position = 'relative';
    const actionsBtn = document.createElement('button');
    actionsBtn.className = 'gmx-action-btn actions';
    actionsBtn.textContent = '⋯';
    actionsBtn.title = 'Position actions';
    actionsCell.appendChild(actionsBtn);

    const menu = document.createElement('div');
    menu.className = 'gmx-cell-menu';
    const menuItems = [
      { label: '▲ Increase size', action: () => modifyGmxSize(market, isLong, 'increase', collateralSymbol) },
      { label: '▼ Decrease size', action: () => modifyGmxSize(market, isLong, 'decrease', collateralSymbol) },
      { label: '+ Add collateral', action: () => modifyGmxCollateral(market, isLong, 'add', collateralSymbol) },
      { label: '− Withdraw collateral', action: () => modifyGmxCollateral(market, isLong, 'withdraw', collateralSymbol) },
      { label: '✕ Close position', action: () => closeGmxPosition(market, isLong, collateralSymbol), danger: true },
    ];
    for (const item of menuItems) {
      const btn = document.createElement('button');
      btn.className = 'gmx-menu-item' + (item.danger ? ' danger' : '');
      btn.textContent = item.label;
      btn.onclick = (e) => {
        e.stopPropagation();
        menu.style.display = 'none';
        item.action();
      };
      menu.appendChild(btn);
    }
    actionsCell.appendChild(menu);

    actionsBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.gmx-cell-menu').forEach(m => {
        if (m !== menu) m.style.display = 'none';
      });
      menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    };

    document.addEventListener('click', (e) => {
      if (!actionsCell.contains(e.target)) {
        menu.style.display = 'none';
      }
    });

    row.appendChild(actionsCell);

    // Net PnL cell — color by gain/loss
    const pnlCell = cells[5];
    const pnlValue = parseFloat(pos.unrealizedPnl.replace(/[^0-9.-]/g, '')) || 0;
    pnlCell.style.color = pnlValue >= 0 ? 'var(--success)' : 'var(--error)';
    pnlCell.style.fontWeight = '600';
  });

  contentDiv.dataset.gmxEnhanced = 'true';
}

/** Build the HTML for an expandable per-position fee breakdown. */
function buildGmxDetailsHtml(pos) {
  const rows = [
    ['Size (tokens)', `${pos.sizeInTokens} ${pos.indexTokenSymbol}`],
    ['Collateral', `${pos.collateralAmount} ${pos.collateralSymbol}`],
    ['Gross PnL', pos.grossPnl],
    ['Net price impact', pos.priceImpact],
    ['Borrow fee', pos.borrowingFee],
    ['Funding fee', pos.fundingFee],
    ['Close fee', pos.closeFee],
    ['Liq. price', pos.liquidationPrice],
  ];
  if (pos.uiFee && pos.uiFee !== '$0.00') {
    rows.push(['UI fee', pos.uiFee]);
  }
  rows.push(['Net costs', pos.totalCosts]);

  const grid = rows.map(([k, v]) =>
    `<div class="gmx-detail"><span class="gmx-detail-key">${k}:</span> <span class="gmx-detail-value">${v}</span></div>`
  ).join('');
  return `<div class="gmx-details-grid">${grid}</div>`;
}

function closeGmxPosition(market, isLong, collateralSymbol) {
  invokeDirectTool({ toolName: 'gmx_decrease_position', args: { market, isLong, collateral: collateralSymbol } });
}

function modifyGmxSize(market, isLong, mode, collateralSymbol) {
  if (mode === 'increase') {
    const amount = prompt('USD amount to increase:');
    if (amount === null) return;
    const trimmed = amount.trim();
    if (!trimmed || isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0) {
      window.appendMessage('system', 'Invalid amount. Please enter a positive number.');
      return;
    }
    invokeDirectTool({ toolName: 'gmx_increase_position', args: { market, isLong, collateral: collateralSymbol, notionalUsd: trimmed } });
  } else {
    const amount = prompt('USD amount to decrease:');
    if (amount === null) return;
    const trimmed = amount.trim();
    if (!trimmed || isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0) {
      window.appendMessage('system', 'Invalid amount. Please enter a positive number.');
      return;
    }
    invokeDirectTool({ toolName: 'gmx_decrease_position', args: { market, isLong, collateral: collateralSymbol, sizeDeltaUsd: trimmed } });
  }
}

function sanitizeAmountInput(input) {
  if (!input) return '';
  const trimmed = input.trim();
  // Extract leading decimal number, ignoring trailing text like "WETH" or "USDC"
  const match = trimmed.match(/^(?:\d+\.?\d*|\.\d+)/);
  return match ? match[0] : trimmed;
}

function modifyGmxCollateral(market, isLong, mode, collateralSymbol) {
  if (mode === 'add') {
    const amount = prompt('Collateral amount to add:');
    if (amount === null) return;
    const trimmed = sanitizeAmountInput(amount);
    if (!trimmed || isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0) {
      window.appendMessage('system', 'Invalid amount. Please enter a positive number.');
      return;
    }
    invokeDirectTool({ toolName: 'gmx_increase_position', args: { market, isLong, collateral: collateralSymbol, sizeDeltaUsd: '0', collateralAmount: trimmed } });
  } else {
    const amount = prompt('Collateral amount to withdraw:');
    if (amount === null) return;
    const trimmed = sanitizeAmountInput(amount);
    if (!trimmed || isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0) {
      window.appendMessage('system', 'Invalid amount. Please enter a positive number.');
      return;
    }
    invokeDirectTool({ toolName: 'gmx_decrease_position', args: { market, isLong, collateral: collateralSymbol, sizeDeltaUsd: '0', collateralDeltaAmount: trimmed } });
  }
}

// DEPRECATED: GMX v2 has no standalone "withdraw unrealized PnL" function.
// Removed to prevent confusion. PnL is realized on close/decrease.

async function refreshGmxPositions(msgDiv) {
  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42) {
    window.appendMessage('system', 'Please enter a vault address first.');
    return;
  }

  const contentDiv = msgDiv.querySelector('.msg-content');
  if (!contentDiv) return;

  // Save current content for rollback on error
  const originalHtml = contentDiv.innerHTML;
  contentDiv.innerHTML = '<div style="color:var(--muted);font-style:italic;padding:4px 0;">🔄 Refreshing…</div>';

  try {
    const body = {
      arguments: {},
      chainId: 42161,
      vaultAddress: vault,
    };
    if (connectedAddress && authSignature) {
      body.operatorAddress = connectedAddress;
      body.authSignature = authSignature;
      body.authTimestamp = authTimestamp;
    }
    const res = await fetch('/api/tools?toolName=gmx_get_positions', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      contentDiv.innerHTML = originalHtml;
      window.appendMessage('system', `❌ Failed to refresh: ${data.error || data.message || 'Unknown error'}`);
      return;
    }

    const msg = data.message || data.reply || JSON.stringify(data);
    contentDiv.innerHTML = renderRichContent(msg);
    contentDiv.removeAttribute('data-gmx-enhanced');

    if (data.metadata?.gmxPositions?.length > 0) {
      setLastGmxPositions(data.metadata.gmxPositions);
      enhanceGmxPositions(msgDiv, data.metadata.gmxPositions);
    }

    // Update suggestion chips in-place if present
    const oldChips = msgDiv.querySelector('.suggestions');
    if (oldChips) oldChips.remove();
    if (data.suggestions?.length > 0) {
      const chips = document.createElement('div');
      chips.className = 'suggestions';
      for (const label of data.suggestions) {
        const chip = document.createElement('button');
        chip.className = 'suggestion-chip';
        chip.textContent = label;
        chip.onclick = () => {
          const direct = parseDirectToolCall(label);
          if (direct) invokeDirectTool(direct);
          else { inputEl.value = label; window.sendMessage(); }
        };
        chips.appendChild(chip);
      }
      msgDiv.appendChild(chips);
    }
  } catch (err) {
    contentDiv.innerHTML = originalHtml;
    window.appendMessage('system', `❌ Refresh failed: ${err.message}`);
  }
}

export {
  appendMessage, renderRichContent, makeReasoningBlock,
  linkifyMarkdownInCell, linkifyUrls,
  parseDirectToolCall, invokeDirectTool,
  enhanceGmxPositions, closeGmxPosition, modifyGmxSize,
  modifyGmxCollateral, refreshGmxPositions,
};
