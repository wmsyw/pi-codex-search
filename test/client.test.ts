import { describe, expect, mock, test } from "bun:test";

import { buildSearchUrl, searchCodex } from "../src/client.js";
import type { CodexSearchParams, SearchProvider } from "../src/types.js";

type RecordedFetchCall = {
	input: RequestInfo | URL;
	init: RequestInit | undefined;
};

function makeProvider(overrides: Partial<SearchProvider> = {}): SearchProvider {
	return {
		provider: "openai",
		model: "gpt-5-codex",
		baseUrl: "https://api.example.test/v1",
		headers: {},
		...overrides,
	};
}

function mockFetchResponse(body: string, responseInit: ResponseInit = {}) {
	const calls: RecordedFetchCall[] = [];
	const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response(body, responseInit);
	}) as unknown as typeof fetch;

	return { calls, fetchMock };
}

function jsonResponse(value: unknown, responseInit: ResponseInit = {}) {
	return mockFetchResponse(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
		...responseInit,
	});
}

function recordedHeaders(call: RecordedFetchCall): Headers {
	return new Headers(call.init?.headers);
}

async function captureError(promise: Promise<unknown>): Promise<Error & { status?: number }> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		return error as Error & { status?: number };
	}
	throw new Error("Expected promise to reject");
}

describe("buildSearchUrl", () => {
	test.each([
		["https://api.example.test/v1/", "https://api.example.test/v1/alpha/search"],
		["https://api.example.test/v1///", "https://api.example.test/v1/alpha/search"],
		["https://api.example.test/v1/responses", "https://api.example.test/v1/alpha/search"],
		["https://api.example.test/v1/responses/", "https://api.example.test/v1/alpha/search"],
	])("joins %s to the normalized search path", (baseUrl, expected) => {
		expect(buildSearchUrl(baseUrl)).toBe(expected);
	});
});

