import type { AppConfig } from './types';

const { env } = process;

function resolveToken(): { token: string; tokenType: 'private' | 'job' | 'oauth' } {
  const gitlabToken = env.GITLAB_TOKEN && !env.GITLAB_TOKEN.startsWith('$') ? env.GITLAB_TOKEN : null;
  if (gitlabToken) {
    return { token: gitlabToken, tokenType: 'private' };
  }
  if (env.CI_JOB_TOKEN) {
    return { token: env.CI_JOB_TOKEN, tokenType: 'job' };
  }
  return { token: '', tokenType: 'private' };
}

const { token, tokenType } = resolveToken();

export const config: AppConfig = {
  gitlab: {
    token,
    tokenType,
    apiUrl: env.CI_API_V4_URL || env.GITLAB_API_URL || 'https://gitlab.com/api/v4',
    projectId: env.CI_PROJECT_ID || env.GITLAB_PROJECT_ID || '',
    projectPath: env.CI_PROJECT_PATH || '',
    mrIid: env.CI_MERGE_REQUEST_IID || '',
    sourceBranch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_BRANCH || '',
    targetBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || env.CI_DEFAULT_BRANCH || 'main',
    commitSha: env.CI_COMMIT_SHA || '',
    pipelineUrl: env.CI_PIPELINE_URL || '',
  },

  gemini: {
    apiKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3-flash-preview',
  },

  vertexai: {
    projectId: env.GOOGLE_PROJECT_ID || env.GCP_PROJECT_ID || '',
    region: env.GOOGLE_REGION || env.GCP_REGION || 'us-central1',
    token: '', // Handled dynamically via google-auth-library
  },

  review: {
    maxFiles: parseInt(env.REVIEW_MAX_FILES || '50', 10),
    maxDiffSize: parseInt(env.REVIEW_MAX_DIFF_SIZE || '100000', 10),
    severityThreshold: env.REVIEW_SEVERITY_THRESHOLD || 'LOW',
    includePatterns: env.REVIEW_INCLUDE_PATTERNS || '',
    excludePatterns: env.REVIEW_EXCLUDE_PATTERNS || 'package-lock.json,yarn.lock,*.min.js,*.min.css',
    postAsNote: env.REVIEW_POST_AS_NOTE !== 'false',
    failOnCritical: env.REVIEW_FAIL_ON_CRITICAL !== 'false', // Default to true
  },
};

export function validate(): string[] {
  const errors: string[] = [];

  if (!config.gitlab.token) {
    errors.push('GITLAB_TOKEN or CI_JOB_TOKEN is required');
  }
  if (!config.gitlab.projectId) {
    errors.push('CI_PROJECT_ID or GITLAB_PROJECT_ID is required');
  }

  if (!config.gemini.apiKey && !config.vertexai.projectId) {
    errors.push('Either GOOGLE_API_KEY or GOOGLE_PROJECT_ID is required');
  }

  return errors;
}

export function validateForMR(): string[] {
  const errors = validate();
  if (!config.gitlab.mrIid) {
    errors.push('CI_MERGE_REQUEST_IID is required for MR review mode');
  }
  return errors;
}
