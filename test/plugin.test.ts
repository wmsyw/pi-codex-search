import { describe, expect, test } from "bun:test";

import codexSearchExtension from "../src/index.ts";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
};

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: {
		type: string;
		additionalProperties: boolean;
		required: string[];
		properties: Record<string, Record<string, unknown>>;
	};
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: ((update: unknown) => void) | undefined,
		context: unknown,
	) => Promise<ToolResult>;
};

function registerExtension(): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	const host = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
	};

	codexSearchExtension(host as never);
	return tools;
}

describe("codex_search extension", () => {
	test("registers one tool and wires a Pi provider context through search execution", async () => {
		const tools = registerExtension();
		expect(tools).toHaveLength(1);

		const [tool] = tools;
		expect(tool).toBeDefined();
		expect(tool.name).toBe("codex_search");
		expect(tool.label).toBe("Codex Search");
		expect(tool.description).toContain("active OpenAI Responses provider");
		expect(tool.promptSnippet).toContain("Codex Search");
		expect(tool.promptGuidelines).toEqual([
			"Use codex_search for current external information, and cite source URLs returned in its output or results.",
		]);

		const schema = tool.parameters;
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(["query"]);
		expect(Object.keys(schema.properties).sort()).toEqual([
			"domains",
			"query",
			"recencyDays",
			"responseLength",
		]);
		expect(schema.properties.query).toMatchObject({
			type: "string",
			minLength: 1,
			description: "The web search query.",
		});
		expect(schema.properties.domains).toMatchObject({
			type: "array",
			maxItems: 20,
			description: "Restrict results to these domains.",
			items: { type: "string", minLength: 1 },
		});
		expect(schema.properties.recencyDays).toMatchObject({
			type: "integer",
			minimum: 1,
			description: "Restrict results to the last number of days.",
		});
		expect(schema.properties.responseLength.description).toBe(
			"Desired search response length.",
		);
		expect(schema.properties.responseLength.anyOf).toEqual([
			{ const: "short", type: "string" },
			{ const: "medium", type: "string" },
			{ const: "long", type: "string" },
		]);

		const originalFetch = globalThis.fetch;
		const requests: Array<{
			input: Parameters<typeof fetch>[0];
			init: Parameters<typeof fetch>[1];
		}> = [];
		const results = [
			{
				title: "Example source",
				url: "https://source.example/article",
			},
		];

		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requests.push({ input, init });
			return new Response(
				JSON.stringify({
					output: "A synthesized answer with a cited source.",
					results,
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as typeof fetch;

		try {
			const updates: unknown[] = [];
			const controller = new AbortController();
			const context = {
				model: {
					api: "openai-responses",
					id: "gpt-5-search",
					provider: "openai",
					baseUrl: "https://api.example.test/v1/responses/",
					headers: { "x-model-header": "model-value" },
				},
				modelRegistry: {
					async getProviderAuth(provider: string) {
						expect(provider).toBe("openai");
						return {
							headers: { "x-resolved-header": "resolved-value" },
						};
					},
				},
			};

			const result = await tool.execute(
				"tool-call-1",
				{
					query: "What changed today?",
					domains: ["source.example"],
					recencyDays: 3,
					responseLength: "long",
				},
				controller.signal,
				(update) => updates.push(update),
				context,
			);

			expect(updates).toEqual([
				{
					content: [{ type: "text", text: "Searching current external sources…" }],
					details: {},
				},
			]);
			expect(requests).toHaveLength(1);
			expect(String(requests[0]?.input)).toBe("https://api.example.test/v1/alpha/search");
			expect(requests[0]?.init?.method).toBe("POST");
			expect(requests[0]?.init?.signal).toBe(controller.signal);

			const headers = new Headers(requests[0]?.init?.headers);
			expect(headers.get("content-type")).toBe("application/json");
			expect(headers.get("x-model-header")).toBe("model-value");
			expect(headers.get("x-resolved-header")).toBe("resolved-value");
			expect(headers.has("authorization")).toBe(false);

			const payload = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
			expect(payload).toEqual({
				id: expect.any(String),
				model: "gpt-5-search",
				input: "What changed today?",
				commands: {
					search_query: [
						{
							q: "What changed today?",
							domains: ["source.example"],
							recency: 3,
						},
					],
					response_length: "long",
				},
				settings: {
					allowed_callers: ["direct"],
					external_web_access: true,
				},
				max_output_tokens: 8000,
			});
			expect(result.content).toEqual([
				{ type: "text", text: "A synthesized answer with a cited source." },
			]);
			expect(result.details).toEqual({
				provider: "openai",
				model: "gpt-5-search",
				results,
			});
			expect(result.details).not.toHaveProperty("apiKey");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rejects execution when the active model does not use the Responses API", async () => {
		const [tool] = registerExtension();
		const originalFetch = globalThis.fetch;
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			throw new Error("fetch must not be called for an incompatible active API");
		}) as typeof fetch;

		try {
			await expect(
				tool.execute(
					"tool-call-2",
					{ query: "This must fail before fetching" },
					new AbortController().signal,
					undefined,
					{
						model: {
							api: "openai-completions",
							id: "legacy-model",
							provider: "openai",
							baseUrl: "https://api.example.test/v1",
						},
						modelRegistry: {
							async getProviderAuth() {
								return {};
							},
						},
					},
				),
			).rejects.toThrow(
				'Wrong active model API: codex_search requires "openai-responses", received "openai-completions"',
			);
			expect(fetchCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
