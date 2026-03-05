/**
 * OpenCodeZenClient — LLMClient implementation for the Opencode ZEN API.
 *
 * All models are called via the OpenAI /chat/completions wire format.
 * ZEN's Anthropic /messages endpoint has a server-side bug that causes HTTP 500
 * when the upstream Anthropic API returns any non-200 response.
 *
 * Usage:
 *   const client = createZenClient();           // kimi-k2 (default)
 *   const text   = await client.ask("...");
 *   const parsed = await client.analyzeJson<MyType>("...", fallback);
 */

import axios, { AxiosError } from "axios";
import type { LLMClient, LLMMessage, LLMOptions, LLMJsonResult } from "./llmClient";

// ── Constants ─────────────────────────────────────────────────────────────────

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const ZEN_DEFAULT_MODEL = "kimi-k2";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip markdown code fences the model may add despite instructions. */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * Extract the first complete JSON object from a string.
 * Handles models that wrap JSON in prose or markdown fences.
 */
function extractJson(text: string): string {
  const stripped = stripFences(text);
  // Fast path: already valid JSON
  if (stripped.startsWith("{")) return stripped;
  // Find the first '{' and its matching '}'
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in response");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Unterminated JSON object in response");
}

function axiosErrorDetail(err: unknown): string {
  if (err instanceof AxiosError) {
    return `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data)}`;
  }
  return String(err);
}

// ── Client ────────────────────────────────────────────────────────────────────

class OpenCodeZenClient implements LLMClient {
  readonly model: string;
  readonly provider: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    apiKey: string,
    model: string = ZEN_DEFAULT_MODEL,
    baseUrl: string = ZEN_BASE_URL
  ) {
    if (!apiKey) throw new Error("OpenCode ZEN API key is required");
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.provider = `opencode-zen/openai`;
  }

  // ── Core ───────────────────────────────────────────────────────────────────

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<string> {
    return this.chatOpenAI(messages, options);
  }

  async ask(prompt: string, options: LLMOptions = {}): Promise<string> {
    return this.chat([{ role: "user", content: prompt }], options);
  }

  async analyzeJson<T>(
    prompt: string,
    fallback: T,
    options: LLMOptions = {}
  ): Promise<LLMJsonResult<T>> {
    let rawText = "";
    try {
      rawText = await this.ask(prompt, options);
      const cleaned = extractJson(rawText);
      return { result: JSON.parse(cleaned) as T, rawText };
    } catch (err) {
      return { result: fallback, rawText, error: String(err) };
    }
  }

  // ── OpenAI wire format ─────────────────────────────────────────────────────

  private async chatOpenAI(
    messages: LLMMessage[],
    options: LLMOptions
  ): Promise<string> {
    // Prepend system message if provided
    const fullMessages: Array<{ role: string; content: string }> = [];
    if (options.systemPrompt) {
      fullMessages.push({ role: "system", content: options.systemPrompt });
    }
    fullMessages.push(...messages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? 1024,
      messages: fullMessages,
    };

    try {
      const res = await axios.post(`${this.baseUrl}/chat/completions`, body, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: options.timeout ?? 60_000,
      });
      return (res.data.choices?.[0]?.message?.content ?? "").trim();
    } catch (err) {
      throw new Error(`[${this.model}] OpenAI API error: ${axiosErrorDetail(err)}`);
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an OpenCodeZenClient from env or an explicit key.
 * Convenience wrapper so callers don't need to handle env lookup themselves.
 */
export function createZenClient(
  model: string = ZEN_DEFAULT_MODEL,
  apiKey: string = process.env.OPENCODE_ZEN_API_KEY ?? ""
): OpenCodeZenClient {
  if (!apiKey) throw new Error("OPENCODE_ZEN_API_KEY not set");
  return new OpenCodeZenClient(apiKey, model);
}
