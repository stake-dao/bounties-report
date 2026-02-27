/**
 * Provider-agnostic LLM client interface.
 *
 * Any implementation (Anthropic, OpenAI, ZEN proxy, local model, mock for
 * tests, etc.) only needs to satisfy this contract.
 */

// ── Shared types ─────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  /** Max tokens in the response. */
  maxTokens?: number;
  /** Optional system-level instruction. */
  systemPrompt?: string;
  /** HTTP timeout in ms. */
  timeout?: number;
}

export interface LLMJsonResult<T> {
  result: T;
  /** Raw text returned by the model before JSON parsing. */
  rawText: string;
  /** Set when the API call or JSON parsing failed. */
  error?: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface LLMClient {
  /** Human-readable model identifier (e.g. "claude-sonnet-4-6", "kimi-latest"). */
  readonly model: string;
  /** Provider label for display (e.g. "opencode-zen/anthropic"). */
  readonly provider: string;

  /** Multi-turn conversation with optional system prompt. Throws on error. */
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<string>;

  /** Single-turn convenience wrapper around chat(). */
  ask(prompt: string, options?: LLMOptions): Promise<string>;

  /**
   * Ask the model and parse its JSON response.
   * Strips markdown fences. Never throws — returns fallback + error on failure.
   */
  analyzeJson<T>(
    prompt: string,
    fallback: T,
    options?: LLMOptions
  ): Promise<LLMJsonResult<T>>;
}
