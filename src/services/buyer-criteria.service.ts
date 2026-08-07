import type {
  ConversationLanguage,
  LeadCaptureRecord,
} from './lead-capture.service';

export type PassivePreference = 'any' | 'preferred' | 'required';

export interface BuyerSearchCriteria {
  sector: string;
  emirate: string;
  maxBudgetAed: number | null;
  budgetFlexible: boolean;
  minAnnualProfitAed: number | null;
  minRoiPct: number | null;
  profitableOnly: boolean;
  passivePreference: PassivePreference;
  excludedSectors: string[];
  returnPeriodAmbiguous: boolean;
  ambiguousReturnAmountAed: number | null;
}

const GENERIC_SECTOR = /^(?:any(?: profitable)? business|business|company|cash[- ]?generating business|profitable business|investment|investment opportunity|any sector)$/i;
const UNKNOWN_VALUE = /^(?:unknown|not sure|to confirm|anywhere|any location|all emirates|no preference)$/i;

export class BuyerCriteriaService {
  fromRecord(record: LeadCaptureRecord): BuyerSearchCriteria {
    const sectorRaw = record.businessType.trim();
    const sector = GENERIC_SECTOR.test(sectorRaw) ? '' : sectorRaw;
    const maxBudgetAed = this.parseAedUpperBound(record.buyerBudgetAed);
    const budgetFlexible = /flexible|no fixed|open budget/i.test(
      record.buyerBudgetAed
    );
    const minAnnualProfitAed = this.parseAedLowerBound(
      record.buyerMinimumAnnualProfitAed
    );
    const minRoiPct = this.parsePercent(record.buyerMinimumRoiPct);
    const passivePreference = this.resolvePassivePreference(record);

    return {
      sector,
      emirate: UNKNOWN_VALUE.test(record.buyerLocation.trim())
        ? ''
        : record.buyerLocation.trim(),
      maxBudgetAed,
      budgetFlexible,
      minAnnualProfitAed,
      minRoiPct,
      profitableOnly: Boolean(record.buyerProfitableOnly || minAnnualProfitAed),
      passivePreference,
      excludedSectors: record.buyerExcludedSectors
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .slice(0, 10),
      returnPeriodAmbiguous:
        record.buyerReturnPeriod === 'ambiguous' &&
        !record.buyerMinimumAnnualProfitAed,
      ambiguousReturnAmountAed:
        record.buyerReturnPeriod === 'ambiguous'
          ? this.extractReturnAmount(record.buyerAdditionalComments)
          : null,
    };
  }

  clarificationMessage(
    criteria: BuyerSearchCriteria,
    language: ConversationLanguage
  ): string | null {
    if (criteria.returnPeriodAmbiguous) {
      const amount = criteria.ambiguousReturnAmountAed;
      const formatted = amount
        ? `AED ${amount.toLocaleString('en-US')}`
        : language === 'ru'
          ? 'указанная сумма'
          : language === 'ar'
            ? 'المبلغ المذكور'
            : 'the amount you mentioned';
      if (language === 'ru') {
        return `Перед подбором уточню один момент: ${formatted} — это минимальная чистая прибыль за год или за месяц?`;
      }
      if (language === 'ar') {
        return `قبل البحث، أحتاج إلى توضيح واحد: هل ${formatted} هو الحد الأدنى لصافي الربح سنوياً أم شهرياً؟`;
      }
      return `Before I match listings, one clarification: is ${formatted} your minimum annual net profit or monthly net profit?`;
    }
    if (criteria.maxBudgetAed === null && !criteria.budgetFlexible) {
      if (language === 'ru') {
        return 'Какой максимальный бюджет вы готовы выделить? Можно указать приблизительный диапазон.';
      }
      if (language === 'ar') {
        return 'ما الحد الأقصى للميزانية التي يمكنك تخصيصها؟ يكفي نطاق تقريبي.';
      }
      return 'What is the maximum budget you can allocate? An approximate range is enough.';
    }
    return null;
  }

