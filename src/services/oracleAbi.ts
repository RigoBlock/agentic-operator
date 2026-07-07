/**
 * Shared BackgeoOracle hook ABI used by oraclePrice.ts and oraclePool.ts.
 *
 * Keeping this in one place prevents the two services from drifting out of
 * sync (e.g. observe() vs getState() tuple shapes).
 */

export const BACKGEO_ORACLE_ABI = [
  {
    name: "observe",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      {
        name: "key",
        type: "tuple" as const,
        components: [
          { name: "currency0", type: "address" as const },
          { name: "currency1", type: "address" as const },
          { name: "fee", type: "uint24" as const },
          { name: "tickSpacing", type: "int24" as const },
          { name: "hooks", type: "address" as const },
        ],
      },
      { name: "secondsAgos", type: "uint32[]" as const },
    ],
    outputs: [
      { name: "tickCumulatives", type: "int48[]" as const },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint144[]" as const },
    ],
  },
  {
    name: "getState",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      {
        name: "key",
        type: "tuple" as const,
        components: [
          { name: "currency0", type: "address" as const },
          { name: "currency1", type: "address" as const },
          { name: "fee", type: "uint24" as const },
          { name: "tickSpacing", type: "int24" as const },
          { name: "hooks", type: "address" as const },
        ],
      },
    ],
    outputs: [
      {
        name: "state",
        type: "tuple" as const,
        components: [
          { name: "index", type: "uint16" as const },
          { name: "cardinality", type: "uint16" as const },
          { name: "cardinalityNext", type: "uint16" as const },
        ],
      },
    ],
  },
] as const;
