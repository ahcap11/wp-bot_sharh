import type { FunnelDirective, LeadCaptureRecord } from './lead-capture.service';
import { SalesPlaybookService } from './sales-playbook.service';

export type QualitySeverity = 'warning' | 'critical';
export interface QualityIssue {
  code: string;
  severity: QualitySeverity;
  detail: string;
}
export interface FunnelQualityResult {
  passed: boolean;
  score: number;
  issues: QualityIssue[];
}

export class FunnelQualityService {
  constructor(private readonly playbook: SalesPlaybookService) {}

  evaluate(
    response: string,
    record?: LeadCaptureRecord,
    _directive?: FunnelDirective
  ): FunnelQualityResult {
    const issues: QualityIssue[] = [];
    const trimmed = response.trim();

    if (!trimmed) {
      issues.push({ code: 'empty_response', severity: 'critical', detail: 'Response is empty.' });
    }
    for (const pattern of this.playbook.getForbiddenClaims()) {
      if (pattern.test(trimmed)) {
        issues.push({
          code: 'forbidden_claim',
          severity: 'critical',
          detail: `Response matched forbidden claim pattern: ${pattern.source}`,
        });
      }
    }

    const questionCount = (trimmed.match(/\?/g) || []).length +
      (trimmed.match(/؟/g) || []).length;
    if (questionCount > 1) {
      issues.push({
        code: 'multiple_questions',
        severity: 'critical',
        detail: `Response contains ${questionCount} questions; maximum is one.`,
      });
    }
    if (trimmed.length > 900) {
      issues.push({ code: 'response_too_long', severity: 'warning', detail: 'WhatsApp response exceeds 900 characters.' });
    }
    if (/\p{Extended_Pictographic}/u.test(trimmed)) {
      issues.push({ code: 'emoji_present', severity: 'warning', detail: 'Professional sales replies should not use emoji.' });
    }
    if (
      record &&
      record.completionPercent < 100 &&
      /create (?:an? )?account|sign up now|register now|создайте аккаунт|зарегистрируйтесь|أنشئ حساب/u.test(trimmed)
    ) {
      issues.push({
        code: 'premature_registration',
        severity: 'critical',
        detail: 'Registration was promoted before qualification and value delivery were complete.',
      });
    }
    const critical = issues.filter(issue => issue.severity === 'critical').length;
    const warnings = issues.length - critical;
    return {
      passed: critical === 0,
      score: Math.max(0, 100 - critical * 35 - warnings * 10),
      issues,
    };
  }
}
