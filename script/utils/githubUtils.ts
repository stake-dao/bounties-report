import axios from "axios";

export interface GaugeInfo {
    name: string;
    reward: string;
}

export interface LatestRewards {
    totalVoterRewards: string;
    resultsByPeriod: {
        [period: string]: {
            [address: string]: GaugeInfo;
        };
    };
}

export async function getLatestJson(
    repoPath: string,
    directoryPath: string
): Promise<LatestRewards> {
    const url = `https://api.github.com/repos/${repoPath}/contents/${directoryPath}`;
    const response = await axios.get(url);

    if (response.status === 200) {
        const files = response.data;
        let latestFile = null;
        let latestDate = new Date(0);

        for (const file of files) {
            const dateStr = file.name.split("_").pop()!.replace(".json", "");
            const fileDate = new Date(dateStr.split("-").reverse().join("-"));
            if (fileDate > latestDate) {
                latestDate = fileDate;
                latestFile = file as any;
            }
        }
        if (latestFile) {
            const fileContent = await axios.get(
                (latestFile as { download_url: string }).download_url
            );
            return fileContent.data;
        }
    }

    throw new Error("Failed to retrieve latest JSON file");
}
