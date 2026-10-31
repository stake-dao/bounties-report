export function getDataHubUrl(path = ""): string {
  const baseUrl = process.env.DATA_HUB_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("DATA_HUB_URL must be set to the Hub base URL");
  return path ? `${baseUrl}/${path.replace(/^\/+/, "")}` : baseUrl;
}
