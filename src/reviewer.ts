import * as https from 'https';
import type { ReviewerOptions, FilterOptions, Finding, StructuredReviewResponse } from './types';

export const REVIEW_PROMPT = `You are a Principal Software Engineer performing a code review.

## Severity Levels
- **CRITICAL**: Security vulnerabilities, data loss, logic failures
- **HIGH**: Performance bottlenecks, architectural violations, functional bugs
- **MEDIUM**: Input validation gaps, error handling issues, naming problems
- **LOW**: Documentation improvements, minor readability issues

## Rules
- Only comment on changed lines (+ or - lines in the diff)
- Include precise line numbers and code suggestions
- Skip package-lock.json, yarn.lock, and minified files
- If no issues found, return an empty findings array
`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
      description: '1-2 sentence summary of what the code changes do',
    },
    findings: {
      type: 'ARRAY',
      description: 'List of code review findings. Empty array if no issues found.',
      items: {
        type: 'OBJECT',
        properties: {
          severity: {
            type: 'STRING',
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
            description: 'Severity level of the finding',
          },
          file: {
            type: 'STRING',
            description: 'File path where the issue is found',
          },
          line: {
            type: 'INTEGER',
            description: 'Line number where the issue is found',
          },
          description: {
            type: 'STRING',
            description: 'Description of the issue',
          },
          suggestion: {
            type: 'STRING',
            description: 'Suggested code fix',
          },
          rationale: {
            type: 'STRING',
            description: 'Brief explanation of why the suggested fix resolves this issue',
          },
        },
        required: ['severity', 'file', 'line', 'description'],
      },
    },
  },
  required: ['summary', 'findings'],
};

export class Reviewer {
  private geminiApiKey: string;
  private model: string;

  constructor({ geminiApiKey, model = 'gemini-3-pro-preview' }: ReviewerOptions) {
    this.geminiApiKey = geminiApiKey;
    this.model = model;
  }

  async reviewWithAPI(diffContent: string): Promise<StructuredReviewResponse> {
    if (!/^[a-zA-Z0-9._-]+$/.test(this.model)) {
      throw new Error(`Invalid model name: ${this.model}`);
    }

    const body = JSON.stringify({
      systemInstruction: {
        parts: [{
          text: 'You are a code review tool. Analyze the diff and return structured findings.',
        }],
      },
      contents: [{
        parts: [{
          text: `${REVIEW_PROMPT}\n\nHere is the diff to review:\n\n${diffContent}`,
        }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 65536,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
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
              const candidate = parsed.candidates[0];
              if (candidate.finishReason === 'MAX_TOKENS') {
                reject(new Error('Gemini response truncated due to token limit. Try reducing diff size.'));
                return;
              }
              const content = candidate.content;

              if (!content || !content.parts || !content.parts[0]) {
                reject(new Error('Gemini returned no content (likely blocked by safety filters).'));
                return;
              }

              const text = content.parts[0].text;
              const cleanedText = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const result = JSON.parse(cleanedText);

              if (!result.findings || !Array.isArray(result.findings)) {
                throw new Error('Invalid response format: findings array is missing');
              }

              resolve(result as StructuredReviewResponse);
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

  async review(diffContent: string): Promise<StructuredReviewResponse> {
    if (!diffContent || diffContent.trim().length === 0) {
      return { summary: 'No code changes to review.', findings: [] };
    }

    console.log('Reviewing code changes via Gemini REST API...');
    const result = await this.reviewWithAPI(diffContent);
    console.log('Gemini REST API review completed successfully.');
    return result;
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

  hasCriticalFindings(findings: Finding[]): boolean {
    return findings.some(f => f.severity.toUpperCase() === 'CRITICAL');
  }
}
