import type { SearchProvider } from "./types";

type UnknownRecord = Record<string, unknown>;

type ActiveModel = UnknownRecord & {
  api?: unknown;
  id?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  headers?: unknown;
};

type ProviderAuth = UnknownRecord & {
  apiKey?: unknown;
  key?: unknown;
  headers?: unknown;
  baseUrl?: unknown;
};

type ApiKeyAndHeadersResult = UnknownRecord & {
  ok?: unknown;
  apiKey?: unknown;
  key?: unknown;
  headers?: unknown;
  baseUrl?: unknown;
  error?: unknown;
};

type ModelRegistry = UnknownRecord & {
  getProviderAuth?: (provider: string) => ProviderAuth | undefined | Promise<ProviderAuth | undefined>;
  getApiKeyAndHeaders?: (model: ActiveModel) => ApiKeyAndHeadersResult | Promise<ApiKeyAndHeadersResult>;
  getApiKey?: (
    model: ActiveModel,
    sessionId?: undefined,
    options?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
};

type ExtensionContext = UnknownRecord & {
  model?: unknown;
  models?: unknown;
  modelRegistry?: unknown;
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readHeaders(value: unknown, source: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error(`Provider credentials resolution failure: ${source} headers are not an object`);
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new Error(
        `Provider credentials resolution failure: ${source} header ${JSON.stringify(name)} is not a string`,
      );
    }
    headers[name.toLowerCase()] = headerValue;
  }
  return headers;
}

function isAbortError(error: unknown): error is { name: "AbortError" } {
  return isRecord(error) && error.name === "AbortError";
}

function credentialsError(provider: string, stage: string): Error {
  return new Error(`Provider credentials resolution failure for ${JSON.stringify(provider)} during ${stage}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getActiveModel(ctx: unknown): ActiveModel {
  if (!isRecord(ctx)) {
    throw new Error("Missing active model: extension context is unavailable");
  }

  const context = ctx as ExtensionContext;
  let candidate: unknown;
  if (isRecord(context.models) && typeof context.models.current === "function") {
    try {
      candidate = context.models.current();
    } catch (error) {
      throw new Error(`Missing active model: models.current() failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
  candidate ??= context.model;

  if (!isRecord(candidate)) {
    throw new Error("Missing active model: neither models.current() nor model provided one");
  }
  return candidate as ActiveModel;
}

function getRegistry(ctx: ExtensionContext, provider: string): ModelRegistry {
  if (!isRecord(ctx.modelRegistry)) {
    throw credentialsError(provider, "model registry is unavailable");
  }
  return ctx.modelRegistry as ModelRegistry;
}

function readResolvedKey(value: unknown): string | undefined {
  return nonemptyString(value);
}

export async function resolveSearchProvider(
  ctx: unknown,
  signal?: AbortSignal,
): Promise<SearchProvider> {
  const model = getActiveModel(ctx);
  const api = nonemptyString(model.api);
  if (api !== "openai-responses") {
    throw new Error(
      `Wrong active model API: codex_search requires "openai-responses", received ${
        api ? JSON.stringify(api) : "a missing API identifier"
      }`,
    );
  }

  const modelId = nonemptyString(model.id);
  if (!modelId) {
    throw new Error("Missing active model id: codex_search requires a nonempty model id");
  }
  const providerId = nonemptyString(model.provider);
  if (!providerId) {
    throw new Error("Missing active model provider: codex_search requires a nonempty provider id");
  }

  const context = ctx as ExtensionContext;
  const registry = getRegistry(context, providerId);
  let baseUrl = nonemptyString(model.baseUrl);
  let apiKey: string | undefined;
  let resolvedHeaders: Record<string, string> = {};

  if (typeof registry.getProviderAuth === "function") {
    let auth: ProviderAuth | undefined;
    try {
      auth = await registry.getProviderAuth(providerId);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw credentialsError(providerId, "getProviderAuth");
    }
    if (auth !== undefined && !isRecord(auth)) {
      throw credentialsError(providerId, "getProviderAuth returned an invalid result");
    }
    if (auth) {
      apiKey = readResolvedKey(auth.apiKey) ?? readResolvedKey(auth.key);
      resolvedHeaders = readHeaders(auth.headers, "resolved provider auth");
      baseUrl = nonemptyString(auth.baseUrl) ?? baseUrl;
    }
  } else {
    let combinedKeyResolved = false;
    if (typeof registry.getApiKeyAndHeaders === "function") {
      let result: ApiKeyAndHeadersResult;
      try {
        result = await registry.getApiKeyAndHeaders(model);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw credentialsError(providerId, "getApiKeyAndHeaders");
      }
      if (!isRecord(result) || typeof result.ok !== "boolean") {
        throw credentialsError(providerId, "getApiKeyAndHeaders returned an invalid result");
      }
      if (result.ok !== true) {
        throw credentialsError(providerId, "getApiKeyAndHeaders returned an unsuccessful result");
      }
      apiKey = readResolvedKey(result.apiKey) ?? readResolvedKey(result.key);
      combinedKeyResolved = apiKey !== undefined;
      resolvedHeaders = readHeaders(result.headers, "resolved provider auth");
      baseUrl = nonemptyString(result.baseUrl) ?? baseUrl;
    }

    if (!combinedKeyResolved && typeof registry.getApiKey === "function") {
      try {
        apiKey = readResolvedKey(await registry.getApiKey(model, undefined, { signal }));
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw credentialsError(providerId, "getApiKey");
      }
    } else if (
      typeof registry.getApiKeyAndHeaders !== "function" &&
      typeof registry.getApiKey !== "function"
    ) {
      throw credentialsError(providerId, "no supported credential resolver");
    }
  }

  if (!baseUrl) {
    throw new Error(
      `Missing base URL for active provider ${JSON.stringify(providerId)} and model ${JSON.stringify(modelId)}`,
    );
  }

  return {
    provider: providerId,
    model: modelId,
    baseUrl,
    apiKey,
    headers: {
      ...readHeaders(model.headers, "active model"),
      ...resolvedHeaders,
    },
  };
}
