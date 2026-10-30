import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

async function postToTelegram(
  message: string,
  apiKey: string,
  chatId: string,
  parseMode: "MarkdownV2" | "HTML",
  required = false
): Promise<void> {
  const url = `https://api.telegram.org/bot${apiKey}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };

  try {
    const response = await axios.post(url, payload);
    if (response.status !== 200 || response.data?.ok === false) {
      throw new Error("Telegram rejected the message");
    }
  } catch {
    // Axios errors include the request URL, which contains the bot token.
    if (required) throw new Error("Telegram delivery failed");
    console.error("Telegram delivery failed");
  }
}

export async function sendTelegramMessage(
  message: string,
  parseMode: "MarkdownV2" | "HTML" = "MarkdownV2",
  required = false
) {
  const TELEGRAM_API_KEY = process.env.TELEGRAM_VERIF_API_KEY;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_VERIF_CHAT_ID;

  if (!TELEGRAM_API_KEY || !TELEGRAM_CHAT_ID) {
    if (required) throw new Error("Telegram credentials are not configured");
    console.error(
      "Telegram API key or Chat ID is not set in environment variables."
    );
    return;
  }

  await postToTelegram(message, TELEGRAM_API_KEY, TELEGRAM_CHAT_ID, parseMode, required);
}

/**
 * Send a Telegram message using explicit credentials instead of env vars.
 * Use this when a different bot/chat is needed from the default TELEGRAM_VERIF_* one.
 */
export async function sendTelegramMessageWithCreds(
  message: string,
  apiKey: string,
  chatId: string,
  parseMode: "MarkdownV2" | "HTML" = "HTML"
): Promise<void> {
  await postToTelegram(message, apiKey, chatId, parseMode);
}
