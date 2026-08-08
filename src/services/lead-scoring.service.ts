import type { LeadCaptureRecord } from './lead-capture.service';
import { SalesPlaybookService } from './sales-playbook.service';

export type LeadGrade = 'A' | 'B' | 'C' | 'D';
export type LeadTemperature = 'hot' | 'warm' | 'nurture' | 'incomplete';

export interface LeadScoreResult {
  score: number;
  grade: LeadGrade;
  temperature: LeadTemperature;
  reasons: string[];
  riskFlags: string[];
  nextBestAction: string;
  nextBestActionCode: string;
}

export class LeadScoringService {
  constructor(private readonly playbook: SalesPlaybookService) {}

  evaluate(record: LeadCaptureRecord): LeadScoreResult {
    const reasons: string[] = [];
    const riskFlags: string[] = [];
    let score = Math.round(record.completionPercent * 0.45);
    reasons.push(`Qualification completeness contributes ${score}/45.`);

    if (record.clientName && record.clientPhone) {
      score += 5;
      reasons.push('Named contact and WhatsApp identity captured.');
    }

    if (record.inquiryPurpose === 'selling') {
      score += this.scoreSeller(record, reasons, riskFlags);
    } else if (record.inquiryPurpose === 'buying') {
      score += this.scoreBuyer(record, reasons, riskFlags);
    } else {
      riskFlags.push('Intent is not confirmed.');
    }

    if (this.containsUnknownCriticalValue(record)) {
      score -= 5;
      riskFlags.push('One or more critical answers remain unknown or require confirmation.');
    }

    score = Math.max(0, Math.min(100, score));
    const thresholds = this.playbook.getScoringThresholds();
    const temperature: LeadTemperature =
      record.completionPercent < 60
        ? 'incomplete'
        : score >= thresholds.hotThreshold
          ? 'hot'
          : score >= thresholds.warmThreshold
            ? 'warm'
            : score >= thresholds.nurtureThreshold
              ? 'nurture'
              : 'incomplete';
    const grade: LeadGrade =
      score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 45 ? 'C' : 'D';
    const action = this.nextAction(record, riskFlags);

    return {
      score,
      grade,
      temperature,
      reasons,
      riskFlags,
      nextBestAction: action.label,
      nextBestActionCode: action.code,
    };
  }

  private scoreSeller(
    record: LeadCaptureRecord,
    reasons: string[],
    riskFlags: string[]
  ): number {
    let points = 0;
    if (record.termsAccepted === 'yes') {
      points += 5;
      reasons.push('Seller accepted the stated process and commercial terms.');
    }

    const financials = [
      record.annualRevenueAed,
      record.monthlyNetProfitAed,
      record.desiredSellingPriceAed,
    ].filter(Boolean).length;
    points += financials * 5;
    if (financials === 3) {
      reasons.push('Revenue, net profit, and asking price are all captured.');
    } else if (!record.annualRevenueAed && !record.monthlyNetProfitAed) {
      riskFlags.push('No operating performance figure has been captured yet.');
    }

    const operations = [
      record.yearEstablished,
      record.employeeCount,
      record.leaseDetails,
      record.liabilities,
      record.contractsLicenses,
    ].filter(Boolean).length;
    points += Math.min(10, operations * 2);
    if (operations >= 4) reasons.push('Core operating profile is substantially complete.');

    const urgency = this.timelinePoints(record.saleReasonUrgency);
    points += urgency;
    if (urgency >= 8) reasons.push('Seller indicates a near-term transaction objective.');

    if (record.includedAssets) points += 5;
    return points;
  }

  private scoreBuyer(
    record: LeadCaptureRecord,
    reasons: string[],
    riskFlags: string[]
  ): number {
    let points = 0;
    if (record.buyerBudgetAed) {
      points += 10;
      reasons.push('Buyer budget is captured.');
    }

    const funding = record.buyerFundingStatus.toLowerCase();
    if (/available|cash|ready|proof|доступ|готов|средств|متاح|جاهز/u.test(funding)) {
      points += 10;
      reasons.push('Buyer reports that funds are available.');
    } else if (record.buyerFundingStatus) {
      points += 5;
      riskFlags.push('Buyer funding may depend on financing or further confirmation.');
    }

    const urgency = this.timelinePoints(record.buyerTimeline);
    points += urgency;
    if (urgency >= 8) reasons.push('Buyer indicates a near-term acquisition objective.');

    if (record.specificListingCode) {
      points += 5;
      reasons.push('Buyer identified a specific SHARH listing.');
    }
    if (record.buyerLocation && record.businessType) points += 5;
    if (record.buyerInvolvement && record.buyerAdditionalComments) points += 5;
    return points;
  }

  private timelinePoints(value: string): number {
    const normalized = value.toLowerCase();
    if (!normalized) return 0;
    if (/immediate|asap|urgent|30\s*days?|one\s*month|сроч|немед|месяц|عاجل|فور|شهر/u.test(normalized)) {
      return 10;
    }
    if (/2\s*months?|3\s*months?|quarter|два\s*месяц|три\s*месяц|квартал|شهرين|ثلاثة\s*أشهر/u.test(normalized)) {
      return 8;
    }
    if (/4\s*months?|5\s*months?|6\s*months?|six\s*months|полугод|шест|أربعة\s*أشهر|ستة\s*أشهر/u.test(normalized)) {
      return 6;
    }
    return 3;
  }

  private containsUnknownCriticalValue(record: LeadCaptureRecord): boolean {
    const critical =
      record.inquiryPurpose === 'selling'
        ? [record.annualRevenueAed, record.monthlyNetProfitAed, record.desiredSellingPriceAed]
        : [record.buyerBudgetAed, record.buyerFundingStatus];
    return critical.some(value => /unknown|to confirm|не знаю|уточнить|غير معروف|للتأكيد/iu.test(value));
  }

  private nextAction(
    record: LeadCaptureRecord,
    riskFlags: string[]
  ): { code: string; label: string } {
    const sellerDraftReady =
      record.inquiryPurpose === 'selling' &&
      record.termsAccepted === 'yes' &&
      Boolean(record.businessType && record.businessLocation && record.desiredSellingPriceAed);
    if (sellerDraftReady) {
      return {
        code: 'review_seller_draft',
        label: 'Review the seller draft and verify the reported figures before publishing.',
      };
    }
    if (record.status === 'qualified' || record.completionPercent >= 100) {
      return {
        code: 'review_qualified_lead',
        label:
          record.inquiryPurpose === 'selling'
            ? 'Review the qualified seller information in SHARH and validate critical financial data before follow-up.'
            : 'Review the qualified buyer information in SHARH and validate fit and funding before follow-up.',
      };
    }
    if (record.escalationReason === 'internal_review') {
      return {
        code: 'review_flagged_conversation',
        label: 'Review the flagged conversation in SHARH and decide whether human follow-up is needed.',
      };
    }
    if (record.nextField) {
      return {
        code: `collect_${record.nextField}`,
        label: `Collect the next required field: ${record.nextField}.`,
      };
    }
    if (riskFlags.length > 0) {
      return { code: 'resolve_data_risk', label: 'Clarify the outstanding data-quality risk before progressing.' };
    }
    return { code: 'continue_qualification', label: 'Continue the controlled qualification flow.' };
  }
}
