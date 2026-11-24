import { isDeepStrictEqual } from "node:util";

type Choices = Record<string, number>;
type Parts = Array<[number, number]>;
interface Registration {
  weightedChoices: ReadonlyArray<readonly [number, number]>;
  totalWeight: number; // Includes gauges absent from this proposal.
}
export interface SdCrvAutoVoteCandidate extends Registration {
  voter: string;
  vp: number;
  direct: boolean;
  alternatives?: readonly Registration[];
}

function addParts(sum: Choices, parts: Parts) {
  for (const [index, amount] of parts) sum[index] = (sum[index] ?? 0) + amount;
  return sum;
}

function readParts({ weightedChoices, totalWeight }: Registration, vp: number): Parts {
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
  const wallets = candidates.map(candidate => {
    const voter = candidate.voter.toLowerCase();
    if (!/^0x[\da-f]{40}$/.test(voter) || typeof candidate.direct !== "boolean") throw new Error("Invalid sdCRV voter");
    if (!Number.isFinite(candidate.vp) || candidate.vp < 0) throw new Error("Invalid sdCRV voting power");
    if (seen.has(voter)) throw new Error("Duplicate sdCRV candidate");
    seen.add(voter);
    const maximum: Choices = {};
    const states: { parts: Parts; choice: Choices }[] = [];
    for (const registration of [candidate, ...(candidate.alternatives ?? [])]) {
      const parts = readParts(registration, candidate.vp);
      const choice = addParts({}, parts);
      // Inserting other nonnegative terms cannot lower this sum, even for repeated indices.
      if (!parts.length || Object.entries(choice).some(([key, value]) => value > (signed[key] ?? 0))) continue;
      operations += parts.length + 1;
      for (const [key, value] of Object.entries(choice)) maximum[key] = Math.max(maximum[key] ?? 0, value);
      states.push({ parts, choice });
    }
    states.push({ parts: [], choice: {} }); // The producer may have omitted this wallet.
    for (const [key, value] of Object.entries(maximum)) {
      totalMax[key] = (totalMax[key] ?? 0) + value;
      if (!Number.isFinite(totalMax[key])) throw new Error("Invalid sdCRV aggregate");
    }
    return { voter, direct: candidate.direct, states, maximum };
  });

  const sum: Choices = {};
  const payout: { voter: string; choice: Choices; vp: number }[] = [];
  for (const { voter, direct, states, maximum } of wallets) {
    const possible = states.filter(({ choice }) => targets.every(([key, target]) => {
      const weight = choice[key] ?? 0;
      const upper = totalMax[key] ?? 0;
      // Keep near alternatives: summing positive terms in a different order can change the last bits.
      const margin = (Number.EPSILON * Math.max(upper, target) + Number.MIN_VALUE) * (8 * operations);
      return target - (upper - (maximum[key] ?? 0) + weight) <= margin;
    }));
    if (!possible.length) throw new Error("Cannot reconstruct sdCRV ballot");
    const first = possible[0];
    if (!direct && possible.some(state => !isDeepStrictEqual(state.choice, first.choice))) {
      throw new Error("Ambiguous individual sdCRV auto-vote attribution");
    }
    // Every direct voter receives zero from this path. Any exact witness is sufficient.
    const witness = direct ? possible.find(({ parts }) =>
      Object.entries(addParts({ ...sum }, parts)).every(([key, value]) => value <= signed[key])
    ) : first;
    if (!witness) throw new Error("Cannot reconstruct sdCRV ballot");
    addParts(sum, witness.parts);
    if (!direct && first.parts.length) {
      const vp = Object.values(first.choice).reduce((total, weight) => total + weight, 0);
      if (!Number.isFinite(vp)) throw new Error("Invalid sdCRV recognized voting power");
      payout.push({ voter, choice: first.choice, vp });
    }
  }
  if (targets.some(([key, target]) => (sum[key] ?? 0) !== target)) throw new Error("Cannot reconstruct sdCRV ballot");
  return payout;
}
