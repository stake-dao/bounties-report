import { formatUnits } from "viem";
import * as dotenv from "dotenv";

dotenv.config();

const fetchGraphQL = async (
  query: string,
  variables?: Record<string, any>,
  maxRetries = 3
) => {
  const url = process.env.BOTS_ENVIO_GRAPHQL_URL_WORKER;
  if (!url) {
    throw new Error(
      "BOTS_ENVIO_GRAPHQL_URL_WORKER environment variable is not set"
    );
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `GraphQL HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`
        );
      }

      let json: any;
      try {
        json = await res.json();
      } catch (e) {
        throw new Error(`GraphQL non-JSON response: ${(e as Error).message}`);
      }

      if (json?.errors) {
        throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
      }
      if (!json || json.data == null) {
        throw new Error(
          `GraphQL empty data (attempt ${attempt}/${maxRetries})`
        );
      }
      return json.data;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const backoffMs = 500 * 2 ** (attempt - 1);
        console.warn(
          `fetchGraphQL attempt ${attempt}/${maxRetries} failed: ${(err as Error).message}. Retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`fetchGraphQL failed after ${maxRetries} attempts`);
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
