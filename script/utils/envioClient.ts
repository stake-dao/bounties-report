import { formatUnits } from "viem";

const ENVIO_GRAPHQL_URL = "https://bots.stakedao.org/v1/graphql";

const fetchGraphQL = async (query: string, variables?: Record<string, any>) => {
  const res = await fetch(ENVIO_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
};

const toFloat = (raw: string) => Number(formatUnits(BigInt(raw), 18));

/**
 * Fetch global totalVotingPower for a protocol.
 * Equivalent to `total_vp` from the old GitHub JSON files.
 */
export async function fetchGlobalTotalVp(
  protocol: "sdfxs" | "sdspectra"
): Promise<number> {
  if (protocol === "sdfxs") {
    const data = await fetchGraphQL(
      `{ SdFxsGlobalState_by_pk(id: "global") { totalVotingPower } }`
    );
    return toFloat(data.SdFxsGlobalState_by_pk?.totalVotingPower ?? "0");
  }

  const data = await fetchGraphQL(
    `{ SdSpectraGlobalState_by_pk(id: "global") { totalVotingPower } }`
  );
  return toFloat(data.SdSpectraGlobalState_by_pk?.totalVotingPower ?? "0");
}

/**
 * Fetch working balances for a list of user addresses (sdSpectra).
 * Returns a Record<lowercaseAddress, workingBalance>.
 */
export async function fetchSpectraUsersWorkingBalance(
  userAddresses: string[]
): Promise<Record<string, number>> {
  const lowered = userAddresses.map((a) => a.toLowerCase());
  const data = await fetchGraphQL(
    `query($ids: [String!]!) {
      SdSpectraUser(where: { id: { _in: $ids } }) { id workingBalance }
    }`,
    { ids: lowered }
  );

  const result: Record<string, number> = {};
  for (const u of data.SdSpectraUser ?? []) {
    result[u.id] = toFloat(u.workingBalance);
  }
  return result;
}
