import { afterEach, expect, it, vi } from "vitest";
import axios from "axios";
import { sendTelegramMessage } from "../../utils/telegramUtils";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("requires configured delivery only for callers that opt in", async () => {
  vi.stubEnv("TELEGRAM_VERIF_API_KEY", "");
  vi.stubEnv("TELEGRAM_VERIF_CHAT_ID", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(sendTelegramMessage("test")).resolves.toBeUndefined();
  await expect(sendTelegramMessage("test", "HTML", true)).rejects.toThrow("credentials are not configured");
});

it("fails required delivery and redacts credential-bearing errors while preserving best-effort callers", async () => {
  vi.stubEnv("TELEGRAM_VERIF_API_KEY", "test-secret");
  vi.stubEnv("TELEGRAM_VERIF_CHAT_ID", "test-chat");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(axios.post).mockRejectedValue(new Error("https://api.telegram.org/bottest-secret/sendMessage"));
  await expect(sendTelegramMessage("test", "HTML", true)).rejects.toThrow(/^Telegram delivery failed$/);
  await expect(sendTelegramMessage("test")).resolves.toBeUndefined();
  expect(JSON.stringify(errors.mock.calls)).not.toContain("test-secret");
  vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: false } });
  await expect(sendTelegramMessage("test", "HTML", true)).rejects.toThrow("delivery failed");
  vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
  await expect(sendTelegramMessage("test", "HTML", true)).resolves.toBeUndefined();
});