describe("searchCodex requests", () => {
	test("posts the exact default search payload to /alpha/search", async () => {
		const { calls, fetchMock } = jsonResponse({ output: "answer" });

		await searchCodex(
			makeProvider({ baseUrl: "https://api.example.test/v1/responses/" }),
			{ query: "what changed?" },
			undefined,
			fetchMock,
		);

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(String(call.input)).toBe("https://api.example.test/v1/alpha/search");
		expect(call.init?.method).toBe("POST");
		expect(recordedHeaders(call).get("content-type")).toBe("application/json");

		const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
		expect(body.id).toEqual(expect.any(String));
		expect(body.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(body).toEqual({
			id: body.id,
			model: "gpt-5-codex",
			input: "what changed?",
			commands: {
				search_query: [{ q: "what changed?" }],
				response_length: "medium",
			},
			settings: {
				allowed_callers: ["direct"],
				external_web_access: true,
			},
			max_output_tokens: 8000,
		});
	});

	test("includes domains, recency, and a custom response length", async () => {
		const { calls, fetchMock } = jsonResponse({ output: "answer" });
		const params: CodexSearchParams = {
			query: "release notes",
			domains: ["example.com", "docs.example.com"],
			recencyDays: 30,
			responseLength: "long",
		};

		await searchCodex(makeProvider(), params, undefined, fetchMock);

		const body = JSON.parse(String(calls[0]!.init?.body)) as {
			commands: unknown;
		};
		expect(body.commands).toEqual({
			search_query: [
				{
					q: "release notes",
					domains: ["example.com", "docs.example.com"],
					recency: 30,
				},
			],
			response_length: "long",
		});
	});

	test("preserves provider headers and existing Authorization regardless of casing", async () => {
		const { calls, fetchMock } = jsonResponse({ output: "answer" });

		await searchCodex(
			makeProvider({
				apiKey: "must-not-replace-existing-auth",
				headers: {
					"X-Provider-Header": "provider-value",
					aUtHoRiZaTiOn: "Token provider-credential",
					"Content-Type": "text/plain",
				},
			}),
			{ query: "headers" },
			undefined,
			fetchMock,
		);

		const headers = recordedHeaders(calls[0]!);
		expect(headers.get("x-provider-header")).toBe("provider-value");
		expect(headers.get("authorization")).toBe("Token provider-credential");
		expect(headers.get("content-type")).toBe("application/json");
	});

	test("injects bearer authorization when an API key is available", async () => {
		const { calls, fetchMock } = jsonResponse({ output: "answer" });

		await searchCodex(
			makeProvider({ apiKey: "secret-api-key" }),
			{ query: "authorized" },
			undefined,
			fetchMock,
		);

		expect(recordedHeaders(calls[0]!).get("authorization")).toBe("Bearer secret-api-key");
	});

	test("sends no Authorization header for a keyless provider", async () => {
		const { calls, fetchMock } = jsonResponse({ output: "answer" });

		await searchCodex(makeProvider(), { query: "public" }, undefined, fetchMock);

		expect(recordedHeaders(calls[0]!).has("authorization")).toBe(false);
	});

	test("passes the caller's AbortSignal through by identity", async () => {
		const { calls, fetchMock } = jsonResponse({ output: "answer" });
		const controller = new AbortController();

		await searchCodex(makeProvider(), { query: "cancelable" }, controller.signal, fetchMock);

		expect(calls[0]!.init?.signal).toBe(controller.signal);
	});
});

describe("searchCodex responses", () => {
	test("maps output, encrypted output, and opaque result values", async () => {
		const opaqueResults = [
			{ type: "computer_initialize_state", id: "7", nested: { arbitrary: true } },
			42,
			null,
			["unmodeled", "shape"],
		];
		const { fetchMock } = jsonResponse({
			output: "final answer",
			encrypted_output: "encrypted-state",
			results: opaqueResults,
		});

		await expect(
			searchCodex(makeProvider(), { query: "map response" }, undefined, fetchMock),
		).resolves.toEqual({
			output: "final answer",
			encryptedOutput: "encrypted-state",
			results: opaqueResults,
		});
	});

	test("accepts an older response without results", async () => {
		const { fetchMock } = jsonResponse({ output: "legacy answer" });

		await expect(
			searchCodex(makeProvider(), { query: "legacy" }, undefined, fetchMock),
		).resolves.toEqual({ output: "legacy answer" });
	});

	test("rejects malformed JSON", async () => {
		const { fetchMock } = mockFetchResponse("{not valid json", { status: 200 });

		const error = await captureError(
			searchCodex(makeProvider(), { query: "bad json" }, undefined, fetchMock),
		);
		expect(error.message).toBe(
			"Codex search returned an invalid JSON response (HTTP 200): expected an object",
		);
	});

	test("rejects a response whose output is missing or not a string", async () => {
		for (const responseBody of [{}, { output: 17 }]) {
			const { fetchMock } = jsonResponse(responseBody);
			const error = await captureError(
				searchCodex(makeProvider(), { query: "bad output" }, undefined, fetchMock),
			);
			expect(error.message).toBe(
				"Codex search returned an invalid response (HTTP 200): expected output to be a string",
			);
		}
	});

	test("rejects results that are not an array", async () => {
		const { fetchMock } = jsonResponse({ output: "answer", results: { unexpected: true } });

		const error = await captureError(
			searchCodex(makeProvider(), { query: "bad results" }, undefined, fetchMock),
		);
		expect(error.message).toBe(
			"Codex search returned an invalid response (HTTP 200): expected results to be an array",
		);
	});

	test("rethrows an AbortError from the response body reader by identity", async () => {
		const abortError = new DOMException("body read aborted", "AbortError");
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(abortError);
			},
		});
		const fetchMock = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

		const error = await captureError(
			searchCodex(makeProvider(), { query: "aborted read" }, undefined, fetchMock),
		);

		expect(error).toBe(abortError);
	});

	test("cancels an oversized streaming response before consuming the full body", async () => {
		const maxResponseBytes = 8 * 1024 * 1024;
		const chunk = new Uint8Array(1024 * 1024);
		const totalChunks = 20;
		let chunksRead = 0;
		let cancelCalled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunksRead === totalChunks) {
					controller.close();
					return;
				}
				chunksRead += 1;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelCalled = true;
			},
		});
		const fetchMock = mock(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

		const error = await captureError(
			searchCodex(makeProvider(), { query: "oversized stream" }, undefined, fetchMock),
		);

		expect(error.message).toBe(`Codex search response exceeded ${maxResponseBytes} bytes`);
		expect(cancelCalled).toBe(true);
		expect(chunksRead).toBeLessThan(totalChunks);
	});
});

