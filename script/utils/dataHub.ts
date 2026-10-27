const DEFAULT_DATA_HUB_URL = "https://data-hub.contact-69d.workers.dev";

export function getDataHubUrl(path = ""): string {
  const baseUrl = (process.env.DATA_HUB_URL || DEFAULT_DATA_HUB_URL).replace(/\/+$/, "");
  return path ? `${baseUrl}/${path.replace(/^\/+/, "")}` : baseUrl;
}
