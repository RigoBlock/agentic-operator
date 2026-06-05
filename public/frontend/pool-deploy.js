import {
  connectedAddress, vaultInput, escapeHtml,
  currentChainId, activeProvider, CHAIN_NAMES,
  MAINNET_CHAINS_LIST, TESTNET_CHAINS_LIST, getExplorerUrl,
} from './state.js';

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

// Well-known USDC addresses per chain
const USDC_ADDRESSES = {
  1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  56:    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  130:   '0x078D888E40faAe0f32594342c85940AF3949E666',
};

/**
 * Minimal ABI encoder for createPool(string, string, address).
 * Returns the hex arguments (without selector prefix).
 */
function encodeCreatePoolArgs(name, symbol, baseToken) {
  // Pad to 32 bytes (64 hex chars)
  function pad32(hex) { return hex.padStart(64, '0'); }
  // Encode string: offset → length → utf8 bytes padded to 32
  function encodeString(str) {
    const bytes = new TextEncoder().encode(str);
    const len = pad32(bytes.length.toString(16));
    const hexBytes = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const padded = hexBytes.padEnd(Math.ceil(hexBytes.length / 64) * 64, '0');
    return len + padded;
  }
  // Head: 3 slots (offsets for name, symbol, then address)
  // name offset = 0x60 (3 * 32 = 96), symbol offset = dynamic, baseToken = value
  const nameEncoded = encodeString(name);
  const symbolEncoded = encodeString(symbol);
  // Offsets: name at 96 (0x60), symbol at 96 + nameEncoded/2 bytes
  const nameOffset = 96; // 3 * 32
  const symbolOffset = nameOffset + nameEncoded.length / 2;
  const addrClean = baseToken.toLowerCase().replace('0x', '');
  return (
    pad32(nameOffset.toString(16)) +
    pad32(symbolOffset.toString(16)) +
    pad32(addrClean) +
    nameEncoded +
    symbolEncoded
  );
}

async function deploySmartPool() {
  const name = document.getElementById('deploy-pool-name').value.trim();
  const symbol = document.getElementById('deploy-pool-symbol').value.trim().toUpperCase();
  const baseTokenSelect = document.getElementById('deploy-pool-base-token').value;
  const statusEl = document.getElementById('deploy-pool-status');
  const deployChainId = parseInt(document.getElementById('deploy-pool-chain').value, 10);

  if (!name) { statusEl.textContent = 'Pool name is required.'; return; }
  if (!symbol || symbol.length < 2) { statusEl.textContent = 'Valid symbol required (2-5 chars).'; return; }

  let baseToken = '0x0000000000000000000000000000000000000000'; // ETH
  if (baseTokenSelect === 'USDC') {
    baseToken = USDC_ADDRESSES[deployChainId] || USDC_ADDRESSES[1];
  } else if (baseTokenSelect === 'custom') {
    baseToken = document.getElementById('deploy-custom-token').value.trim();
    if (!baseToken || baseToken.length !== 42 || !baseToken.startsWith('0x')) {
      statusEl.textContent = 'Enter a valid token address (0x…).'; return;
    }
  }

  statusEl.textContent = 'Preparing deployment…';
  statusEl.style.color = 'var(--text)';

  try {
    // Ensure wallet is on the selected deploy chain
    const walletChainHex = await activeProvider.request({ method: 'eth_chainId' });
    const walletChain = parseInt(walletChainHex, 16);
    if (walletChain !== deployChainId) {
      statusEl.textContent = `Switching to ${CHAIN_NAMES[deployChainId] || 'chain ' + deployChainId}…`;
      await activeProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x' + deployChainId.toString(16) }],
      });
    }

    // Encode createPool(string, string, address) — selector 0x1d7d13cc
    const factoryAddress = '0x8DE8895ddD702d9a216E640966A98e08c9228f24';

    // Minimal ABI encoding for createPool(string name, string symbol, address baseToken)
    const selector = '0x1d7d13cc';
    const data = selector + encodeCreatePoolArgs(name, symbol, baseToken);

    statusEl.textContent = 'Please confirm in your wallet…';
    const txHash = await activeProvider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: connectedAddress,
        to: factoryAddress,
        data: data,
        value: '0x0',
      }],
    });

    statusEl.style.color = 'var(--success)';
    statusEl.textContent = `Transaction sent: ${txHash.slice(0, 10)}… Waiting for confirmation…`;

    // Poll for receipt
    let confirmed = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const receipt = await activeProvider.request({
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        });
        if (receipt && receipt.status === '0x1') {
          confirmed = true;
          // Try to extract new pool address from logs
          // The factory emits PoolCreated(address indexed pool, ...) or the return value
          // Look for the new pool address in the logs (first topic of PoolCreated event)
          let newPoolAddress = null;
          if (receipt.logs && receipt.logs.length > 0) {
            // PoolCreated event or similar — look for address in first topic or data
            for (const log of receipt.logs) {
              // Pool created events typically have the address as topic[1]
              if (log.topics && log.topics.length >= 2) {
                const addr = '0x' + log.topics[1].slice(26);
                if (addr.length === 42 && addr !== '0x0000000000000000000000000000000000000000') {
                  newPoolAddress = addr;
                  break;
                }
              }
            }
          }

          if (newPoolAddress) {
            // Switch the app to the deploy chain
            currentChainId = deployChainId;
            window.updateChainDisplay();
            vaultInput.value = newPoolAddress;
            window.updateOnboardingVisibility();
            statusEl.innerHTML = `✅ Pool deployed at <strong>${newPoolAddress.slice(0,6)}…${newPoolAddress.slice(-4)}</strong>. Address auto-filled!`;
            window.validateVault();
            window.appendMessage('system', `🏊 New pool "${name}" (${symbol}) deployed at ${newPoolAddress} on ${CHAIN_NAMES[deployChainId] || 'chain ' + deployChainId}`);
          } else {
            statusEl.innerHTML = `✅ Pool deployed! Check the <a href="${getExplorerUrl(deployChainId, txHash)}" target="_blank">transaction</a> for the new address and paste it above.`;
            window.appendMessage('system', `🏊 Pool "${name}" (${symbol}) deployed on ${CHAIN_NAMES[deployChainId] || 'chain ' + deployChainId}. Tx: ${txHash.slice(0,10)}…`);
          }
          break;
        } else if (receipt && receipt.status === '0x0') {
          throw new Error('Deployment transaction reverted');
        }
      } catch (e) {
        if (e.message?.includes('reverted')) throw e;
      }
    }
    if (!confirmed) {
      statusEl.textContent = `Transaction pending: ${txHash.slice(0,10)}… (check explorer)`;
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

export { openDeployPoolModal, encodeCreatePoolArgs, deploySmartPool };
