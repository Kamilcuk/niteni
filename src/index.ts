import { GitLabAPI } from './gitlab-api';
import { Reviewer } from './reviewer';
import { config, validate, validateForMR } from './config';
import { execFileSync } from 'child_process';
import type { ReviewResult, DiffPosition, Finding } from './types';

// Re-export classes and functions
export { GitLabAPI } from './gitlab-api';
export { Reviewer, REVIEW_PROMPT } from './reviewer';
export { config, validate, validateForMR } from './config';

// Re-export all types from centralized types folder
export type {
  AppConfig,
  GitLabConfig,
  GeminiConfig,
  VertexAIConfig,
  ReviewConfig,
  GitLabAPIOptions,
  MergeRequest,
  MergeRequestChange,
  MergeRequestChanges,
  MergeRequestNote,
  DiffPosition,
  Severity,
  VertexAIOptions,
  ReviewerOptions,
  FilterOptions,
  Finding,
  StructuredReviewResponse,
  ReviewResult,
} from './types';

export const REVIEW_HEADER = '<!-- niteni-review -->';

const BOT_SIGNATURE = '\n\n---\n*Reviewed by [Niteni](https://github.com/denyherianto/niteni) — AI-powered code review powered by [Gemini CLI](https://github.com/gemini-cli-extensions/code-review)*';

function formatFindingsAsMarkdown(summary: string, findings: Finding[]): string {
  let output = `### Summary\n${summary}\n\n### Findings\n\n`;

  if (findings.length === 0) {
    output += 'No significant issues found. The code changes look good.\n';
    return output;
  }

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    output += `**[${f.severity}]** \`${f.file}:${f.line}\`\n`;
    output += `> ${f.description}\n`;
    if (f.rationale) {
      output += `> Rationale: ${f.rationale}\n`;
    }
    if (f.suggestion) {
      output += `\`\`\`suggestion\n${f.suggestion}\n\`\`\`\n`;
    }
    if (i < findings.length - 1) {
      output += '\n---\n\n';
    }
  }

  return output;
}

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
    vertexAI: config.vertexai.projectId ? config.vertexai : undefined,
  });

  const mrIid = config.gitlab.mrIid;
  const [mr, changes] = await Promise.all([
    gitlab.getMergeRequest(mrIid),
    gitlab.getMergeRequestChanges(mrIid),
  ]);

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
    return { summary: 'No reviewable changes found.', findings: [], hasCritical: false };
  }

  const reviewResponse = await reviewer.review(diffContent);
  const { summary, findings } = reviewResponse;

  if (config.review.postAsNote) {
    // Clean up previous inline discussions and notes
    try {
      const discussions = await gitlab.getMergeRequestDiscussions(mrIid);
      for (const discussion of discussions) {
        const notes: any[] = discussion.notes || [];
        const firstNote = notes[0];
        if (firstNote && firstNote.body?.includes(REVIEW_HEADER) && !firstNote.system) {
          // Keep comments that were resolved (author fixed / applied suggestion)
          if (firstNote.resolved || discussion.resolved) {
            console.log(`Keeping resolved discussion ${discussion.id}`);
            continue;
          }
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

    // Post inline comments from structured findings
    const diffRefs = mr.diff_refs;
    console.log(`Found ${findings.length} finding(s). diff_refs: ${diffRefs ? 'available' : 'missing'}`);

    if (findings.length > 0) {
      let inlineCount = 0;
      for (const finding of findings) {
        if (!finding.file || finding.file === 'unknown' || !finding.line) continue;

        const severityEmoji: Record<string, string> = {
          CRITICAL: ':rotating_light:',
          HIGH: ':warning:',
          MEDIUM: ':large_blue_circle:',
          LOW: ':information_source:',
        };
        const emoji = severityEmoji[finding.severity] || ':speech_balloon:';

        let body = `${REVIEW_HEADER}\n\n`;
        body += `#### ${emoji} ${finding.severity} \u2014 \`${finding.file}:${finding.line}\`\n\n`;
        body += `**Issue:** ${finding.description}\n`;

        if (finding.rationale) {
          body += `\n**Rationale:** ${finding.rationale}\n`;
        }

        if (finding.suggestion) {
          body += `\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\`\n`;
        }

        // Try inline diff comment first, fall back to general discussion
        let posted = false;
        if (diffRefs) {
          const position: DiffPosition = {
            base_sha: diffRefs.base_sha,
            start_sha: diffRefs.start_sha,
            head_sha: diffRefs.head_sha,
            position_type: 'text',
            new_path: finding.file,
            old_path: finding.file,
            new_line: finding.line,
          };

          try {
            await gitlab.postMergeRequestDiscussion(mrIid, body, position);
            posted = true;
            inlineCount++;
          } catch (err) {
            console.warn(`Inline comment failed for ${finding.file}:${finding.line}: ${(err as Error).message}`);
          }
        }

        // Fallback: post as general discussion without position
        if (!posted) {
          try {
            await gitlab.postMergeRequestDiscussion(mrIid, body);
            inlineCount++;
            console.log(`Posted ${finding.file}:${finding.line} as general discussion (fallback).`);
          } catch (err) {
            console.warn(`Could not post discussion for ${finding.file}:${finding.line}:`, (err as Error).message);
          }
        }
      }
      console.log(`Posted ${inlineCount} comment(s).`);
    }
  }

  const hasCritical = reviewer.hasCriticalFindings(findings);
  if (hasCritical) {
    console.warn('CRITICAL issues found in the review!');
  }

  return { summary, findings, hasCritical };
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
    vertexAI: config.vertexai.projectId ? config.vertexai : undefined,
  });

  const targetBranch = config.gitlab.targetBranch;
  console.log(`Getting diff against ${targetBranch}...`);

  let diffContent: string;
  try {
    diffContent = execFileSync(
      'git', ['diff', '-U5', '--merge-base', `origin/${targetBranch}`],
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
  } catch {
    diffContent = execFileSync(
      'git', ['diff', `origin/${targetBranch}...HEAD`],
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
    return { summary: 'No changes to review.', findings: [], hasCritical: false };
  }

  console.log(`Diff size: ${diffContent.length} characters`);
  console.log('Running Gemini code review...');

  const reviewResponse = await reviewer.review(diffContent);
  const { summary, findings } = reviewResponse;

  console.log('\n' + formatFindingsAsMarkdown(summary, findings));

  return {
    summary,
    findings,
    hasCritical: reviewer.hasCriticalFindings(findings),
  };
}
