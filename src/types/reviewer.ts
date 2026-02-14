export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ReviewerOptions {
  geminiApiKey: string;
  model?: string;
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
}

export interface ReviewResult {
  review: string;
  hasCritical: boolean;
}
