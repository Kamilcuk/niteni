export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface VertexAIOptions {
  projectId: string;
  region: string;
  token?: string;
}

export interface ReviewerOptions {
  geminiApiKey?: string;
  model?: string;
  vertexAI?: VertexAIOptions;
}

export interface FilterOptions {
  includePatterns: string;
  excludePatterns: string;
  maxDiffSize: number;
}

export interface Finding {
  severity: Severity;
  file: string;
  line: number;
  description: string;
  suggestion?: string;
  rationale?: string;
}

export interface StructuredReviewResponse {
  summary: string;
  findings: Finding[];
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  hasCritical: boolean;
}
