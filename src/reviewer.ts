import * as https from 'https';
import type { ReviewerOptions, FilterOptions, Finding, Severity } from './types';

export const REVIEW_PROMPT = `You are a Principal Software Engineer. Review the code diff below and respond ONLY with the structured format shown. Do NOT include any thinking, planning, or conversational text. Do NOT attempt to modify files or run commands. Just analyze and respond.

## Severity Levels
- **CRITICAL**: Security vulnerabilities, data loss, logic failures
- **HIGH**: Performance bottlenecks, architectural violations, functional bugs
- **MEDIUM**: Input validation gaps, error handling issues, naming problems
- **LOW**: Documentation improvements, minor readability issues

## Rules
- Only comment on changed lines (+ or - lines in the diff)
- Include precise line numbers and code suggestions
- Skip package-lock.json, yarn.lock, and minified files

## Required Output Format (follow EXACTLY)

### Summary
[1-2 sentence summary of what the changes do]

### Findings

**[SEVERITY]** \`filename:line_number\`
> Description of the issue
> Rationale: Brief explanation of why the suggested fix resolves this issue
\`\`\`suggestion
// suggested fix
\`\`\`

---

(Repeat for each finding. Separate findings with ---)

If no issues found, respond with:

### Summary
[summary]

### Findings
No significant issues found. The code changes look good.
`;

export class Reviewer {
  private geminiApiKey: string;
  private model: string;

  constructor({ geminiApiKey, model = 'gemini-3-pro-preview' }: ReviewerOptions) {
    this.geminiApiKey = geminiApiKey;
    this.model = model;
  }

  private isStructuredReview(output: string): boolean {
    return /###\s*(Summary|Findings)/i.test(output) ||
           /\*\*\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\*\*/.test(output);
  }

  async reviewWithAPI(diffContent: string): Promise<string> {
    if (!/^[a-zA-Z0-9._-]+$/.test(this.model)) {
      throw new Error(`Invalid model name: ${this.model}`);
    }

    const body = JSON.stringify({
      systemInstruction: {
        parts: [{
          text: 'You are a code review tool. Output ONLY structured markdown in the exact format requested. Never include thinking, planning, or conversational text.',
        }],
      },
      contents: [{
        parts: [{
          text: `${REVIEW_PROMPT}\n\nHere is the diff to review:\n\n${diffContent}`,
        }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${this.model}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-goog-api-key': this.geminiApiKey,
        },
        rejectUnauthorized: true,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.candidates?.[0]) {
              resolve(parsed.candidates[0].content.parts[0].text);
            } else if (parsed.error) {
              reject(new Error(`Gemini API error: ${parsed.error.message}`));
            } else {
              reject(new Error('Unexpected Gemini API response'));
            }
          } catch (err) {
            reject(new Error(`Failed to parse Gemini response: ${(err as Error).message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async review(diffContent: string): Promise<string> {
    if (!diffContent || diffContent.trim().length === 0) {
      return 'No code changes to review.';
    }

    console.log('Reviewing code changes via Gemini REST API...');
    const apiResult = await this.reviewWithAPI(diffContent);
    if (apiResult && this.isStructuredReview(apiResult)) {
      console.log('Gemini REST API review completed successfully.');
      return apiResult;
    }

    throw new Error('Review failed: API response was empty or not in the expected structured format.');
  }

  filterDiff(diffContent: string, { includePatterns, excludePatterns, maxDiffSize }: FilterOptions): string {
    if (!diffContent) return '';

    if (diffContent.length > maxDiffSize) {
      console.warn(`Diff size (${diffContent.length}) exceeds max (${maxDiffSize}), truncating...`);
      diffContent = diffContent.substring(0, maxDiffSize) + '\n\n... [diff truncated due to size]';
    }

    const excludes = excludePatterns
      ? excludePatterns.split(',').map(p => p.trim()).filter(Boolean)
      : [];

    const includes = includePatterns
      ? includePatterns.split(',').map(p => p.trim()).filter(Boolean)
      : [];

    if (excludes.length === 0 && includes.length === 0) {
      return diffContent;
    }

    const fileSections = diffContent.split(/^diff --git /m);
    const filtered = fileSections.filter((section) => {
      if (!section.trim()) return false;

      const fileMatch = section.match(/a\/(.+?) b\//);
      if (!fileMatch) return true;

      const filePath = fileMatch[1];

      for (const pattern of excludes) {
        if (this.matchPattern(filePath, pattern)) return false;
      }

      if (includes.length > 0) {
        return includes.some(pattern => this.matchPattern(filePath, pattern));
      }

      return true;
    });

    return filtered.map((s, i) => i === 0 ? s : `diff --git ${s}`).join('');
  }

  private matchPattern(filePath: string, pattern: string): boolean {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp('^' + escaped + '$');
    return regex.test(filePath) || filePath.endsWith(pattern.replace(/^\*/, ''));
  }

  parseFindings(reviewText: string): Finding[] {
    const findings: Finding[] = [];
    const findingRegex = /\*\*\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\*\*\s*`([^`]+)`/g;
    let match: RegExpExecArray | null;

    while ((match = findingRegex.exec(reviewText)) !== null) {
      const severity = match[1] as Severity;
      const location = match[2];
      const [file, line] = location.split(':');

      const startIdx = match.index + match[0].length;
      const nextMatch = findingRegex.exec(reviewText);
      const endIdx = nextMatch ? nextMatch.index : reviewText.length;
      findingRegex.lastIndex = match.index + match[0].length;

      const block = reviewText.substring(startIdx, endIdx);

      const description = block
        .replace(/^[\s>]+/, '')
        .trim();

      let suggestion: string | undefined;
      const suggestionMatch = block.match(/```suggestion\n([\s\S]*?)```/);
      if (suggestionMatch) {
        suggestion = suggestionMatch[1];
      }

      let rationale: string | undefined;
      const rationaleMatch = block.match(/Rationale:\s*(.+)/);
      if (rationaleMatch) {
        rationale = rationaleMatch[1].trim();
      }

      findings.push({
        severity,
        file: file || 'unknown',
        line: parseInt(line, 10) || 0,
        description,
        suggestion,
        rationale,
      });
    }

    return findings;
  }

  hasCriticalFindings(reviewText: string): boolean {
    return /\*\*\[?CRITICAL\]?\*\*/.test(reviewText);
  }
}
