import { GitLabAPI } from './gitlab-api';
import { Reviewer } from './reviewer';
import { config, validate, validateForMR } from './config';
import { execSync } from 'child_process';
import type { ReviewResult, DiffPosition } from './types';

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

const BOT_SIGNATURE = '\n\n---\n*Reviewed by [Niteni](https://github.com/denyherianto/niteni) — AI-powered code review powered by [Gemini CLI](https://github.com/gemini-cli-extensions/code-review)*';

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
    // Clean up previous inline discussions and notes
    try {
      const discussions = await gitlab.getMergeRequestDiscussions(mrIid);
      for (const discussion of discussions) {
        const notes: any[] = discussion.notes || [];
        const firstNote = notes[0];
        if (firstNote && firstNote.body?.includes(REVIEW_HEADER) && !firstNote.system) {
          try {
            await gitlab.deleteMergeRequestDiscussionNote(mrIid, discussion.id, firstNote.id);
            console.log(`Deleted previous review discussion ${discussion.id}`);
          } catch {
            // If discussion deletion fails, try as a regular note
            try {
              await gitlab.deleteMergeRequestNote(mrIid, firstNote.id);
            } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      console.warn('Could not clean up previous review discussions:', (err as Error).message);
    }

    // Parse findings and post inline comments
    const findings = reviewer.parseFindings(reviewResult);
    const diffRefs = mr.diff_refs;

    if (diffRefs && findings.length > 0) {
      let inlineCount = 0;
      for (const finding of findings) {
        if (!finding.file || finding.file === 'unknown' || !finding.line) continue;

        const position: DiffPosition = {
          base_sha: diffRefs.base_sha,
          start_sha: diffRefs.start_sha,
          head_sha: diffRefs.head_sha,
          position_type: 'text',
          new_path: finding.file,
          old_path: finding.file,
          new_line: finding.line,
        };

        let body = `${REVIEW_HEADER}\n\n**[${finding.severity}]** \`${finding.file}:${finding.line}\`\n\n`;

        // Extract description without the suggestion block for the comment body
        const descWithoutSuggestion = finding.description
          .replace(/```suggestion\n[\s\S]*?```/, '')
          .replace(/---\s*$/, '')
          .trim();
        body += `> ${descWithoutSuggestion}\n`;

        if (finding.suggestion) {
          body += `\n\`\`\`suggestion\n${finding.suggestion}\`\`\`\n`;
        }

        try {
          await gitlab.postMergeRequestDiscussion(mrIid, body, position);
          inlineCount++;
        } catch (err) {
          console.warn(`Could not post inline comment for ${finding.file}:${finding.line}:`, (err as Error).message);
        }
      }
      console.log(`Posted ${inlineCount} inline comment(s).`);
    }

    // Post summary as a general MR note
    const summaryMatch = reviewResult.match(/### Summary\s*\n([\s\S]*?)(?=\n### |$)/);
    const summaryText = summaryMatch ? summaryMatch[1].trim() : reviewResult;
    const findingsSummary = findings.length > 0
      ? `\n\n**Findings:** ${findings.length} issue(s) posted as inline comments.`
      : '';

    const noteBody = `${REVIEW_HEADER}\n\n## Niteni - Code Review\n\n### Summary\n${summaryText}${findingsSummary}${BOT_SIGNATURE}`;
    await gitlab.postMergeRequestNote(mrIid, noteBody);
    console.log('Summary posted as MR note.');
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
