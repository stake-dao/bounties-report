type ChainAddresses = {
  [chainId: number]: `0x${string}` | null;
};

export class ContractRegistry {
  // === VOTEMARKET V1 CONTRACTS ===
  private static readonly CURVE_VOTEMARKET: ChainAddresses = {
    1: "0x000000073D065Fc33a3050C2d0e19C393a5699ba", // Mainnet
    42161: "0xB854cF650F5492d23e52cb2A7a58B787fC25B0Bb", // Arbitrum
    8453: "0x786e2D03B32BFc42D60C366F07aBe9B218B7A4eE", // Base
    10: "0x786e2D03B32BFc42D60C366F07aBe9B218B7A4eE", // Optimism
  } as const;

  private static readonly CURVE_VOTEMARKET_OLD: ChainAddresses = {
    1: "0x0000000895cB182E6f983eb4D8b4E0Aa0B31Ae4c", // Mainnet
  } as const;

  private static readonly BALANCER_VOTEMARKET: ChainAddresses = {
    1: "0x0000000446b28e4c90DbF08Ead10F3904EB27606", // Mainnet
    42161: "0xFf276AB161f48f6DBa99dE4601f9a518D1d903f9", // Arbitrum
    8453: "0x21e6ABAf84f6087915ffFE6275f9cBeCDeeEC837", // Base
    10: "0x21e6ABAf84f6087915ffFE6275f9cBeCDeeEC837", // Optimism
  } as const;

  private static readonly BALANCER_VOTEMARKET_OLD: ChainAddresses = {
    1: "0x00000008eF298e2B6dc47E88D72eeB1Fc2b1CA7f", // Mainnet
  } as const;

  private static readonly FRAX_VOTEMARKET: ChainAddresses = {
    1: "0x000000060e56DEfD94110C1a9497579AD7F5b254", // Mainnet
    42161: "0x4941c004dC4Ae7bcb74B404fbd4ff07Dc32e3ecc", // Arbitrum
    8453: "0xa8377e03617de8DA2C18621BE83bcBd5a34Ca1C9", // Base
    10: "0xa8377e03617de8DA2C18621BE83bcBd5a34Ca1C9", // Optimism
  } as const;

  private static readonly FXN_VOTEMARKET: ChainAddresses = {
    1: "0x00000007D987c2Ea2e02B48be44EC8F92B8B06e8", // Mainnet
    42161: "0xE5cE02443942B006d0851d6e73d9dbEeE743b88d", // Arbitrum
    8453: "0xCbE04EDe27B30B1C664e777fbF09ae9d62412FD8", // Base
    10: "0xCbE04EDe27B30B1C664e777fbF09ae9d62412FD8", // Optimism
  } as const;

  // === VOTEMARKET V2 CONTRACTS ===
  private static readonly CURVE_VOTEMARKET_V2: ChainAddresses = {
    1: null,
    42161: "0x5e5C922a5Eeab508486eB906ebE7bDFFB05D81e5",
    10: "0x5e5C922a5Eeab508486eB906ebE7bDFFB05D81e5",
    8453: "0x5e5C922a5Eeab508486eB906ebE7bDFFB05D81e5",
    137: "0x5e5C922a5Eeab508486eB906ebE7bDFFB05D81e5",
  } as const;

  private static readonly TOKEN_FACTORY: ChainAddresses = {
    1: "0x96006425Da428E45c282008b00004a00002B345e",
    42161: "0x96006425Da428E45c282008b00004a00002B345e",
    10: "0x96006425Da428E45c282008b00004a00002B345e",
    8453: "0x96006425Da428E45c282008b00004a00002B345e",
    137: "0x96006425Da428E45c282008b00004a00002B345e",
  } as const;

  /**
   * Get contract address for specified chain
   * @param contractName Name of the contract
   * @param chainId Chain ID
   * @returns Contract address
   */
  public static getAddress(
    contractName: string,
    chainId: number
  ): `0x${string}` {
    const contract = (this as any)[contractName];
    if (!contract) {
      throw new Error(`Contract ${contractName} not found`);
    }

    const address = contract[chainId];
    if (!address) {
      throw new Error(
        `Contract ${contractName} not deployed on chain ${chainId}`
      );
    }

    return address;
  }

  /**
   * Get list of chains where contract is deployed
   * @param contractName Name of the contract
   * @returns Array of chain IDs
   */
  public static getChains(contractName: string): number[] {
    const contract = (this as any)[contractName];
    if (!contract) {
      throw new Error(`Contract ${contractName} not found`);
    }

    return Object.entries(contract)
      .filter(([_, address]) => address !== null)
      .map(([chainId]) => Number(chainId));
  }

  /**
   * Get all contracts deployed on a specific chain, optionally filtered by a pattern
   * @param chainId Chain ID to query
   * @param pattern Optional filter (e.g., "VOTEMARKET" or "CURVE")
   * @returns Object mapping contract names to addresses
   */
  public static getContractsForChain(
    chainId: number,
    pattern?: string
  ): Record<string, `0x${string}`> {
    const contracts: Record<string, `0x${string}`> = {};

    // Get all static properties of the class
    const contractNames = Object.getOwnPropertyNames(ContractRegistry).filter(
      (name) =>
        // Filter out methods and non-contract properties
        typeof (ContractRegistry as any)[name] === "object" &&
        !name.startsWith("_") &&
        (!pattern || name.includes(pattern.toUpperCase()))
    );

    for (const contractName of contractNames) {
      const contract = (this as any)[contractName];
      if (contract[chainId] !== null) {
        contracts[contractName] = contract[chainId];
      }
    }

    return contracts;
  }
}
