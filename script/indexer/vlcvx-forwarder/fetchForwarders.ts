// ABOUTME: CLI helper for querying forwarding intervals and snapshots from the local HyperIndex
// ABOUTME: Fetches union forwarders via GraphQL and prints history, epoch activity, and current snapshot
import { GraphQLClient, gql } from "graphql-request";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { processAllDelegators } from "../../utils/cacheUtils";
import { DELEGATION_ADDRESS } from "../../utils/constants";
import { computeCurrentEpochStart } from "../../utils/epochUtils";

type IntervalRecord = {
  from: string;
  to: string;
  start: string;
  expiration: string;
  canceled: boolean;
  txHash: string;
};

type RegistrationRecord = {
  from: string;
  to: string;
  start: string;
  expiration: string;
  lastUpdatedAt: string;
};

const DEFAULT_GRAPHQL_ENDPOINT = "http://localhost:8080/v1/graphql";
const STAKE_DAO_FORWARDER = "0xae86a3993d13c8d77ab77dbb8ccdb9b7bc18cd09";
const CVX_SPACE = "cvx.eth";

const ALL_INTERVALS_QUERY = gql`
  query AllForwardsToMe($to: String!) {
    Interval(
      where: { to: { _eq: $to } }
      order_by: { start: asc }
    ) {
      from
      to
      start
      expiration
      canceled
      txHash
      blockNumber
      timestamp
    }
  }
`;

const ACTIVE_INTERVALS_QUERY = gql`
  query ActiveToMeAtEpoch($to: String!, $epoch: numeric!) {
    Interval(
      where: {
        to: { _eq: $to }
        start: { _lte: $epoch }
        expiration: { _gt: $epoch }
        canceled: { _eq: false }
      }
      order_by: { start: asc }
    ) {
      from
      to
      start
      expiration
      canceled
      txHash
    }
  }
`;

const SNAPSHOT_QUERY = gql`
  query ActiveSnapshotToMe($to: String!, $epoch: numeric!) {
    Registration(
      where: {
        to: { _eq: $to }
        start: { _lte: $epoch }
        expiration: { _gt: $epoch }
      }
    ) {
      from
      to
      start
      expiration
      lastUpdatedAt
    }
  }
`;

function formatInterval(record: IntervalRecord) {
  return {
    from: record.from,
    start: Number(record.start),
    expiration: Number(record.expiration),
    durationDays: Number(record.expiration) > 0
      ? ((Number(record.expiration) - Number(record.start)) / (60 * 60 * 24)).toFixed(2)
      : "open",
    canceled: record.canceled,
    txHash: record.txHash,
  };
}

function formatRegistration(record: RegistrationRecord) {
  return {
    from: record.from,
    start: Number(record.start),
    expiration: Number(record.expiration),
    lastUpdatedAt: Number(record.lastUpdatedAt),
  };
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("to", {
      type: "string",
      describe: "Destination address to query forwarding towards",
      default: STAKE_DAO_FORWARDER,
    })
    .option("epoch", {
      type: "number",
      describe: "Epoch start timestamp (seconds). Defaults to current 14-day epoch.",
    })
    .option("graphql", {
      type: "string",
      describe: "GraphQL endpoint exposed by the local Envio indexer",
      default: DEFAULT_GRAPHQL_ENDPOINT,
    })
    .option("includeCanceled", {
      type: "boolean",
      describe: "Include canceled intervals in the history output",
      default: false,
    })
    .help()
    .strict()
    .parseAsync();

  const to = argv.to.toLowerCase();
  const epoch = argv.epoch ?? computeCurrentEpochStart();
  const client = new GraphQLClient(argv.graphql);

  const epochNumeric = epoch.toString();

  const [allIntervalsResponse, activeIntervalsResponse, snapshotResponse] = await Promise.all([
    client.request<{ Interval: IntervalRecord[] }>(ALL_INTERVALS_QUERY, { to }),
    client.request<{ Interval: IntervalRecord[] }>(ACTIVE_INTERVALS_QUERY, { to, epoch: epochNumeric }),
    client.request<{ Registration: RegistrationRecord[] }>(SNAPSHOT_QUERY, { to, epoch: epochNumeric }),
  ]);

  const history = argv.includeCanceled
    ? allIntervalsResponse.Interval
    : allIntervalsResponse.Interval.filter((interval) => !interval.canceled);
  const active = activeIntervalsResponse.Interval;
  const snapshot = snapshotResponse.Registration;

  console.log(`Forwarding destination: ${to}`);
  console.log(`Epoch start: ${epoch} (${new Date(epoch * 1000).toISOString()})`);
  console.log("");

  if (history.length === 0) {
    console.log("No forwarding history found.");
  } else {
    console.log("=== Forwarding History ===");
    console.table(history.map(formatInterval));
  }

  if (active.length === 0) {
    console.log("\nNo delegators forwarding in this epoch.");
  } else {
    console.log("\n=== Active This Epoch ===");
    console.table(active.map(formatInterval));
  }

  if (snapshot.length === 0) {
    console.log("\nSnapshot empty (no active registrations).");
  } else {
    console.log("\n=== Current Snapshot ===");
    console.table(snapshot.map(formatRegistration));
  }

  try {
    const delegators = await processAllDelegators(
      CVX_SPACE,
      Math.floor(Date.now() / 1000),
      DELEGATION_ADDRESS
    );
    const delegatorSet = new Set(delegators.map((addr) => addr.toLowerCase()));
    const forwarderSet = new Set(snapshot.map((entry) => entry.from.toLowerCase()));
    const forwardersNotDelegators = [...forwarderSet].filter(
      (address) => !delegatorSet.has(address)
    );

    console.log(`\n=== Delegators (${CVX_SPACE}) === (${delegators.length} addresses)`);
    if (delegators.length === 0) {
      console.log("No delegators found for cvx.eth.");
    } else {
      console.log(delegators.join("\n"));
    }

    console.log(
      `\n=== Forwarders Not Delegators (${forwardersNotDelegators.length}) ===`
    );
    if (forwardersNotDelegators.length === 0) {
      console.log("Every forwarder is also a delegator.");
    } else {
      console.log(forwardersNotDelegators.join("\n"));
    }
  } catch (error) {
    console.warn(
      `\nWarning: unable to load delegators for ${CVX_SPACE} using address ${DELEGATION_ADDRESS}.`
    );
    console.warn((error as Error).message);
  }
}

main().catch((error) => {
  console.error("Failed to fetch forwarders data:", error);
  process.exitCode = 1;
});
