import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { createPublicClient, http, formatUnits } from "viem";
import { mainnet, bsc } from "viem/chains";
import {
  BOTMARKETS,
  SPACES_TOKENS,
  SPACE_TO_NETWORK,
  LABELS_TO_SPACE,
} from "../../utils/constants";
import { sendTelegramMessage } from "../../utils/telegramUtils";

const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

const bscClient = createPublicClient({
  chain: bsc,
  transport: http("https://bsc-dataseed.bnbchain.org"),
});

interface ProtocolData {
  sdTokenRepartition: { [token: string]: number };
  totalReportAmount: number;
  rewardTokenCount: { [token: string]: number };
}

const PROTOCOLS_TOKENS = {
  curve: {
    sdToken: SPACES_TOKENS[LABELS_TO_SPACE.curve],
    decimals: 18,
    botmarket: BOTMARKETS[SPACE_TO_NETWORK[LABELS_TO_SPACE.curve]],
  },
  cake: {
    sdToken: SPACES_TOKENS[LABELS_TO_SPACE.cake],
    decimals: 18,
    botmarket: BOTMARKETS[SPACE_TO_NETWORK[LABELS_TO_SPACE.cake]],
  },
  balancer: {
    sdToken: SPACES_TOKENS[LABELS_TO_SPACE.balancer],
    decimals: 18,
    botmarket: BOTMARKETS[SPACE_TO_NETWORK[LABELS_TO_SPACE.balancer]],
  },
  frax: {
    sdToken: SPACES_TOKENS[LABELS_TO_SPACE.frax],
    decimals: 18,
    botmarket: BOTMARKETS[SPACE_TO_NETWORK[LABELS_TO_SPACE.frax]],
  },
  fxn: {
    sdToken: SPACES_TOKENS[LABELS_TO_SPACE.fxn],
    decimals: 18,
    botmarket: BOTMARKETS[SPACE_TO_NETWORK[LABELS_TO_SPACE.fxn]],
  },
  pendle: {
    sdToken: SPACES_TOKENS[LABELS_TO_SPACE.pendle],
    decimals: 18,
    botmarket: BOTMARKETS[SPACE_TO_NETWORK[LABELS_TO_SPACE.pendle]],
  },
} as const;

type ProtocolKey = keyof typeof PROTOCOLS_TOKENS;

async function getTokenBalance(
  client: any,
  tokenAddress: string,
  decimals: number,
  botmarket: string
): Promise<number> {
  const balance = await client.readContract({
    address: tokenAddress as `0x${string}`,
    abi: [
      {
        inputs: [{ internalType: "address", name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ],
    functionName: "balanceOf",
    args: [botmarket as `0x${string}`],
  });

  return parseFloat(formatUnits(balance as bigint, decimals));
}

async function processProtocol(protocol: string): Promise<ProtocolData> {
  const filePath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    `${protocol}.csv`
  );

  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: No report found for protocol "${protocol}" for the current period.`);
    return {
      sdTokenRepartition: {},
      totalReportAmount: 0,
      rewardTokenCount: {},
    };
  }

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const records = parse(fileContent, {
    columns: true,
    delimiter: ";",
    skip_empty_lines: true,
  });

  const protocolData: ProtocolData = {
    sdTokenRepartition: {},
    totalReportAmount: 0,
    rewardTokenCount: {},
  };

  for (const record of records) {
    const sdTokenAmount = parseFloat(record["Reward sd Value"]);
    const rewardToken = record["Reward Token"];

    protocolData.sdTokenRepartition[rewardToken] =
      (protocolData.sdTokenRepartition[rewardToken] || 0) + sdTokenAmount;
    protocolData.totalReportAmount += sdTokenAmount;
    protocolData.rewardTokenCount[rewardToken] =
      (protocolData.rewardTokenCount[rewardToken] || 0) + 1;
  }

  return protocolData;
}

async function main() {
  // Get protocol from command line args
  const protocol = process.argv[2] as ProtocolKey;
  if (!protocol || !PROTOCOLS_TOKENS[protocol]) {
    console.error('Please specify a valid protocol');
    process.exit(1);
  }

  const reportUrl = `https://github.com/stake-dao/bounties-report/tree/main/bribes-reports/${currentPeriodTimestamp}`;
  let message = `<a href="${reportUrl}"><b>[Distribution] Report checker for ${protocol.toUpperCase()}</b></a>\n\n`;

  const data = await processProtocol(protocol);
  
  message += `<b>${protocol.toUpperCase()}:</b>\n`;
  const total = Object.values(data.sdTokenRepartition).reduce(
    (a, b) => a + b,
    0
  );

  // Create an array of [token, share, bountyCount] tuples and sort it
  const sortedShares = Object.entries(data.sdTokenRepartition)
    .map(([token, amount]) => {
      const share = (amount / total) * 100;
      const bountyCount = data.rewardTokenCount[token] || 0;
      return { token, share, bountyCount };
    })
    .sort((a, b) => b.share - a.share);

  // Output the sorted shares
  for (const { token, share, bountyCount } of sortedShares) {
    message += `  <b>${token}:</b> ${share.toFixed(2)}% <i>(${bountyCount} bounties)</i>\n`;
  }

  const protocolInfo = PROTOCOLS_TOKENS[protocol];
  const client =
    SPACE_TO_NETWORK[LABELS_TO_SPACE[protocol]] === "bsc"
      ? bscClient
      : ethereumClient;
  const botmarketBalance = await getTokenBalance(
    client,
    protocolInfo.sdToken,
    protocolInfo.decimals,
    protocolInfo.botmarket
  );

  message += `  <b>Report total:</b> ${data.totalReportAmount.toFixed(2)}\n`;
  message += `  <b>Botmarket balance:</b> ${botmarketBalance.toFixed(2)}\n`;
  const difference = botmarketBalance - data.totalReportAmount;
  const differenceAbs = Math.abs(difference);
  const isDifferenceSignificant = differenceAbs > 0.01;

  if (isDifferenceSignificant) {
    message += `  <b>Difference:</b> ${differenceAbs.toFixed(2)} ⚠️\n`;
  } else {
    message += `  <b>Difference:</b> ${differenceAbs.toFixed(2)} ✅\n`;
  }

  // Send the message to Telegram
  await sendTelegramMessage(message, "HTML");

  // Also log to console
  console.log(message.replace(/<\/?[^>]+(>|$)/g, "")); // Remove HTML tags for console output
}

main().catch(console.error);
