import type { CodexSearchParams, SearchProvider, SearchResult } from "./types.js";

const MAX_ERROR_BODY_LENGTH = 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function buildSearchUrl(baseUrl: string): string {
	const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "").replace(/\/responses$/, "");
	if (!normalizedBaseUrl) {
		throw new Error("Codex search base URL is empty");
	}
	return `${normalizedBaseUrl}/alpha/search`;
}

export async function searchCodex(
	provider: SearchProvider,
	params: CodexSearchParams,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<SearchResult> {
	const headers = new Headers(provider.headers);
	headers.set("content-type", "application/json");

	if (provider.apiKey !== undefined && !headers.has("authorization")) {
		headers.set("authorization", `Bearer ${provider.apiKey}`);
	}
	const sensitiveValues = collectSensitiveValues(provider);

	const searchQuery: {
		q: string;
		recency?: number;
		domains?: string[];
	} = { q: params.query };

	if (params.recencyDays !== undefined) {
		searchQuery.recency = params.recencyDays;
	}
	if (params.domains !== undefined) {
		searchQuery.domains = params.domains;
	}

	const response = await fetchImpl(buildSearchUrl(provider.baseUrl), {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({
			id: crypto.randomUUID(),
			model: provider.model,
			input: params.query,
			commands: {
				search_query: [searchQuery],
				response_length: params.responseLength ?? "medium",
			},
			settings: {
				allowed_callers: ["direct"],
				external_web_access: true,
			},
			max_output_tokens: 8000,
		}),
	});

	const responseText = await readResponseText(response);
	const responseJson = parseJson(responseText);

	if (!response.ok) {
		const errorBody = formatErrorBody(responseText, responseJson, sensitiveValues);
		throw createHttpError(response, errorBody, sensitiveValues);
	}

	if (!isJsonObject(responseJson)) {
		throw new Error(
			`Codex search returned an invalid JSON response (HTTP ${response.status}): expected an object`,
		);
	}
	if (typeof responseJson.output !== "string") {
		throw new Error(
			`Codex search returned an invalid response (HTTP ${response.status}): expected output to be a string`,
		);
	}
	if (
		responseJson.encrypted_output !== undefined &&
		typeof responseJson.encrypted_output !== "string"
	) {
		throw new Error(
			`Codex search returned an invalid response (HTTP ${response.status}): expected encrypted_output to be a string`,
		);
	}
	if (responseJson.results !== undefined && !Array.isArray(responseJson.results)) {
		throw new Error(
			`Codex search returned an invalid response (HTTP ${response.status}): expected results to be an array`,
		);
	}

	const result: SearchResult = { output: responseJson.output };
	if (responseJson.encrypted_output !== undefined) {
		result.encryptedOutput = responseJson.encrypted_output;
	}
	if (responseJson.results !== undefined) {
		result.results = responseJson.results;
	}
	return result;
}

async function readResponseText(response: Response): Promise<string> {
	if (response.body === null) {
		return "";
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const textChunks: string[] = [];
	let byteLength = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			textChunks.push(decoder.decode());
			return textChunks.join("");
		}

		byteLength += value.byteLength;
		if (byteLength > MAX_RESPONSE_BYTES) {
			try {
				await reader.cancel();
			} finally {
				throw new Error(`Codex search response exceeded ${MAX_RESPONSE_BYTES} bytes`);
			}
		}
		textChunks.push(decoder.decode(value, { stream: true }));
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectSensitiveValues(provider: SearchProvider): string[] {
	const values = new Set<string>();
	if (provider.apiKey) {
		values.add(provider.apiKey);
	}
	for (const [name, value] of Object.entries(provider.headers)) {
		const normalizedName = name.toLowerCase();
		if (
			value &&
			(normalizedName === "authorization" ||
				normalizedName === "proxy-authorization" ||
				normalizedName === "x-api-key" ||
				normalizedName.includes("token") ||
				normalizedName.includes("secret") ||
				normalizedName.includes("key"))
		) {
			values.add(value);
		}
	}
	return [...values].sort((left, right) => right.length - left.length);
}

function redactSensitiveValues(text: string, sensitiveValues: readonly string[]): string {
	let redacted = text;
	for (const value of sensitiveValues) {
		redacted = redacted.replaceAll(value, "[REDACTED]");
	}
	return redacted;
}

function formatErrorBody(
	responseText: string,
	responseJson: unknown,
	sensitiveValues: readonly string[],
): string {
	let body = responseText;
	if (isJsonObject(responseJson)) {
		const error = responseJson.error;
		if (isJsonObject(error) && typeof error.message === "string") {
			body = error.message;
		} else if (typeof responseJson.message === "string") {
			body = responseJson.message;
		}
	}
	return redactSensitiveValues(body.trim(), sensitiveValues).slice(0, MAX_ERROR_BODY_LENGTH);
}

function createHttpError(
	response: Response,
	body: string,
	sensitiveValues: readonly string[],
): Error & { status: number } {
	const safeStatusText = redactSensitiveValues(response.statusText, sensitiveValues);
	const statusDescription = safeStatusText
		? `${response.status} ${safeStatusText}`
		: String(response.status);
	const suffix = body ? `: ${body}` : "";
	const error = new Error(`Codex search request failed (HTTP ${statusDescription})${suffix}`) as Error & {
		status: number;
	};
	error.name = "CodexSearchError";
	error.status = response.status;
	return error;
}
