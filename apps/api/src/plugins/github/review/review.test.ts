import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { analyzeReview, formatReview } from "./analyze";
import { buildDiffContext } from "./context";
import { readMergeFailure } from "./merge-failure";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GitHub review reports", () => {
  it("extracts structured findings from either provider", async () => {
    const report = {
      verdict: "changes_requested",
      summary: "Требуется исправление",
      requirements: [],
      findings: [
        {
          file: "app.ts",
          line: 7,
          problem: "Некорректное значение",
          impact: "Неверный результат",
          fix: "Проверить входное значение",
        },
      ],
    };
    const cases = [
      {
        provider: "openai",
        baseUrl: undefined,
        url: "https://api.openai.com/v1/responses",
      },
      {
        provider: "openai",
        baseUrl: "https://sub2api.example.com",
        url: "https://sub2api.example.com/v1/responses",
      },
      {
        provider: "openai",
        baseUrl: "https://sub2api.example.com/openai/v1/",
        url: "https://sub2api.example.com/openai/v1/responses",
      },
      {
        provider: "gemini",
        baseUrl: undefined,
        url: "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent",
      },
    ] as const;
    for (const { provider, baseUrl, url } of cases) {
      const text = JSON.stringify(report);
      const payload =
        provider === "openai"
          ? {
              output: [
                { type: "message", content: [{ type: "output_text", text }] },
              ],
            }
          : { candidates: [{ content: { parts: [{ text }] } }] };
      const fetch = vi.fn().mockResolvedValue(Response.json(payload));
      vi.stubGlobal("fetch", fetch);
      const result = await analyzeReview(
        { provider, model: "test-model", apiKey: "test-key", baseUrl },
        "patch",
      );
      expect(result).toEqual(report);
      expect(formatReview(result)).toContain("**app.ts:7**");
      expect(formatReview(result)).toContain("**Нужны исправления**");
      expect(formatReview(result)).toContain(
        "Как исправить — Проверить входное значение",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ redirect: "error" }),
      );
      const requestBody: unknown = fetch.mock.calls[0]?.[1]?.body;
      expect(requestBody).toEqual(expect.stringContaining("in Russian"));
    }
  });

  it("flags omitted patches and withholds key files", () => {
    const result = buildDiffContext(
      [
        {
          filename: ".env",
          status: "modified",
          patch: "+API_KEY=private",
          changes: 1,
        },
        {
          filename: "app.ts",
          status: "modified",
          patch: "+visible",
          changes: 1,
        },
        { filename: "binary", status: "modified", changes: 1 },
      ],
      "Description",
    );
    expect(result.incomplete).toBe(true);
    expect(result.changes.map((file) => file.path)).toEqual([
      "app.ts",
      "binary",
    ]);
    expect(JSON.stringify(result)).not.toContain("API_KEY");
  });

  it("accepts only marked merge failures from GitHub Actions", () => {
    const body = "<!-- kaneo-merge-failure -->\nResolve conflicts and retry.";
    const comment = {
      body,
      user: { id: 41898282, login: "github-actions[bot]" },
    };
    expect(readMergeFailure(comment)).toBe("Resolve conflicts and retry.");
    expect(
      readMergeFailure({ ...comment, user: { id: 1, login: "user" } }),
    ).toBeNull();
    expect(
      readMergeFailure({ ...comment, body: "Unmarked comment" }),
    ).toBeNull();
  });
});
