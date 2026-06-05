/**
 * Chat UI module — message rendering, rich content, reasoning blocks, direct tool invocation.
 */

import {
  chatEl, inputEl, vaultInput,
  conversationHistory, setConversationHistory,
  currentChainId, connectedAddress, authSignature, authTimestamp,
  escapeHtml, copyToClipboard, apiHeaders,
} from "./state.js";

import { openWalletPicker, signAuthMessage } from "./wallet.js";

import { showTransactionModal } from "./tx-modal.js";

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
  if (!isRestore && extras?.gmxPositions?.length > 0) {
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
function formatDirectToolLabel(toolName, args) {
  if (toolName === 'gmx_close_position') {
    const side = args.isLong ? 'long' : 'short';
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
  if (toolInfo.toolName === 'gmx_close_position') {
    if (!args.sizeDeltaUsd) {
      // Default to full close — user can type a partial close in chat if needed
      args.sizeDeltaUsd = 'all';
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
      appendMessage('assistant', `❌ Error: ${data.error || data.message || 'Unknown error'}`, { toolError: true });
      return;
    }
    // Show the tool result message
    const msg = data.message || data.reply || JSON.stringify(data);
    const extras = {};
    if (data.transaction) {
      extras.transaction = data.transaction;
    }
    if (data.metadata?.gmxPositions) {
      extras.gmxPositions = data.metadata.gmxPositions;
    }
    if (data.suggestions) {
      extras.suggestions = data.suggestions;
    }
    appendMessage('assistant', msg, extras);
  } catch (err) {
    clearTimeout(timeoutId);
    appendMessage('system', `Direct tool call failed: ${err.message}`);
  }
}


/**
 * Enhance a GMX positions message with inline action buttons.
 * Replaces the plain markdown table with an interactive version:
 * - Refresh PnL button at the top
 * - Close button per position
 * - Size / Collateral / PnL cells are interactive (hover on desktop, click on mobile)
 */
function enhanceGmxPositions(msgDiv, positions) {
  const contentDiv = msgDiv.querySelector('.msg-content');
  if (!contentDiv) return;

  // Find the positions table (first table after the summary line)
  const tables = contentDiv.querySelectorAll('table');
  if (tables.length === 0) return;

  const posTable = tables[0];
  const rows = posTable.querySelectorAll('tr');
  if (rows.length < 2) return; // header + at least one data row

  // Skip header row
  const dataRows = Array.from(rows).slice(1);
  if (dataRows.length !== positions.length) return;

  // Add refresh button above the table
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'gmx-refresh-btn';
  refreshBtn.textContent = '🔄 Refresh Positions';
  refreshBtn.title = 'Update positions, PnL, size, collateral, leverage and mark price (no LLM cost)';
  refreshBtn.onclick = () => refreshGmxPositions();
  posTable.parentElement.insertBefore(refreshBtn, posTable);

  // Enhance each data row
  dataRows.forEach((row, idx) => {
    const pos = positions[idx];
    if (!pos) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 8) return;

    const market = pos.indexTokenSymbol;
    const isLong = pos.isLong;

    // Add Close button as last cell
    const closeCell = document.createElement('td');
    closeCell.innerHTML = `<button class="gmx-action-btn close" title="Close position">✕</button>`;
    closeCell.querySelector('button').onclick = () => closeGmxPosition(market, isLong);
    row.appendChild(closeCell);

    // Make Size cell interactive
    const sizeCell = cells[2];
    makeInteractiveCell(sizeCell, [
      { label: '▲ Increase', action: () => modifyGmxSize(market, isLong, 'increase') },
      { label: '▼ Decrease', action: () => modifyGmxSize(market, isLong, 'decrease') },
    ]);

    // Make Collateral cell interactive
    const colCell = cells[3];
    makeInteractiveCell(colCell, [
      { label: '+ Add', action: () => modifyGmxCollateral(market, isLong, 'add') },
      { label: '− Withdraw', action: () => modifyGmxCollateral(market, isLong, 'withdraw') },
    ]);

    // PnL cell — info tooltip only (GMX v2 has no separate "withdraw unrealized PnL" operation)
    const pnlCell = cells[7];
    const pnlValue = parseFloat(pos.unrealizedPnl.replace(/[^0-9.-]/g, '')) || 0;
    if (pnlValue !== 0) {
      pnlCell.title = pnlValue > 0
        ? 'Positive PnL is realized when you close or decrease the position. Use Collateral → Withdraw to reduce collateral without changing size.'
        : 'Negative PnL is realized when you close or decrease the position.';
      pnlCell.style.cursor = 'help';
    }
  });

  // Add Close header cell
  const headerRow = rows[0];
  const th = document.createElement('th');
  th.textContent = 'Close';
  headerRow.appendChild(th);
}

/** Wrap a table cell with an interactive tooltip menu */
function makeInteractiveCell(cell, actions) {
  cell.classList.add('gmx-interactive-cell');
  cell.style.cursor = 'pointer';

  const menu = document.createElement('div');
  menu.className = 'gmx-cell-menu';
  for (const act of actions) {
    const btn = document.createElement('button');
    btn.className = 'gmx-menu-item' + (act.disabled ? ' disabled' : '');
    btn.textContent = act.label;
    btn.title = act.title || '';
    if (!act.disabled) {
      btn.onclick = (e) => {
        e.stopPropagation();
        menu.style.display = 'none';
        act.action();
      };
    }
    menu.appendChild(btn);
  }
  cell.appendChild(menu);

  // Toggle menu on click (works for both desktop and mobile)
  cell.addEventListener('click', (e) => {
    // Close any other open menus
    document.querySelectorAll('.gmx-cell-menu').forEach(m => {
      if (m !== menu) m.style.display = 'none';
    });
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!cell.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
}

function closeGmxPosition(market, isLong) {
  invokeDirectTool({ toolName: 'gmx_close_position', args: { market, isLong } });
}

function modifyGmxSize(market, isLong, mode) {
  if (mode === 'increase') {
    invokeDirectTool({ toolName: 'gmx_increase_position', args: { market, isLong } });
  } else {
    // Decrease — ask user for the USD amount to reduce
    const amount = prompt('Size to decrease in USD (e.g., 500):');
    if (amount === null) return;
    const trimmed = amount.trim();
    if (!trimmed || isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0) {
      window.appendMessage('system', 'Invalid decrease amount. Please enter a positive number.');
      return;
    }
    invokeDirectTool({ toolName: 'gmx_close_position', args: { market, isLong, sizeDeltaUsd: trimmed } });
  }
}

function modifyGmxCollateral(market, isLong, mode) {
  if (mode === 'add') {
    invokeDirectTool({ toolName: 'gmx_increase_position', args: { market, isLong, sizeDeltaUsd: '0' } });
  } else {
    // Withdraw collateral — ask for amount
    const amount = prompt('Amount of collateral to withdraw:');
    if (amount === null) return;
    const trimmed = amount.trim();
    if (!trimmed || isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0) {
      window.appendMessage('system', 'Invalid collateral amount. Please enter a positive number.');
      return;
    }
    invokeDirectTool({ toolName: 'gmx_close_position', args: { market, isLong, sizeDeltaUsd: '0', collateralDeltaAmount: trimmed } });
  }
}

function withdrawGmxPnl(market, isLong, collateralSymbol, maxCollateral, pnlUsd) {
  // DEPRECATED — GMX v2 has no standalone "withdraw unrealized PnL" function.
  // PnL is realized implicitly on close/decrease. Collateral withdrawal is done
  // via modifyGmxCollateral with sizeDeltaUsd=0.
  window.appendMessage('system', '💡 GMX v2: Unrealized PnL is realized when you close or decrease a position. To withdraw collateral without changing position size, use the Collateral cell menu.');
}

async function refreshGmxPositions() {
  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42) {
    window.appendMessage('system', 'Please enter a vault address first.');
    return;
  }
  try {
    window.appendMessage('system', '🔄 Refreshing GMX positions…');
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
      window.appendMessage('system', `❌ Failed to refresh: ${data.error || data.message || 'Unknown error'}`);
      return;
    }
    // The response will be a new assistant message with updated positions
    const msg = data.message || data.reply || JSON.stringify(data);
    const extras = {};
    if (data.metadata?.gmxPositions) {
      extras.gmxPositions = data.metadata.gmxPositions;
    }
    if (data.suggestions) {
      extras.suggestions = data.suggestions;
    }
    appendMessage('assistant', msg, extras);
  } catch (err) {
    window.appendMessage('system', `❌ Refresh failed: ${err.message}`);
  }
}

export {
  appendMessage, renderRichContent, makeReasoningBlock,
  linkifyMarkdownInCell, linkifyUrls,
  parseDirectToolCall, invokeDirectTool,
  enhanceGmxPositions, closeGmxPosition, modifyGmxSize,
  modifyGmxCollateral, withdrawGmxPnl, refreshGmxPositions,
};
