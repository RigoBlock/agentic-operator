import {
  connectedAddress,
  currentChainId, activeProvider, CHAIN_NAMES,
  MAINNET_CHAINS_LIST, TESTNET_CHAINS_LIST,
  authSignature,
} from './state.js';

import { ensureWalletChain, closeModal, signAuthMessage } from './wallet.js';

import { callTool } from './api.js';

import { showTransactionModal } from './tx-modal.js';

function openDeployPoolModal() {
  if (!connectedAddress) {
    window.openWalletPicker();
    return;
  }
  // Populate chain selector with current network mode chains
  const chainSelect = document.getElementById('deploy-pool-chain');
  const isTestnet = document.getElementById('testnet-toggle').checked;
  const chains = isTestnet ? TESTNET_CHAINS_LIST : MAINNET_CHAINS_LIST;
  chainSelect.innerHTML = chains.map(c =>
    `<option value="${c.id}" ${c.id === currentChainId ? 'selected' : ''}>${c.name}</option>`
  ).join('');
  applyBaseTokenRestriction(parseInt(chainSelect.value, 10));
  document.getElementById('deploy-pool-name').value = '';
  document.getElementById('deploy-pool-symbol').value = '';
  document.getElementById('deploy-pool-base-token').value = 'ETH';
  document.getElementById('deploy-custom-token-field').style.display = 'none';
  document.getElementById('deploy-pool-status').textContent = '';
  document.getElementById('deploy-pool-modal').classList.add('visible');
}

// Toggle custom token field
document.getElementById('deploy-pool-base-token').addEventListener('change', (e) => {
  document.getElementById('deploy-custom-token-field').style.display =
    e.target.value === 'custom' ? '' : 'none';
});

// Re-apply the base-token restriction when the deploy chain changes
document.getElementById('deploy-pool-chain').addEventListener('change', (e) => {
  applyBaseTokenRestriction(parseInt(e.target.value, 10));
});

// Well-known USDC addresses per chain. There is intentionally NO default
// fallback: an unconfigured chain must error, not silently use mainnet USDC
// (that exact fallback deployed pools against an address with no code on
// Lighter Devnet — POOL_INITIALIZATION_FAILED).
const USDC_ADDRESSES = {
  1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  56:    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  130:   '0x078D888E40faAe0f32594342c85940AF3949E666',
  999:   '0xb88339CB7199b77e23DB6E890353E22632Ba630f',
  19529: '0xf2A5728d366c6d0f764Af612cD47F3608E2B4d5B',
};

// Lighter Devnet smart pools are USDC-only: the ALighter adapter settles Core
// margin in USDC, so an ETH-based pool could never trade there.
const USDC_ONLY_CHAINS = new Set([19529]);

/** Restrict the base-token select for USDC-only chains (Lighter Devnet). */
function applyBaseTokenRestriction(chainId) {
  const select = document.getElementById('deploy-pool-base-token');
  const isUsdcOnly = USDC_ONLY_CHAINS.has(chainId);
  for (const opt of select.options) {
    if (opt.value === 'ETH') opt.disabled = isUsdcOnly;
  }
  if (isUsdcOnly && select.value === 'ETH') {
    select.value = 'USDC';
    document.getElementById('deploy-custom-token-field').style.display = 'none';
  }
}

/**
 * Deploy via the backend deploy_smart_pool tool — the SAME path as chatting
 * "deploy a pool": registry name/symbol validation, per-chain USDC-only
 * enforcement, base-token code preflight, revert simulation, and a real
 * server-side gas estimate all run before the tx reaches the wallet. The
 * prepared transaction is signed in the standard tx modal; on confirmation
 * the modal extracts the new pool address from the receipt and auto-fills it.
 */
async function deploySmartPool() {
  const name = document.getElementById('deploy-pool-name').value.trim();
  const symbol = document.getElementById('deploy-pool-symbol').value.trim();
  const baseTokenSelect = document.getElementById('deploy-pool-base-token').value;
  const statusEl = document.getElementById('deploy-pool-status');
  const deployChainId = parseInt(document.getElementById('deploy-pool-chain').value, 10);

  if (!name) { statusEl.textContent = 'Pool name is required.'; return; }
  if (!symbol || symbol.length < 2) { statusEl.textContent = 'Valid symbol required (2-5 chars).'; return; }

  let baseToken = 'ETH';
  if (baseTokenSelect === 'USDC') {
    const usdc = USDC_ADDRESSES[deployChainId];
    if (!usdc) {
      statusEl.textContent = `USDC is not configured for chain ${deployChainId} — paste the token address via "Custom token address…".`;
      return;
    }
    baseToken = usdc;
  } else if (baseTokenSelect === 'custom') {
    baseToken = document.getElementById('deploy-custom-token').value.trim();
    if (!baseToken || baseToken.length !== 42 || !baseToken.startsWith('0x')) {
      statusEl.textContent = 'Enter a valid token address (0x…).'; return;
    }
  }

  statusEl.style.color = 'var(--text)';

  try {
    // The tools route proves operator identity from the session auth headers;
    // the deploy flow has no vault yet, so make sure the auth signature exists.
    if (!authSignature) {
      statusEl.textContent = 'Signing authentication…';
      await signAuthMessage();
      if (!authSignature) {
        statusEl.style.color = 'var(--muted)';
        statusEl.textContent = 'Sign cancelled. Please try again.';
        return;
      }
    }

    statusEl.textContent = `Switching to ${CHAIN_NAMES[deployChainId] || 'chain ' + deployChainId}…`;
    await ensureWalletChain(activeProvider, deployChainId);

    statusEl.textContent = 'Preparing deployment…';
    const { ok, data } = await callTool('deploy_smart_pool', {
      arguments: { name, symbol, baseToken },
      chainId: deployChainId,
      operatorAddress: connectedAddress,
    });

    if (!ok || !data || data.error) {
      statusEl.style.color = 'var(--error)';
      statusEl.textContent = `Deployment blocked: ${(data && (data.error || data.message)) || 'unknown error'}`;
      return;
    }

    closeModal('deploy-pool-modal');
    if (data.message) {
      window.appendMessage('assistant', data.message);
    }
    if (data.transaction) {
      showTransactionModal(data.transaction);
    }
  } catch (err) {
    if (err.code === 4001 || err.message?.includes('rejected')) {
      statusEl.textContent = 'Deployment cancelled.';
      statusEl.style.color = 'var(--muted)';
    } else {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = 'var(--error)';
    }
  }
}

export { openDeployPoolModal, deploySmartPool };
