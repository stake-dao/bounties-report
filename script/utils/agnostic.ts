import axios from "axios";
import { AGNOSTIC_API_KEY, AGNOSTIC_ENDPOINT } from "./constants";
import { formatBytes32String } from "ethers/lib/utils";


const DATE_LAST_CLAIM_QUERY = (table: string, merkleAddress: string) => `
  SELECT
      timestamp
  FROM ${table}
  WHERE
      address = '${merkleAddress}' and
      signature = 'Claimed(address,uint256,uint256,address,uint256)'
  ORDER BY timestamp DESC
  LIMIT 1
`;

const DATE_LAST_UPDATE_QUERY = (timestamp: number, tokenAddress: string, table: string, merkleAddress: string) => `
  SELECT
      timestamp
  FROM ${table}
  WHERE
      address = '${merkleAddress}' and
      timestamp < '${timestamp}' and
      input_0_value_address = '${tokenAddress}' and
      signature = 'MerkleRootUpdated(address,bytes32,uint256)'
  ORDER BY timestamp DESC
  LIMIT 1
`;

const ALL_CLAIMED_QUERY = (since: number, end: number, tokenAddress: string, table: string, merkleAddress: string) => `
  SELECT
      input_3_value_address as user
  FROM ${table}
  WHERE
      address = '${merkleAddress}' and
      timestamp > '${since}' and
      timestamp <= '${end}' and
      input_0_value_address = '${tokenAddress}' and
      signature = 'Claimed(address,uint256,uint256,address,uint256)'
  ORDER BY timestamp DESC
`;

// Should be order by ASC !
const DELEGATION_QUERY = (table: string, limit: number, offset: number, ts: number, spaceId: string) => `
SELECT
      input_0_value_address as user,
      signature
  FROM ${table}
  WHERE
      address = '0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446' 
      and input_2_value_address = '0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC'
      and input_1_value_string = '${spaceId}'
      and timestamp <= ${ts}
      and (signature = 'SetDelegate(address,bytes32,address)' OR signature = 'ClearDelegate(address,bytes32,address)')
  ORDER BY timestamp ASC
  LIMIT ${limit} OFFSET ${offset}
`

export const getAllAccountClaimedSinceLastFreezeWithAgnostic = async (tokenAddress: string, table: string, merkleAddress: string): Promise<Record<string, boolean>> => {
    const resp: Record<string, boolean> = {};

    const lastClaim = await agnosticFetch(DATE_LAST_CLAIM_QUERY(table, merkleAddress));
    const lastUpdate = await agnosticFetch(DATE_LAST_UPDATE_QUERY(lastClaim[0][0], tokenAddress, table, merkleAddress));

    const lastClaimTimestamp = lastClaim[0][0];
    const lastUpdateTimestamp = lastUpdate[0][0];

    const allClaimed = await agnosticFetch(ALL_CLAIMED_QUERY(lastUpdateTimestamp, lastClaimTimestamp, tokenAddress, table, merkleAddress));
    if (!allClaimed) {
        return resp;
    }

    for (const row of allClaimed) {
        resp[row[0].toLowerCase()] = true;
    }
    return resp
}

export const getDelegators = async (table: string, snapshotStartTimestamp: number, space: string): Promise<string[]> => {
    const limit = 10_000;
    let offset = 0;
    let run = true;
    let delegationRows: string[] = [];

    do {
        
        const rows = await agnosticFetch(DELEGATION_QUERY(table, limit, offset, snapshotStartTimestamp, formatBytes32String(space)));
        if (rows.length === limit) {
            offset += limit;
        } else {
            run = false;
        }
        delegationRows.push(...rows);
    } while (run);

    const users: Record<string, boolean> = {};

    // delegationRows is ordered by ASC, so we iterate from the chain begining to the end
    // If we have SetDelegate, we add the user and if we have a ClearDelegate, we remove the user
    for (const rows of delegationRows) {
        const user = rows[0];
        const event = rows[1];

        // If we have a ClearDelegate event, we remove the user
        // Otherwise, we add the user since it's a SetDelegate
        if (event.indexOf("Clear") > -1) {
            delete users[user];
        } else {
            users[user] = true;
        }
    }

    return Object.keys(users);
}

const agnosticFetch = async (query: string): Promise<any[]> => {
    try {
        const response = await axios.post(AGNOSTIC_ENDPOINT, query, {
            headers: {
                'Authorization': `${AGNOSTIC_API_KEY}`,
                "Cache-Control": "max-age=300"
            }
        });

        return response.data.rows;
    }
    catch (e) {
        console.error(e);
        return [];
    }
}