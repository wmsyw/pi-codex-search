import { describe, expect, test } from "bun:test";

import { resolveSearchProvider } from "../src/provider.ts";

const model = (overrides: Record<string, unknown> = {}) => ({
  api: "openai-responses",
  id: "gpt-5.4",
  provider: "openai",
  baseUrl: "https://model.example/v1",
  ...overrides,
});

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected promise to reject");
}

describe("resolveSearchProvider", () => {
  test("resolves Pi provider auth and gives it precedence over model credentials", async () => {
    const activeModel = model({
      headers: {
        "x-model-only": "model-value",
        "x-shared": "from-model",
      },
    });
    let requestedProvider: string | undefined;

    const resolved = await resolveSearchProvider({
      model: activeModel,
      modelRegistry: {
        getProviderAuth(provider: string) {
          requestedProvider = provider;
          return {
            apiKey: "pi-api-key",
            key: "ignored-legacy-key",
            baseUrl: "https://auth.example/responses/",
            headers: {
              "x-auth-only": "auth-value",
              "x-shared": "from-auth",
            },
          };
        },
      },
    });

    expect(requestedProvider).toBe("openai");
    expect(resolved).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      baseUrl: "https://auth.example/responses/",
      apiKey: "pi-api-key",
      headers: {
        "x-model-only": "model-value",
        "x-shared": "from-auth",
        "x-auth-only": "auth-value",
      },
    });
  });

  test("normalizes mixed-case header collisions so resolved auth wins once", async () => {
    const resolved = await resolveSearchProvider({
      model: model({
        headers: {
          Authorization: "model-secret",
          "X-Model": "model-value",
        },
      }),
      modelRegistry: {
        getProviderAuth() {
          return {
            headers: {
              authorization: "resolved-secret",
              "x-auth": "auth-value",
            },
          };
        },
      },
    });

    expect(resolved.headers).toEqual({
      authorization: "resolved-secret",
      "x-model": "model-value",
      "x-auth": "auth-value",
    });
    expect(Object.keys(resolved.headers).filter((name) => name === "authorization")).toHaveLength(1);
  });

  test("uses the Pi legacy key field and model base URL when auth does not override them", async () => {
    const resolved = await resolveSearchProvider({
      model: model(),
      modelRegistry: {
        getProviderAuth() {
          return { key: "legacy-key", headers: { "x-auth": "present" } };
        },
      },
    });

    expect(resolved.baseUrl).toBe("https://model.example/v1");
    expect(resolved.apiKey).toBe("legacy-key");
    expect(resolved.headers).toEqual({ "x-auth": "present" });
  });

  test("uses the OMP combined resolver result without calling the fallback", async () => {
    const activeModel = model({ headers: { "x-shared": "model", "x-model": "yes" } });
    let combinedModel: unknown;
    let fallbackCalls = 0;

    const resolved = await resolveSearchProvider({
      model: activeModel,
      modelRegistry: {
        getApiKeyAndHeaders(receivedModel: unknown) {
          combinedModel = receivedModel;
          return {
            ok: true,
            apiKey: "combined-key",
            key: "ignored-key",
            baseUrl: "https://combined.example/alpha",
            headers: { "x-shared": "combined", "x-combined": "yes" },
          };
        },
        getApiKey() {
          fallbackCalls += 1;
          return "fallback-key";
        },
      },
    });

    expect(combinedModel).toBe(activeModel);
    expect(fallbackCalls).toBe(0);
    expect(resolved).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      baseUrl: "https://combined.example/alpha",
      apiKey: "combined-key",
      headers: {
        "x-shared": "combined",
        "x-model": "yes",
        "x-combined": "yes",
      },
    });
  });

  test("falls back to OMP getApiKey and forwards the cancellation signal", async () => {
    const activeModel = model();
    const controller = new AbortController();
    let fallbackArguments: unknown[] | undefined;

    const resolved = await resolveSearchProvider(
      {
        model: activeModel,
        modelRegistry: {
          getApiKeyAndHeaders() {
            return { ok: true, headers: { "x-combined": "retained" } };
          },
          getApiKey(...args: unknown[]) {
            fallbackArguments = args;
            return "fallback-key";
          },
        },
      },
      controller.signal,
    );

    expect(fallbackArguments).toEqual([
      activeModel,
      undefined,
      { signal: controller.signal },
    ]);
    expect(resolved.apiKey).toBe("fallback-key");
    expect(resolved.headers).toEqual({ "x-combined": "retained" });
  });

  test("prefers the live models.current() value over the context model snapshot", async () => {
    const staleModel = model({ id: "stale", provider: "stale-provider" });
    const liveModel = model({
      id: "live-responses-model",
      provider: "live-provider",
      baseUrl: "https://live.example/v1",
    });
    let authProvider: string | undefined;

    const resolved = await resolveSearchProvider({
      model: staleModel,
      models: {
        current() {
          return liveModel;
        },
      },
      modelRegistry: {
        getProviderAuth(provider: string) {
          authProvider = provider;
          return { apiKey: "live-key" };
        },
      },
    });

    expect(authProvider).toBe("live-provider");
    expect(resolved.provider).toBe("live-provider");
    expect(resolved.model).toBe("live-responses-model");
    expect(resolved.baseUrl).toBe("https://live.example/v1");
  });

  test("permits a keyless provider resolved through Pi auth", async () => {
    const resolved = await resolveSearchProvider({
      model: model({ provider: "local", baseUrl: "http://127.0.0.1:9000" }),
      modelRegistry: {
        getProviderAuth() {
          return { headers: { "x-local-auth": "session" } };
        },
      },
    });

    expect(resolved).toEqual({
      provider: "local",
      model: "gpt-5.4",
      baseUrl: "http://127.0.0.1:9000",
      apiKey: undefined,
      headers: { "x-local-auth": "session" },
    });
  });

  test("rejects when there is no active model", async () => {
    await expect(
      resolveSearchProvider({ modelRegistry: {} }),
    ).rejects.toThrow(/Missing active model/);
  });

  test.each([
    ["openai-completions"],
    ["openai-codex-responses"],
    [undefined],
  ])("rejects unsupported active model API %p", async (api) => {
    await expect(
      resolveSearchProvider({ model: model({ api }), modelRegistry: {} }),
    ).rejects.toThrow(/requires "openai-responses"/);
  });

  test.each([
    ["model id", { id: "  " }, /Missing active model id/],
    ["provider id", { provider: undefined }, /Missing active model provider/],
  ])("rejects a missing %s", async (_name, overrides, expected) => {
    await expect(
      resolveSearchProvider({ model: model(overrides), modelRegistry: {} }),
    ).rejects.toThrow(expected);
  });

  test("rejects when neither model nor resolved auth supplies a base URL", async () => {
    await expect(
      resolveSearchProvider({
        model: model({ baseUrl: " " }),
        modelRegistry: { getProviderAuth: () => ({ apiKey: "available-key" }) },
      }),
    ).rejects.toThrow(/Missing base URL/);
  });

  test.each([
    [
      "resolved Pi headers container",
      { model: model(), modelRegistry: { getProviderAuth: () => ({ headers: 42 }) } },
      /resolved provider auth headers are not an object/,
    ],
    [
      "resolved Pi header value",
      {
        model: model(),
        modelRegistry: { getProviderAuth: () => ({ headers: { authorization: 42 } }) },
      },
      /resolved provider auth header "authorization" is not a string/,
    ],
    [
      "resolved OMP header value",
      {
        model: model(),
        modelRegistry: {
          getApiKeyAndHeaders: () => ({ ok: true, headers: { authorization: false } }),
        },
      },
      /resolved provider auth header "authorization" is not a string/,
    ],
    [
      "active model header value",
      {
        model: model({ headers: { "x-model": null } }),
        modelRegistry: { getProviderAuth: () => ({}) },
      },
      /active model header "x-model" is not a string/,
    ],
  ])("rejects malformed %s", async (_name, context, expected) => {
    await expect(resolveSearchProvider(context)).rejects.toThrow(expected);
  });

  test("sanitizes Pi resolver failures while retaining provider context", async () => {
    const upstreamSecret = "Bearer upstream-secret-value";
    const upstream = new Error(`credential helper failed with ${upstreamSecret}`);
    const error = await rejectionOf(
      resolveSearchProvider({
        model: model({ provider: "enterprise" }),
        modelRegistry: {
          getProviderAuth() {
            throw upstream;
          },
        },
      }),
    );

    expect(error.message).toContain("Provider credentials resolution failure");
    expect(error.message).toContain("enterprise");
    expect(error.message).toContain("getProviderAuth");
    expect(error.message).not.toContain("credential helper failed");
    expect(error.message).not.toContain(upstreamSecret);
    expect(error.cause).toBeUndefined();
  });

  test("reports a sanitized OMP combined resolver failure without invoking getApiKey", async () => {
    const upstreamSecret = "combined-resolver-secret";
    let fallbackCalls = 0;
    const error = await rejectionOf(
      resolveSearchProvider({
        model: model(),
        modelRegistry: {
          getApiKeyAndHeaders() {
            return { ok: false, error: `login expired for ${upstreamSecret}` };
          },
          getApiKey() {
            fallbackCalls += 1;
            return "must-not-be-used";
          },
        },
      }),
    );

    expect(fallbackCalls).toBe(0);
    expect(error.message).toContain("Provider credentials resolution failure");
    expect(error.message).toContain("openai");
    expect(error.message).toContain("getApiKeyAndHeaders");
    expect(error.message).not.toContain("login expired");
    expect(error.message).not.toContain(upstreamSecret);
    expect(error.cause).toBeUndefined();
  });

  test("sanitizes OMP fallback resolver errors", async () => {
    const upstreamSecret = "keychain-secret-value";
    const upstream = new Error(`keychain locked while reading ${upstreamSecret}`);
    const error = await rejectionOf(
      resolveSearchProvider({
        model: model(),
        modelRegistry: {
          getApiKeyAndHeaders: () => ({ ok: true }),
          getApiKey() {
            throw upstream;
          },
        },
      }),
    );

    expect(error.message).toContain("Provider credentials resolution failure");
    expect(error.message).toContain("openai");
    expect(error.message).toContain("getApiKey");
    expect(error.message).not.toContain("keychain locked");
    expect(error.message).not.toContain(upstreamSecret);
    expect(error.cause).toBeUndefined();
  });

  test("preserves Pi AbortError identity", async () => {
    const abortError = new DOMException("user cancelled", "AbortError");

    const error = await rejectionOf(
      resolveSearchProvider({
        model: model(),
        modelRegistry: {
          getProviderAuth() {
            throw abortError;
          },
        },
      }),
    );

    expect(error).toBe(abortError);
  });

  test("preserves OMP fallback AbortError identity", async () => {
    const abortError = new DOMException("user cancelled", "AbortError");

    const error = await rejectionOf(
      resolveSearchProvider({
        model: model(),
        modelRegistry: {
          getApiKeyAndHeaders: () => ({ ok: true }),
          getApiKey() {
            throw abortError;
          },
        },
      }),
    );

    expect(error).toBe(abortError);
  });

  test("does not leak successfully resolved credentials into a later validation error", async () => {
    const secretKey = "super-secret-provider-key";
    const secretHeader = "super-secret-session-header";
    const error = await rejectionOf(
      resolveSearchProvider({
        model: model({ baseUrl: undefined }),
        modelRegistry: {
          getProviderAuth: () => ({
            apiKey: secretKey,
            headers: { authorization: secretHeader },
          }),
        },
      }),
    );

    expect(error.message).toContain("Missing base URL");
    expect(error.message).not.toContain(secretKey);
    expect(error.message).not.toContain(secretHeader);
  });
});
