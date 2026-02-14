export interface GitLabAPIOptions {
  apiUrl: string;
  token: string;
  projectId: string;
  tokenType?: 'private' | 'job' | 'oauth';
}

export interface MergeRequest {
  title: string;
  source_branch: string;
  target_branch: string;
  diff_refs?: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  [key: string]: unknown;
}

export interface MergeRequestChange {
  old_path: string;
  new_path: string;
  diff: string;
  [key: string]: unknown;
}

export interface MergeRequestChanges {
  changes: MergeRequestChange[];
  [key: string]: unknown;
}

export interface MergeRequestNote {
  id: number;
  body: string;
  system: boolean;
  [key: string]: unknown;
}

export interface DiffPosition {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  position_type: string;
  old_path?: string;
  new_path?: string;
  old_line?: number;
  new_line?: number;
}
