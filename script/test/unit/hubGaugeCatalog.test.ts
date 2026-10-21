import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { getGaugesInfos } from '../../utils/reportUtils';
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), create: vi.fn() } }));
const get = vi.mocked(axios.get);
const root = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const child = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
describe('Hub Votemarket report identities', () => {
  beforeEach(() => vi.clearAllMocks());
  it('joins root campaigns to child gauges and preserves killed gauges for history', async () => {
    get.mockResolvedValue({ status: 200, data: { gauges: [
      { gauge: root, childGauge: child, shortName: 'Pool (details)', inController: true, isKilled: true },
      { gauge: child, name: 'Excluded', inController: false },
    ] } });
    expect(await getGaugesInfos('curve')).toEqual([
      { name: 'Pool ', address: child.toLowerCase() },
      { name: 'Pool ', address: root.toLowerCase(), actualGauge: child.toLowerCase() },
    ]);
    expect(get).toHaveBeenCalledWith('https://hub.stakedao.org/v1/votemarket/curve/gauges');
  });
  it('retains FXN names and normalized addresses', async () => {
    get.mockResolvedValue({ status: 200, data: { gauges: [{ gauge: root, name: 'FXN' }] } });
    expect(await getGaugesInfos('fxn')).toEqual([{ name: 'FXN', address: root.toLowerCase() }]);
    expect(get).toHaveBeenCalledWith('https://hub.stakedao.org/v1/votemarket/fxn/gauges');
  });
  it.each([{}, {gauges: []}, {gauges: null}])('refuses a missing catalog instead of producing incomplete reports', async (data) => {
    get.mockResolvedValue({ status: 200, data });
    await expect(getGaugesInfos('curve')).rejects.toThrow('catalog');
  });
  it('propagates outages', async () => {
    get.mockRejectedValue(new Error('offline'));
    await expect(getGaugesInfos('fxn')).rejects.toThrow('offline');
  });
});
