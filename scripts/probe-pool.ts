import { keccak256, encodeAbiParameters, createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';

async function main() {
  const ALCHEMY_KEY = process.env.ALCHEMY_KEY!;
  const POOL_MANAGER_ARB = '0x360e68faccca8ca495c1b759fd9eee466db9fb32' as `0x${string}`;
  const TARGET_ID = '0xb896675bfb20eed4b90d83f64cf137a860a99a86604f7fac201a822f2b4abc34' as `0x${string}`;
  const POOLS_SLOT = 6n;

  const client = createPublicClient({ chain: arbitrum, transport: http(`https://arb1.arbitrum.io/rpc`) });
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [TARGET_ID, POOLS_SLOT]));
  const result = await client.readContract({
    address: POOL_MANAGER_ARB,
    abi: [{ name: 'extsload', type: 'function' as const, stateMutability: 'view' as const, inputs: [{ name: 'slot', type: 'bytes32' as const }], outputs: [{ name: '', type: 'bytes32' as const }] }],
    functionName: 'extsload', args: [slot],
  });

  const raw = BigInt(result);
  const sqrtPriceX96 = raw & ((1n << 160n) - 1n);
  const tickRaw = Number((raw >> 160n) & 0xFFFFFFn);
  const tick = tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw;
  const protocolFee = Number((raw >> 184n) & 0xFFFFFFn);
  const lpFee = Number((raw >> 208n) & 0xFFFFFFn);

  console.log('sqrtPriceX96:', sqrtPriceX96.toString());
  console.log('tick:', tick);
  console.log('protocolFee:', protocolFee);
  console.log('lpFee:', lpFee, '=', lpFee/10000, '%');
  console.log('Pool initialized:', sqrtPriceX96 > 0n ? 'YES' : 'NO');

  if (sqrtPriceX96 > 0n) {
    const XAUT = '0x40461291347e1eCbb09499F3371D3f17f10d7159' as `0x${string}`;
    const USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as `0x${string}`;
    const isXautLower = XAUT.toLowerCase() < USDT.toLowerCase();
    const currency0 = (isXautLower ? XAUT : USDT) as `0x${string}`;
    const currency1 = (isXautLower ? USDT : XAUT) as `0x${string}`;
    console.log(`currency0=${currency0}, currency1=${currency1}`);

    // Broad tickSpacing search with zero hooks
    const allTs = [1, 2, 5, 10, 20, 25, 50, 60, 100, 120, 200, 500, 1000, 2000];
    const ZERO_HOOKS = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    for (const ts of allTs) {
      const id = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
        [currency0, currency1, lpFee, ts, ZERO_HOOKS]
      ));
      if (id.toLowerCase() === TARGET_ID.toLowerCase()) {
        console.log(`>>> MATCH zero-hooks! fee=${lpFee}, tickSpacing=${ts}`);
      }
    }

    // If pool uses a hooks contract: try to find the Initialize event on PoolManager
    // Uniswap v4 PoolManager emits Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick)
    console.log('\nSearching Initialize event for this pool...');
    const initLogs = await client.getLogs({
      address: POOL_MANAGER_ARB,
      // keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
      event: {
        type: 'event',
        name: 'Initialize',
        inputs: [
          { name: 'id', type: 'bytes32', indexed: true },
          { name: 'currency0', type: 'address', indexed: true },
          { name: 'currency1', type: 'address', indexed: true },
          { name: 'fee', type: 'uint24', indexed: false },
          { name: 'tickSpacing', type: 'int24', indexed: false },
          { name: 'hooks', type: 'address', indexed: false },
          { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
          { name: 'tick', type: 'int24', indexed: false },
        ],
      },
      args: { id: TARGET_ID as `0x${string}` },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    if (initLogs.length > 0) {
      const e = initLogs[0].args;
      console.log(`FOUND Initialize event!`);
      console.log(`  fee: ${e.fee}`);
      console.log(`  tickSpacing: ${e.tickSpacing}`);
      console.log(`  hooks: ${e.hooks}`);
    } else {
      console.log('No Initialize event found (may require archive node / getLogs range limit)');
      // Try limited block range around likely deployment
      console.log('Try getLogs with recent blocks...');
    }
  }
}
main().catch(console.error);
