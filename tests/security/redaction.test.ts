import { redactSecrets } from "@shared/index";

describe("secret redaction", () => {
  test("redacts private keys and API keys", () => {
    const result = redactSecrets({
      OPENAI_API_KEY: "supersecret-token-1234",
      VERTEX_PRIVATE_KEY: "private-value",
      NEXT_PUBLIC_TITLE: "Deal Pump",
    });

    expect(result.OPENAI_API_KEY).toBe("[REDACTED:1234]");
    expect(result.VERTEX_PRIVATE_KEY).toBe("[REDACTED:alue]");
    expect(result.NEXT_PUBLIC_TITLE).toBe("Deal Pump");
  });
});
