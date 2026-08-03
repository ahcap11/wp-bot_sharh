import type { LeadCaptureRecord } from './lead-capture.service';

export class ConversationSummaryService {
  build(record: LeadCaptureRecord): string {
    const identity = record.clientName || record.clientPhone || 'Unidentified contact';
    const intent = record.inquiryPurpose || 'unconfirmed intent';
    const subject = record.businessType || record.specificListingCode || 'business opportunity';
    const location = record.businessLocation || record.buyerLocation;
    const money =
      record.inquiryPurpose === 'selling'
        ? record.desiredSellingPriceAed || record.annualRevenueAed
        : record.buyerBudgetAed;
    return [
      `${identity} is a ${intent} lead concerning ${subject}.`,
      location ? `Location preference/context: ${location}.` : '',
      money ? `Commercial reference: ${money}.` : '',
      `Qualification is ${record.completionPercent}% complete.`,
      record.objectionsDetected
        ? `Objections/concerns raised: ${record.objectionsDetected}.`
        : '',
      record.riskFlags ? `Risks to verify: ${record.riskFlags}.` : '',
      `Recommended action: ${record.nextBestAction.replace(/[.]+$/, '')}.`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  buildManagerBrief(record: LeadCaptureRecord): string {
    const lines = [
      `Lead score: ${record.leadScore}/100 (${record.leadGrade}, ${record.leadTemperature})`,
      `Playbook: ${record.playbookVersion}`,
      `Completion: ${record.completionPercent}%`,
      `Next action: ${record.nextBestAction}`,
    ];
    if (record.scoreReasons) lines.push(`Score basis: ${record.scoreReasons}`);
    if (record.riskFlags) lines.push(`Risk flags: ${record.riskFlags}`);
    if (record.objectionsDetected) lines.push(`Objections: ${record.objectionsDetected}`);
    return lines.join('\n');
  }
}
