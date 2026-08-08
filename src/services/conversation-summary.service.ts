import type { LeadCaptureRecord } from './lead-capture.service';

export class ConversationSummaryService {
  build(record: LeadCaptureRecord): string {
    return record.inquiryPurpose === 'selling'
      ? this.buildSellerSummary(record)
      : record.inquiryPurpose === 'buying'
        ? this.buildBuyerSummary(record)
        : 'Intent has not been confirmed yet.';
  }

  private buildSellerSummary(record: LeadCaptureRecord): string {
    const facts: string[] = [];
    const subject = record.businessType || 'Business';
    const location = record.businessLocation ? ` in ${record.businessLocation}` : '';
    facts.push(`${subject}${location}.`);

    if (record.annualRevenueAed) {
      facts.push(`Reported annual revenue: ${record.annualRevenueAed}.`);
    }
    if (record.desiredSellingPriceAed) {
      facts.push(`Expected price: ${record.desiredSellingPriceAed}.`);
    }
    if (record.monthlyNetProfitAed) {
      facts.push(`Reported monthly net profit: ${record.monthlyNetProfitAed}.`);
    }
    if (record.termsAccepted === 'yes') {
      facts.push('SHARH fee terms accepted.');
    }
    if (record.status === 'qualified') {
      facts.push('Initial seller intake is ready for review.');
    } else if (record.nextField) {
      facts.push(`Still needed: ${this.friendlyField(record.nextField)}.`);
    }
    return facts.join(' ');
  }

  private buildBuyerSummary(record: LeadCaptureRecord): string {
    const facts: string[] = [];
    const sector = record.businessType || 'Any sector';
    facts.push(`Buyer search: ${sector}.`);
    if (record.buyerLocation) facts.push(`Location: ${record.buyerLocation}.`);
    if (record.buyerBudgetAed) facts.push(`Budget: ${record.buyerBudgetAed}.`);
    if (record.buyerMinimumAnnualProfitAed) {
      facts.push(`Minimum annual profit: ${record.buyerMinimumAnnualProfitAed}.`);
    }
    if (record.buyerMinimumRoiPct) facts.push(`Minimum ROI: ${record.buyerMinimumRoiPct}.`);
    facts.push(record.status === 'qualified' ? 'Search criteria are ready.' : 'Buyer criteria are still being refined.');
    return facts.join(' ');
  }

  private friendlyField(field: string): string {
    const labels: Record<string, string> = {
      business_type: 'business activity',
      business_location: 'business location',
      desired_selling_price_aed: 'expected selling price',
      buyer_budget_aed: 'buyer budget',
      buyer_location: 'preferred location',
      client_name: 'contact name',
    };
    return labels[field] || field.replace(/_/g, ' ');
  }

  buildReviewBrief(record: LeadCaptureRecord): string {
    const lines = [
      `Lead score: ${record.leadScore}/100 (${record.leadGrade}, ${record.leadTemperature})`,
      `Playbook: ${record.playbookVersion}`,
      `Next action: ${record.nextBestAction}`,
    ];
    if (record.scoreReasons) lines.push(`Score basis: ${record.scoreReasons}`);
    if (record.riskFlags) lines.push(`Risk flags: ${record.riskFlags}`);
    if (record.objectionsDetected) lines.push(`Objections: ${record.objectionsDetected}`);
    return lines.join('\n');
  }
}
