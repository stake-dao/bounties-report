import { mock } from 'bun:test';
import * as clients from '../../utils/getClients';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
const rpc = process.env.LOCAL_FORK_RPC;
if (new URL(rpc).hostname !== '127.0.0.1') throw new Error('isolated RPC required');
const client = createPublicClient({ chain: mainnet, transport: http(rpc) });
mock.module('../../utils/getClients', () => ({ ...clients, getClient: async (chainId) => {
  if (chainId !== 1) throw new Error('unexpected test chain');
  return client;
} }));
