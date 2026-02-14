import { GitLabAPI } from './gitlab-api';
import { Reviewer } from './reviewer';
import { config, validate, validateForMR } from './config';
import { execSync } from 'child_process';
import type { ReviewResult } from './types';

// Re-export classes and functions
export { GitLabAPI } from './gitlab-api';
export { Reviewer, REVIEW_PROMPT } from './reviewer';
export { config, validate, validateForMR } from './config';

// Re-export all types from centralized types folder
export type {
  AppConfig,
  GitLabConfig,
  GeminiConfig,
  ReviewConfig,
  GitLabAPIOptions,
  MergeRequest,
  MergeRequestChange,
  MergeRequestChanges,
  MergeRequestNote,
  DiffPosition,
  Severity,
  ReviewerOptions,
  FilterOptions,
  Finding,
  ReviewResult,
} from './types';

export const REVIEW_HEADER = '<!-- niteni-review -->';

const BOT_SIGNATURE = '\n\n---\n*Reviewed by [Niteni](https://gitlab.com/anthropic-tools/niteni) — AI-powered code review powered by [Gemini CLI](https://github.com/gemini-cli-extensions/code-review)*';

export async function runMergeRequestReview(): Promise<ReviewResult> {
  const errors = validateForMR();
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  const gitlab = new GitLabAPI({
    apiUrl: config.gitlab.apiUrl,
    token: config.gitlab.token,
    projectId: config.gitlab.projectId,
    tokenType: config.gitlab.tokenType,
  });

  const reviewer = new Reviewer({
    geminiApiKey: config.gemini.apiKey,
    model: config.gemini.model,
  });

  const mrIid = config.gitlab.mrIid;
  console.log(`API URL:    ${config.gitlab.apiUrl}`);
  console.log(`Project ID: ${config.gitlab.projectId}`);
  console.log(`MR IID:     !${mrIid}`);
  console.log(`Token:      ${config.gitlab.token ? config.gitlab.token.slice(0, 4) + '****' : '(empty)'} (${config.gitlab.tokenType})`);
  console.log(`GITLAB_TOKEN env: ${process.env.GITLAB_TOKEN ? process.env.GITLAB_TOKEN.slice(0, 8) + '****' : '(not set)'}`);

  const [mr, changes] = await Promise.all([
    gitlab.getMergeRequest(mrIid),
    gitlab.getMergeRequestChanges(mrIid),
  ]);

  console.log(`MR Title: ${mr.title}`);
  console.log(`Source: ${mr.source_branch} -> Target: ${mr.target_branch}`);
  console.log(`Changes: ${changes.changes.length} file(s)`);

  let diffContent = '';
  for (const change of changes.changes) {
    if (change.diff) {
      diffContent += `diff --git a/${change.old_path} b/${change.new_path}\n`;
      diffContent += change.diff + '\n';
    }
  }

  diffContent = reviewer.filterDiff(diffContent, {
    includePatterns: config.review.includePatterns,
    excludePatterns: config.review.excludePatterns,
    maxDiffSize: config.review.maxDiffSize,
  });

  if (!diffContent.trim()) {
    console.log('No reviewable changes found after filtering.');
    return { review: 'No reviewable changes found.', hasCritical: false };
  }

  console.log(`Diff size: ${diffContent.length} characters`);
  console.log('Running Gemini code review...');

  const reviewResult = await reviewer.review(diffContent);
  console.log('Review completed.');

  if (config.review.postAsNote) {
    try {
      const existingNotes = await gitlab.getMergeRequestNotes(mrIid);
      for (const note of existingNotes) {
        if (note.body?.includes(REVIEW_HEADER) && note.system === false) {
          await gitlab.deleteMergeRequestNote(mrIid, note.id);
          console.log(`Deleted previous review note #${note.id}`);
        }
      }
    } catch (err) {
      console.warn('Could not clean up previous review notes:', (err as Error).message);
    }

    const noteBody = `${REVIEW_HEADER}\n\n## Niteni - Code Review\n\n${reviewResult}${BOT_SIGNATURE}`;
    await gitlab.postMergeRequestNote(mrIid, noteBody);
    console.log('Review posted as MR note.');
  }

  const hasCritical = reviewer.hasCriticalFindings(reviewResult);
  if (hasCritical) {
    console.warn('CRITICAL issues found in the review!');
  }

  return { review: reviewResult, hasCritical };
}

export async function runDiffReview(): Promise<ReviewResult> {
  const errors = validate();
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  const reviewer = new Reviewer({
    geminiApiKey: config.gemini.apiKey,
    model: config.gemini.model,
  });

  const targetBranch = config.gitlab.targetBranch;
  console.log(`Getting diff against ${targetBranch}...`);

  let diffContent: string;
  try {
    diffContent = execSync(
      `git diff -U5 --merge-base origin/${targetBranch}`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
  } catch {
    diffContent = execSync(
      `git diff origin/${targetBranch}...HEAD`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
  }

  diffContent = reviewer.filterDiff(diffContent, {
    includePatterns: config.review.includePatterns,
    excludePatterns: config.review.excludePatterns,
    maxDiffSize: config.review.maxDiffSize,
  });

  if (!diffContent.trim()) {
    console.log('No changes to review.');
    return { review: 'No changes to review.', hasCritical: false };
  }

  console.log(`Diff size: ${diffContent.length} characters`);
  console.log('Running Gemini code review...');

  const reviewResult = await reviewer.review(diffContent);
  console.log('\n' + reviewResult);

  return {
    review: reviewResult,
    hasCritical: reviewer.hasCriticalFindings(reviewResult),
  };
}
