import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

export async function sendTelegramMessage(
  message: string,
  parseMode: "MarkdownV2" | "HTML" = "MarkdownV2"
) {
  const TELEGRAM_API_KEY = process.env.TELEGRAM_VERIF_API_KEY;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_VERIF_CHAT_ID;

  if (!TELEGRAM_API_KEY || !TELEGRAM_CHAT_ID) {
    console.error(
      "Telegram API key or Chat ID is not set in environment variables."
    );
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_API_KEY}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };

  try {
    const response = await axios.post(url, payload);
    if (response.status !== 200) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.error("Failed to send the message:", error);
  }
}