  compactSummary(
    criteria: BuyerSearchCriteria,
    language: ConversationLanguage
  ): string[] {
    const values: string[] = [];
    if (criteria.maxBudgetAed !== null) {
      values.push(
        language === 'ru'
          ? `цена до AED ${criteria.maxBudgetAed.toLocaleString('en-US')}`
          : language === 'ar'
            ? `السعر حتى ${criteria.maxBudgetAed.toLocaleString('en-US')} درهم`
            : `price up to AED ${criteria.maxBudgetAed.toLocaleString('en-US')}`
      );
    } else if (criteria.budgetFlexible) {
      values.push(
        language === 'ru'
          ? 'бюджет гибкий'
          : language === 'ar'
            ? 'الميزانية مرنة'
            : 'flexible budget'
      );
    }
    if (criteria.minAnnualProfitAed !== null) {
      values.push(
        language === 'ru'
          ? `годовая прибыль от AED ${criteria.minAnnualProfitAed.toLocaleString('en-US')}`
          : language === 'ar'
            ? `ربح سنوي لا يقل عن ${criteria.minAnnualProfitAed.toLocaleString('en-US')} درهم`
            : `annual profit of at least AED ${criteria.minAnnualProfitAed.toLocaleString('en-US')}`
      );
    }
    if (criteria.minRoiPct !== null) {
      values.push(
        language === 'ru'
          ? `ROI от ${criteria.minRoiPct}%`
          : language === 'ar'
            ? `عائد استثمار لا يقل عن ${criteria.minRoiPct}%`
            : `ROI of at least ${criteria.minRoiPct}%`
      );
    }
    if (criteria.profitableOnly && criteria.minAnnualProfitAed === null) {
      values.push(
        language === 'ru'
          ? 'положительная прибыль раскрыта'
          : language === 'ar'
            ? 'وجود ربح إيجابي معلن'
            : 'positive disclosed profit'
      );
    }
    if (criteria.passivePreference === 'required') {
      values.push(
        language === 'ru'
          ? 'пассивное/управляемое без владельца ведение подтверждено описанием'
          : language === 'ar'
            ? 'وجود إدارة تشغيلية تسمح بدور سلبي للمشتري'
            : 'passive/manager-run operation evidenced in the listing'
      );
    } else if (criteria.passivePreference === 'preferred') {
      values.push(
        language === 'ru'
          ? 'пассивное управление предпочтительно'
          : language === 'ar'
            ? 'الإدارة السلبية مفضلة'
            : 'passive operation preferred'
      );
    }
    if (criteria.sector) values.push(criteria.sector);
    if (criteria.emirate) values.push(criteria.emirate);
    if (criteria.excludedSectors.length > 0) {
      values.push(
        language === 'ru'
          ? `исключить: ${criteria.excludedSectors.join(', ')}`
          : language === 'ar'
            ? `استبعاد: ${criteria.excludedSectors.join(', ')}`
            : `exclude: ${criteria.excludedSectors.join(', ')}`
      );
    }
    return values;
  }

  private resolvePassivePreference(record: LeadCaptureRecord): PassivePreference {
    const explicit = record.buyerInvolvement.trim().toLowerCase();
    if (
      /\b(?:open to either|either|active acceptable|active management is acceptable|passive not required|no passive requirement)\b/i.test(
        explicit
      ) ||
      /\b(?:operate|manage|run).*(?:personally|myself)\b/i.test(explicit)
    ) {
      return 'any';
    }
    if (/\b(?:prefer(?:red)? passive|passive preferred|ideally passive)\b/i.test(explicit)) {
      return 'preferred';
    }
    if (/\b(?:passive required|passive investment|passively|hands[- ]?off|absentee|manager[- ]?run)\b/i.test(explicit)) {
      return 'required';
    }

    // Older stored records may only contain the original free-text request.
    const comments = record.buyerAdditionalComments.toLowerCase();
    if (/\b(?:passive not required|active management is acceptable|open to either)\b/i.test(comments)) {
      return 'any';
    }
    if (/\b(?:prefer passive|ideally passive|passive preferred)\b/i.test(comments)) {
      return 'preferred';
    }
    if (/\b(?:passive|passively|hands[- ]?off|absentee|without managing|manager[- ]?run)\b/i.test(comments)) {
      return 'required';
    }
    return 'any';
  }

  private parseAedUpperBound(value: string): number | null {
    const amounts = this.parseMoneyValues(value);
    return amounts.length > 0 ? Math.max(...amounts) : null;
  }

  private parseAedLowerBound(value: string): number | null {
    const amounts = this.parseMoneyValues(value);
    return amounts.length > 0 ? Math.min(...amounts) : null;
  }

  private parseMoneyValues(value: string): number[] {
    if (!value || /unknown|to confirm/i.test(value)) return [];
    const matches = value.matchAll(
      /(?<!\d)(\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(?:\s*)(bn|billion|b|mn|mln|million|m|thousand|k)?/gi
    );
    const values: number[] = [];
    for (const match of matches) {
      const raw = match[1];
      if (!raw) continue;
      const suffix = (match[2] || '').toLowerCase();
      const normalized = suffix && /^\d+,\d{1,2}$/.test(raw)
        ? raw.replace(',', '.')
        : raw.replace(/[\s,]/g, '');
      let parsed = Number.parseFloat(normalized);
      if (!Number.isFinite(parsed)) continue;
      if (/^(?:b|bn|billion)$/.test(suffix)) parsed *= 1_000_000_000;
      if (/^(?:m|mn|mln|million)$/.test(suffix)) parsed *= 1_000_000;
      if (/^(?:k|thousand)$/.test(suffix)) parsed *= 1_000;
      const rounded = Math.round(parsed);
      if (Number.isSafeInteger(rounded) && rounded > 0) values.push(rounded);
    }
    return values;
  }

  private parsePercent(value: string): number | null {
    const match = value.match(/(\d+(?:\.\d+)?)\s*%?/);
    if (!match?.[1]) return null;
    const parsed = Number.parseFloat(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private extractReturnAmount(value: string): number | null {
    const match = value.match(
      /(?:profit|income|cash ?flow|earnings?|earns?|makes?|brings?|return)\D{0,35}?(?:aed|dhs?)?\s*(\d{1,3}(?:[,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(m|mn|mln|million|k|thousand)?/i
    );
    if (!match?.[1]) return null;
    return this.parseMoneyValues(`${match[1]}${match[2] || ''}`)[0] || null;
  }
}