describe("searchCodex HTTP errors", () => {
	test("uses a JSON API error message and exposes the HTTP status without leaking the API key", async () => {
		const apiKey = "super-secret-json-key";
		const { fetchMock } = jsonResponse(
			{ error: { message: "rate limit exceeded" } },
			{ status: 429, statusText: "Too Many Requests" },
		);

		const error = await captureError(
			searchCodex(
				makeProvider({ apiKey }),
				{ query: "limited" },
				undefined,
				fetchMock,
			),
		);

		expect(error.name).toBe("CodexSearchError");
		expect(error.status).toBe(429);
		expect(error.message).toBe(
			"Codex search request failed (HTTP 429 Too Many Requests): rate limit exceeded",
		);
		expect(error.message).not.toContain(apiKey);
	});

	test("uses text errors, caps the body at 1000 characters, and does not expose the API key", async () => {
		const apiKey = "super-secret-text-key";
		const longBody = "x".repeat(1200);
		const { fetchMock } = mockFetchResponse(longBody, {
			status: 502,
			statusText: "Bad Gateway",
		});

		const error = await captureError(
			searchCodex(
				makeProvider({ apiKey }),
				{ query: "upstream" },
				undefined,
				fetchMock,
			),
		);

		expect(error.name).toBe("CodexSearchError");
		expect(error.status).toBe(502);
		expect(error.message).toBe(
			`Codex search request failed (HTTP 502 Bad Gateway): ${"x".repeat(1000)}`,
		);
		expect(error.message).not.toContain(apiKey);
	});

	test("redacts API key and sensitive provider header values echoed by a JSON error", async () => {
		const apiKey = "json-provider-api-key-secret";
		const authorization = "Bearer json-authorization-secret";
		const xApiKey = "json-x-api-key-secret";
		const safePrefix = "json failure before credentials";
		const echoedMessage =
			`${safePrefix}: ${apiKey}; auth=${authorization}; x-api-key=${xApiKey}; ` +
			"safe-detail-".repeat(150);
		const { fetchMock } = jsonResponse(
			{ error: { message: echoedMessage } },
			{ status: 401, statusText: "Unauthorized" },
		);

		const error = await captureError(
			searchCodex(
				makeProvider({
					apiKey,
					headers: {
						Authorization: authorization,
						"X-Api-Key": xApiKey,
					},
				}),
				{ query: "redact json" },
				undefined,
				fetchMock,
			),
		);

		const errorPrefix = "Codex search request failed (HTTP 401 Unauthorized): ";
		expect(error.message.startsWith(errorPrefix)).toBe(true);
		const displayedBody = error.message.slice(errorPrefix.length);
		expect(displayedBody).toContain(safePrefix);
		expect(displayedBody.length).toBeLessThanOrEqual(1000);
		expect(error.message).not.toContain(apiKey);
		expect(error.message).not.toContain(authorization);
		expect(error.message).not.toContain(xApiKey);
	});

	test("redacts API key and sensitive provider header values echoed by a capped text error", async () => {
		const apiKey = "text-provider-api-key-secret";
		const authorization = "Token text-authorization-secret";
		const xApiKey = "text-x-api-key-secret";
		const safePrefix = "text failure before credentials";
		const echoedBody =
			`${safePrefix}: ${apiKey}; auth=${authorization}; x-api-key=${xApiKey}; ` +
			"safe-detail-".repeat(150);
		const { fetchMock } = mockFetchResponse(echoedBody, {
			status: 403,
			statusText: "Forbidden",
		});

		const error = await captureError(
			searchCodex(
				makeProvider({
					apiKey,
					headers: {
						authorization,
						"x-api-key": xApiKey,
					},
				}),
				{ query: "redact text" },
				undefined,
				fetchMock,
			),
		);

		const errorPrefix = "Codex search request failed (HTTP 403 Forbidden): ";
		expect(error.message.startsWith(errorPrefix)).toBe(true);
		const displayedBody = error.message.slice(errorPrefix.length);
		expect(displayedBody).toContain(safePrefix);
		expect(displayedBody.length).toBeLessThanOrEqual(1000);
		expect(error.message).not.toContain(apiKey);
		expect(error.message).not.toContain(authorization);
		expect(error.message).not.toContain(xApiKey);
	});
});
