export interface GitLabConfig {
  token: string;
  tokenType: 'private' | 'job' | 'oauth';
  apiUrl: string;
  projectId: string;
  projectPath: string;
  mrIid: string;
  sourceBranch: string;
  targetBranch: string;
  commitSha: string;
  pipelineUrl: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

export interface VertexAIConfig {
  projectId: string;
  region: string;
  token: string;
}

export interface ReviewConfig {
  maxFiles: number;
  maxDiffSize: number;
  severityThreshold: string;
  includePatterns: string;
  excludePatterns: string;
  postAsNote: boolean;
  failOnCritical: boolean;
}

export interface AppConfig {
  gitlab: GitLabConfig;
  gemini: GeminiConfig;
  vertexai: VertexAIConfig;
  review: ReviewConfig;
}
