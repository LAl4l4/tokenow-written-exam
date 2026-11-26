import OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

export class MissingModelKey extends Error {}

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new MissingModelKey("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  return new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com",
    timeout: 15_000,
    maxRetries: 1,
  });
}

export async function planWithModel(system: string, messages: ChatMessage[]): Promise<unknown> {
  const client = getModelClient();
  const request = {
    model,
    messages: [{ role: "system" as const, content: system }, ...messages],
    thinking: { type: "disabled" },
    response_format: { type: "json_object" as const },
    max_tokens: 1024,
  };
  const response = await client.chat.completions.create(request);
  const choice = response.choices[0];
  if (choice?.finish_reason !== "stop" || !choice.message.content?.trim()) return undefined;
  try {
    return JSON.parse(choice.message.content);
  } catch {
    return undefined;
  }
}
