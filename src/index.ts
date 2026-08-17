import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { searchCodex } from "./client.ts";
import { resolveSearchProvider } from "./provider.ts";
import type { CodexSearchParams } from "./types.ts";

const parameters = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "The web search query.",
		}),
		domains: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: 20,
				description: "Restrict results to these domains.",
			}),
		),
		recencyDays: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Restrict results to the last number of days.",
			}),
		),
		responseLength: Type.Optional(
			Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")], {
				description: "Desired search response length.",
			}),
		),
	},
	{ additionalProperties: false },
);

export default function codexSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "codex_search",
		label: "Codex Search",
		description:
			"Search the public web through the active OpenAI Responses provider and return a synthesized answer with sources.",
		promptSnippet: "Search current external information with Codex Search.",
		promptGuidelines: [
			"Use codex_search for current external information, and cite source URLs returned in its output or results.",
		],
		parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			void toolCallId;
			onUpdate?.({
				content: [{ type: "text", text: "Searching current external sources…" }],
				details: {},
			});

			const provider = await resolveSearchProvider(ctx, signal);
			const result = await searchCodex(provider, params as CodexSearchParams, signal);

			return {
				content: [{ type: "text", text: result.output }],
				details: {
					provider: provider.provider,
					model: provider.model,
					results: result.results,
				},
			};
		},
	});
}
