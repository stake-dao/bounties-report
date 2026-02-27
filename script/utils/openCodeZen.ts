/**
 * OpenCodeZenClient — LLMClient implementation for the Opencode ZEN API.
 *
 * ZEN proxies many models under one API key but exposes two wire formats:
 *   - Anthropic (/messages)     → claude-* models
 *   - OpenAI   (/chat/completions) → everything else (Kimi, Qwen, GPT, etc.)
 *
 * Format is auto-detected from the model name; no extra config needed.
 *
 * Usage:
 *   const client = createZenClient();                                 // claude-sonnet-4-6
 *   const kimi   = createZenClient("kimi-latest");
 *   const text   = await client.ask("Summarise this: ...");
 *   const parsed = await client.analyzeJson<MyType>("...", fallback);
 */

import axios, { AxiosError } from "axios";
import type { LLMClient, LLMMessage, LLMOptions, LLMJsonResult } from "./llmClient";

// ── Constants ─────────────────────────────────────────────────────────────────

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const ZEN_DEFAULT_MODEL = "claude-sonnet-4-6";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip markdown code fences the model may add despite instructions. */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
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
    this.provider = `opencode-zen/${this.wireFormat}`;
  }

  // ── Format detection ───────────────────────────────────────────────────────

  /** Claude models → Anthropic wire format; everything else → OpenAI. */
  private get wireFormat(): "anthropic" | "openai" {
    return this.model.startsWith("claude-") ? "anthropic" : "openai";
  }

  // ── Core ───────────────────────────────────────────────────────────────────

  async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<string> {
    return this.wireFormat === "anthropic"
      ? this.chatAnthropic(messages, options)
      : this.chatOpenAI(messages, options);
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
      return { result: JSON.parse(stripFences(rawText)) as T, rawText };
    } catch (err) {
      return { result: fallback, rawText, error: String(err) };
    }
  }

  // ── Anthropic wire format ──────────────────────────────────────────────────

  private async chatAnthropic(
    messages: LLMMessage[],
    options: LLMOptions
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? 1024,
      messages,
    };
    if (options.systemPrompt) body.system = options.systemPrompt;

    try {
      const res = await axios.post(`${this.baseUrl}/messages`, body, {
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: options.timeout ?? 60_000,
      });
      return (res.data.content?.[0]?.text ?? "").trim();
    } catch (err) {
      throw new Error(`[${this.model}] Anthropic API error: ${axiosErrorDetail(err)}`);
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
