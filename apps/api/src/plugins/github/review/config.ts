import { resolveFileSecret } from "../../../utils/file-secret";

export type ReviewProvider = {
  provider: "openai" | "gemini";
  apiKey: string;
  baseUrl?: string;
};

export function getReviewProvider(): ReviewProvider | null {
  const provider = process.env.KANEO_AI_REVIEW_PROVIDER?.trim();
  if (provider !== "openai" && provider !== "gemini") return null;

  const apiKey = resolveFileSecret(
    provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY",
  )?.trim();
  if (!apiKey) return null;

  const baseUrl =
    provider === "openai" ? process.env.OPENAI_BASE_URL?.trim() : undefined;
  return { provider, apiKey, baseUrl };
}
