type Choices = Record<string, number>;
type Parts = Array<[number, number]>;
export interface SdCrvAutoVoteCandidate {
  weightedChoices: ReadonlyArray<readonly [number, number]>;
  totalWeight: number; // Includes gauges absent from this proposal.
  voter: string;
  vp: number;
  direct: boolean;
}

function addParts(sum: Choices, parts: Parts) {
  for (const [index, amount] of parts) sum[index] = (sum[index] ?? 0) + amount;
  return sum;
}

function readParts({ weightedChoices, totalWeight, vp }: SdCrvAutoVoteCandidate): Parts {
  if (!Number.isSafeInteger(totalWeight) || totalWeight < 0) throw new Error("Invalid sdCRV weight sum");
  const parts: Parts = [];
  let knownWeight = 0;
  for (const [index, weight] of weightedChoices) {
    if (!Number.isSafeInteger(index) || index < 1 || !Number.isSafeInteger(weight) || weight < 0) {
      throw new Error("Invalid sdCRV registration weight");
    }
    knownWeight += weight;
    if (knownWeight > totalWeight) throw new Error("Invalid sdCRV weight sum");
    if (!weight) continue;
    const amount = weight * vp / totalWeight; // Same operation order as the producer.
    if (!Number.isFinite(amount)) throw new Error("Invalid sdCRV contribution");
    if (amount > 0) parts.push([index, amount]);
  }
  return parts;
}

export function reconcileSdCrvAutoVote(signed: Readonly<Choices>, candidates: readonly SdCrvAutoVoteCandidate[]) {
  if (!signed || typeof signed !== "object" || Array.isArray(signed)) throw new Error("Invalid sdCRV ballot choice");
  const targets = Object.entries(signed);
  if (!targets.some(([, value]) => value > 0) || targets.some(([key, value]) =>
    !Number.isSafeInteger(+key) || +key < 1 || String(+key) !== key || !Number.isFinite(value) || value < 0
  )) throw new Error("Invalid sdCRV ballot choice");

  const seen = new Set<string>();
  const totalMax: Choices = {};
  let operations = 2;
  const wallets: { voter: string; direct: boolean; parts: Parts; choice: Choices }[] = [];
  for (const candidate of candidates) {
    const voter = candidate.voter.toLowerCase();
    if (!/^0x[\da-f]{40}$/.test(voter) || typeof candidate.direct !== "boolean") throw new Error("Invalid sdCRV voter");
    if (!Number.isFinite(candidate.vp) || candidate.vp < 0) throw new Error("Invalid sdCRV voting power");
    if (seen.has(voter)) throw new Error("Duplicate sdCRV candidate");
    seen.add(voter);

    const parts = readParts(candidate);
    const choice = addParts({}, parts);
    // A wallet's contribution cannot exceed the signed total on any gauge.
    if (!parts.length || Object.entries(choice).some(([key, value]) => value > (signed[key] ?? 0))) continue;
    operations += parts.length + 1;
    for (const [key, weight] of Object.entries(choice)) totalMax[key] = (totalMax[key] ?? 0) + weight;
    wallets.push({ voter, direct: candidate.direct, parts, choice });
  }
  if (Object.values(totalMax).some(weight => !Number.isFinite(weight))) throw new Error("Invalid sdCRV aggregate");

  const sum: Choices = {};
  const payout: { voter: string; choice: Choices; vp: number }[] = [];
  for (const { voter, direct, parts, choice } of wallets) {
    // Is a signed gauge total unreachable if this wallet was omitted?
    const required = targets.some(([key, target]) => {
      const upper = totalMax[key] ?? 0;
      const margin = (Number.EPSILON * Math.max(upper, target) + Number.MIN_VALUE) * (8 * operations);
      return target - (upper - (choice[key] ?? 0)) > margin;
    });
    if (!direct && !required) throw new Error("Ambiguous individual sdCRV auto-vote attribution");
    if (direct && Object.entries(addParts({ ...sum }, parts)).some(([key, value]) => value > signed[key])) {
      if (required) throw new Error("Cannot reconstruct sdCRV ballot");
      continue;
    }
    addParts(sum, parts);
    if (!direct) {
      const vp = Object.values(choice).reduce((total, weight) => total + weight, 0);
      if (!Number.isFinite(vp)) throw new Error("Invalid sdCRV recognized voting power");
      payout.push({ voter, choice, vp });
    }
  }
  if (targets.some(([key, target]) => (sum[key] ?? 0) !== target)) throw new Error("Cannot reconstruct sdCRV ballot");
  return payout;
}
