const axios = require('axios').default;
const { MERKLE_ADDRESS, AGNOSTIC_ENDPOINT, AGNOSTIC_API_KEY } = require('./constants');

const DATE_LAST_CLAIM_QUERY = (table, merkleAddress) => `
  SELECT
      timestamp
  FROM ${table}
  WHERE
      address = '${merkleAddress}' and
      signature = 'Claimed(address,uint256,uint256,address,uint256)'
  ORDER BY timestamp DESC
  LIMIT 1
`;

const DATE_LAST_UPDATE_QUERY = (timestamp, tokenAddress, table, merkleAddress) => `
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

const ALL_CLAIMED_QUERY = (since, end, tokenAddress, table, merkleAddress) => `
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

const getAllAccountClaimedSinceLastFreezeWithAgnostic = async (tokenAddress, table, merkleAddress) => {
    const resp = {};

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

const agnosticFetch = async (query) => {
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

module.exports = {
    getAllAccountClaimedSinceLastFreezeWithAgnostic
};