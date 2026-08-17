export type SearchLength = "short" | "medium" | "long";

export interface CodexSearchParams {
  query: string;
  domains?: string[];
  recencyDays?: number;
  responseLength?: SearchLength;
}

export interface SearchProvider {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
}

export interface SearchResult {
  output: string;
  encryptedOutput?: string;
  results?: unknown[];
}
