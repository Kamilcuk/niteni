import * as https from 'https';
import { GoogleAuth } from 'google-auth-library';
import type { ReviewerOptions, FilterOptions, Finding, StructuredReviewResponse, VertexAIOptions } from './types';

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
    summary: { type: 'STRING' },
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          severity: { type: 'STRING', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'STRING' },
          line: { type: 'INTEGER' },
          description: { type: 'STRING' },
          suggestion: { type: 'STRING' },
          rationale: { type: 'STRING' },
        },
        required: ['severity', 'file', 'line', 'description'],
      },
    },
  },
  required: ['summary', 'findings'],
};

export class Reviewer {
  private geminiApiKey?: string;
  private vertexAI?: VertexAIOptions;
  private model: string;
  private auth?: GoogleAuth;

  constructor({ geminiApiKey, vertexAI, model = 'gemini-3-flash-preview' }: ReviewerOptions) {
    this.geminiApiKey = geminiApiKey;
    this.vertexAI = vertexAI;
    this.model = model;
    
    if (this.vertexAI) {
      this.auth = new GoogleAuth({
        scopes: 'https://www.googleapis.com/auth/cloud-platform',
      });
    }
  }

  async reviewWithAPI(diffContent: string): Promise<StructuredReviewResponse> {
    const body = JSON.stringify({
      contents: [{
        parts: [{ text: `${REVIEW_PROMPT}\n\nHere is the diff to review:\n\n${diffContent}` }],
      }],
      systemInstruction: {
        parts: [{ text: 'You are a code review tool. Return ONLY structured JSON findings.' }],
      },
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    let hostname: string;
    let path: string;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    };

    if (this.vertexAI) {
      const { projectId, region } = this.vertexAI;
      const client = await this.auth!.getClient();
      const tokenResponse = await client.getAccessToken();
      const token = tokenResponse.token;

      hostname = `${region}-aiplatform.googleapis.com`;
      path = `/v1/projects/${projectId}/locations/${region}/publishers/google/models/${this.model}:generateContent`;
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      hostname = 'generativelanguage.googleapis.com';
      path = `/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`;
    }

    return new Promise((resolve, reject) => {
      const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error(`API status ${res.statusCode}: ${data}`));
            }
            const parsed = JSON.parse(data);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) return reject(new Error('No content returned from Gemini'));
            
            resolve(JSON.parse(text) as StructuredReviewResponse);
          } catch (err) {
            reject(new Error(`Failed to parse response: ${(err as Error).message}\nData: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async review(diffContent: string): Promise<StructuredReviewResponse> {
    if (!diffContent?.trim()) return { summary: 'No code changes.', findings: [] };
    return this.reviewWithAPI(diffContent);
  }

  hasCriticalFindings(findings: Finding[]): boolean {
    return findings.some(f => f.severity === 'CRITICAL');
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
      
      const isExcluded = excludes.some(pattern => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(filePath);
      });

      if (isExcluded) return false;

      if (includes.length > 0) {
        return includes.some(pattern => {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          return regex.test(filePath);
        });
      }

      return true;
    });

    return filtered.join('diff --git ');
  }
}
