import { describe, expect, test } from "bun:test";
import { WebRedaction } from "../src/web/redaction.ts";

describe("Web permanent and optional redaction", () => {
  test("known fixture secrets are removed in nested, multiline, URL and error content", () => {
    const filter = new WebRedaction(["fixture-credential-value"]);
    const result = filter.storage({ nested: ["text fixture-credential-value\nmore"], url: "https://example.test/?key=fixture-credential-value", password: "fixture password" });
    expect(JSON.stringify(result)).not.toContain("fixture-credential-value");
    expect(JSON.stringify(result)).not.toContain("fixture password");
    expect(filter.storage("Bearer fixture-value\nCookie: session=fixture\napi_key=fixture\n-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----")).not.toContain("fixture");
  });

  test("ordinary privacy is switchable but secrets are permanently filtered", () => {
    const filter = new WebRedaction([]);
    const input = "person@example.test +86 13800138000 192.0.2.1 2001:db8::1 /Users/example/project C:\\Users\\Example\\file token=fixture";
    const disabled = filter.display(input, { redactionEnabled: false, version: 2 });
    expect(disabled).toContain("person@example.test");
    expect(disabled).toContain("/Users/example/project");
    expect(disabled).not.toContain("token=fixture");
    const enabled = filter.display(input, { redactionEnabled: true, version: 1 });
    for (const text of ["person@example.test", "13800138000", "192.0.2.1", "2001:db8::1", "/Users/example/project", "C:\\Users\\Example\\file"]) expect(enabled).not.toContain(text);
  });

  test("one response uses one policy snapshot and safe storage leaves ordinary privacy intact", () => {
    const filter = new WebRedaction(["fixture-credential-value"]);
    const raw = "task /Users/example/project fixture-credential-value";
    const stored = filter.storage(raw);
    expect(stored).toContain("/Users/example/project");
    expect(stored).not.toContain("fixture-credential-value");
    expect(raw).toContain("fixture-credential-value");
    const wrapped = filter.response({ text: raw }, { redactionEnabled: true, version: 4 });
    expect(wrapped.settingsVersion).toBe(4);
    expect(wrapped.data.text).not.toContain("/Users/example/project");
  });
});
