import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { createPublicClient, getAddress, http } from 'viem';
import { mainnet } from 'viem/chains'

const REPO_PATH = "stake-dao/pendle-merkle-script";
const DIRECTORY_PATH = "scripts/data/sdPendle-rewards";

interface GaugeInfo {
    name: string;
    reward: string;
}

interface LatestRewards {
    totalVoterRewards: string;
    resultsByPeriod: {
        [period: string]: {
            [address: string]: GaugeInfo;
        };
    };
}

interface CSVRow {
    Protocol: string;
    'Gauge Name': string;
    'Gauge Address': string;
    'Reward Token': string;
    'Reward Address': string;
    'Reward Amount': number;
    'Reward sd Value': number;
    'Share % per Protocol': number;
}

const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net")
});


async function getLatestJson(repoPath: string, directoryPath: string): Promise<LatestRewards> {
    const url = `https://api.github.com/repos/${repoPath}/contents/${directoryPath}`;
    const response = await axios.get(url);

    if (response.status === 200) {
        const files = response.data;
        let latestFile = null;
        let latestDate = new Date(0);

        for (const file of files) {
            const dateStr = file.name.split('_').pop()!.replace('.json', '');
            const fileDate = new Date(dateStr.split('-').reverse().join('-'));
            if (fileDate > latestDate) {
                latestDate = fileDate;
                latestFile = file;
            }
        }

        if (latestFile) {
            const fileContent = await axios.get(latestFile.download_url);
            return fileContent.data;
        }
    }

    throw new Error("Failed to retrieve latest JSON file");
}

async function main() {
    try {
        // Fetch the repartition of rewards from Pendle scripts repo
        const latestRewards = await getLatestJson(REPO_PATH, DIRECTORY_PATH);


        const sdPendleBalance = await publicClient.readContract({
            address: getAddress()
        })


        if (sdPendleBalance.isZero()) {
            console.error("No sdPendle balance found on Botmarket");
            return;
        }

        const totalVoterRewards = BigInt(latestRewards.totalVoterRewards);
        const flattendedData: CSVRow[] = [];
        let totalSdPendle = BigInt(0);

        for (const [period, gauges] of Object.entries(latestRewards.resultsByPeriod)) {
            for (const [address, gaugeInfo] of Object.entries(gauges)) {
                if (gaugeInfo.name !== "vePENDLE") {
                    const reward = BigInt(gaugeInfo.reward);
                    const share = Number(reward) / Number(totalVoterRewards);
                    const sdPendle = sdPendleBalance.mul(reward).div(totalVoterRewards);
                    totalSdPendle = totalSdPendle.add(sdPendle);

                    flattendedData.push({
                        Protocol: `pendle-${period}`,
                        'Gauge Name': gaugeInfo.name,
                        'Gauge Address': address,
                        'Reward Token': 'WETH',
                        'Reward Address': Ethereum.WETH,
                        'Reward Amount': Number(ethers.utils.formatEther(reward)),
                        'Reward sd Value': Number(ethers.utils.formatEther(sdPendle)),
                        'Share % per Protocol': share * 100
                    });
                }
            }
        }

        // Normalize sdPendle values
        flattendedData.forEach(row => {
            const normalizedSdPendle = BigInt(row['Reward sd Value'] * 1e18)
                .mul(sdPendleBalance)
                .div(totalSdPendle);
            row['Reward sd Value'] = Number(ethers.utils.formatEther(normalizedSdPendle));
        });

        // Generate CSV content
        const csvContent = [
            "Protocol;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
            ...flattendedData.map(row =>
                `${row.Protocol};` +
                `${row['Gauge Name']};` +
                `${row['Gauge Address']};` +
                `${row['Reward Token']};` +
                `${row['Reward Address']};` +
                `${row['Reward Amount'].toFixed(6)};` +
                `${row['Reward sd Value'].toFixed(6)};` +
                `${row['Share % per Protocol'].toFixed(2)}`
            )
        ].join('\n');

        // Write to file
        const dirPath = path.join(__dirname, '..', 'bribes-reports', Date.now().toString());
        fs.mkdirSync(dirPath, { recursive: true });
        const fileName = 'pendle.csv';
        fs.writeFileSync(path.join(dirPath, fileName), csvContent);
        console.log(`Report generated for Pendle: ${fileName}`);

    } catch (error) {
        console.error("An error occurred:", error);
    }
}

main().catch(console.error);