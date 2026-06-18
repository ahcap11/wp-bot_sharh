import { WhatsAppMessage } from '../types';
import { PersistenceService } from './persistence.service';

const PERSISTENCE_NAMESPACE = 'leadStates';

export type LeadInquiryPurpose = 'buying' | 'selling';
export type LeadEntryType = 'broker_lead' | 'seller_inbound' | 'unknown';
export type LeadCaptureStatus =
  | 'collecting'
  | 'qualified_lead'
  | 'early_escalation';

export interface LeadCaptureRecord {
  timestamp: string;
  chatId: string;
  sourceJid: string;
  isGroup: boolean;
  status: LeadCaptureStatus;
  escalationReason: '' | 'qualified_lead' | 'early_escalation';
  clientName: string;
  clientPhone: string;
  inquiryPurpose: '' | LeadInquiryPurpose;
  annualRevenueAed: string;
  businessType: string;
  desiredSellingPriceAed: string;
  fieldsUpdated: string;
  latestMessage: string;
  notes: string;
}

export interface LeadCaptureUpdate {
  shouldPersist: boolean;
  record?: LeadCaptureRecord | undefined;
}

interface LeadCaptureState {
  entryType?: LeadEntryType | undefined;
  brokerLeadSummary?: string | undefined;
  brokerLeadScore?: string | undefined;
  clientName?: string | undefined;
  clientPhone?: string | undefined;
  inquiryPurpose?: LeadInquiryPurpose | undefined;
  annualRevenueAed?: string | undefined;
  businessType?: string | undefined;
  desiredSellingPriceAed?: string | undefined;
  status: LeadCaptureStatus;
  escalationReason: '' | 'qualified_lead' | 'early_escalation';
  escalationNotes?: string | undefined;
  handoffCompleted: boolean;
  messageCount: number;
  processedMessageIds: Set<string>;
}

// JSON-safe representation of LeadCaptureState (Set -> array).
type SerializedLeadState = Omit<LeadCaptureState, 'processedMessageIds'> & {
  processedMessageIds: string[];
};

/**
 * Extract and track sales lead data from conversation messages.
 */
export class LeadCaptureService {
  private readonly leadStates: Map<string, LeadCaptureState> = new Map();
  private readonly persistence: PersistenceService | null;

  constructor(persistence: PersistenceService | null = null) {
    this.persistence = persistence;
    this.hydrate();
  }

  /**
   * Restore lead states from the persistence store, if configured.
   */
  private hydrate(): void {
    if (!this.persistence) {
      return;
    }

    const stored = this.persistence.getNamespace<SerializedLeadState>(
      PERSISTENCE_NAMESPACE
    );
    for (const [chatId, serialized] of Object.entries(stored)) {
      if (!serialized) {
        continue;
      }
      this.leadStates.set(chatId, {
        ...serialized,
        processedMessageIds: new Set(serialized.processedMessageIds || []),
      });
    }
  }

  private persist(chatId: string): void {
    if (!this.persistence) {
      return;
    }
    const state = this.leadStates.get(chatId);
    if (!state) {
      return;
    }
    const serialized: SerializedLeadState = {
      ...state,
      processedMessageIds: Array.from(state.processedMessageIds),
    };
    this.persistence.setItem(PERSISTENCE_NAMESPACE, chatId, serialized);
  }

  /**
   * Update lead state using a new user message.
   */
  updateFromMessage(
    chatId: string,
    message: WhatsAppMessage
  ): LeadCaptureUpdate {
    const state = this.leadStates.get(chatId) ?? this.createInitialState();

    if (state.processedMessageIds.has(message.id)) {
      return { shouldPersist: false };
    }

    state.processedMessageIds.add(message.id);
    state.messageCount += 1;

    const previousStatus = state.status;
    const fieldsUpdated: string[] = [];
    const normalizedContent = this.normalizeWhitespace(message.content);

    if (state.messageCount === 1) {
      this.applyFirstMessageScenario(state, normalizedContent, fieldsUpdated);
    }

    const channelPhone = this.extractPhoneFromJid(message.from);
    if (!state.clientPhone && channelPhone) {
      state.clientPhone = channelPhone;
      fieldsUpdated.push('client_phone');
    }

    const name = this.extractClientName(normalizedContent);
    if (!state.clientName && name) {
      state.clientName = name;
      fieldsUpdated.push('client_name');
    }

    const textPhone = this.extractPhoneFromText(normalizedContent);
    if (!state.clientPhone && textPhone) {
      state.clientPhone = textPhone;
      fieldsUpdated.push('client_phone');
    }

    const purpose = this.extractInquiryPurpose(normalizedContent);
    if (!state.inquiryPurpose && purpose) {
      state.inquiryPurpose = purpose;
      fieldsUpdated.push('inquiry_purpose');
    }

    const businessType = this.extractBusinessType(normalizedContent);
    if (!state.businessType && businessType) {
      state.businessType = businessType;
      fieldsUpdated.push('business_type');
    }

    const annualRevenue = this.extractAnnualRevenueAed(normalizedContent);
    if (!state.annualRevenueAed && annualRevenue) {
      state.annualRevenueAed = annualRevenue;
      fieldsUpdated.push('annual_revenue_aed');
    }

    const desiredSellingPrice =
      this.extractDesiredSellingPriceAed(normalizedContent);
    if (!state.desiredSellingPriceAed && desiredSellingPrice) {
      state.desiredSellingPriceAed = desiredSellingPrice;
      fieldsUpdated.push('desired_selling_price_aed');
    }

    if (!state.handoffCompleted) {
      const earlyEscalationReason = this.detectEarlyEscalationReason(
        normalizedContent,
        state.inquiryPurpose
      );

      if (earlyEscalationReason) {
        this.earlyEscalation(state, earlyEscalationReason);
      }
    }

    if (!state.handoffCompleted && this.hasRequiredLeadFields(state)) {
      this.qualifiedLeadHandoff(state);
    }

    this.leadStates.set(chatId, state);
    // Persist on every accepted (non-duplicate) message so processed ids and
    // partial progress survive restarts.
    this.persist(chatId);

    const statusChanged = previousStatus !== state.status;
    const shouldPersist =
      fieldsUpdated.length > 0 || statusChanged || state.messageCount === 1;

    if (!shouldPersist) {
      return { shouldPersist: false };
    }

    const record: LeadCaptureRecord = {
      timestamp: new Date(message.timestamp).toISOString(),
      chatId,
      sourceJid: message.from,
      isGroup: message.isGroup,
      status: state.status,
      escalationReason: state.escalationReason,
      clientName: state.clientName || '',
      clientPhone: state.clientPhone || '',
      inquiryPurpose: state.inquiryPurpose || '',
      annualRevenueAed: state.annualRevenueAed || '',
      businessType: state.businessType || '',
      desiredSellingPriceAed: state.desiredSellingPriceAed || '',
      fieldsUpdated: fieldsUpdated.join(', '),
      latestMessage: normalizedContent,
      notes: state.escalationNotes || '',
    };

    return {
      shouldPersist: true,
      record,
    };
  }

  /**
   * Scenario hints for the AI based on how the conversation started.
   */
  getConversationContext(chatId: string): string | null {
    const state = this.leadStates.get(chatId);
    if (!state?.entryType || state.entryType === 'unknown') {
      return null;
    }

    if (state.entryType === 'seller_inbound') {
      return [
        'FIRST MESSAGE SCENARIO: Seller inbound.',
        'The client already stated they want to sell their business.',
        'Do NOT ask whether they want to buy or sell.',
        'After greeting and name, proceed directly to seller terms and qualification blocks.',
      ].join(' ');
    }

    const summary = state.brokerLeadSummary || 'see first message';
    const scorePart = state.brokerLeadScore
      ? ` Score: ${state.brokerLeadScore}.`
      : '';

    return [
      'FIRST MESSAGE SCENARIO: SHARH broker lead discussion.',
      `Lead: ${summary}.${scorePart}`,
      'This is a broker outreach about an existing lead.',
      'Do NOT run consumer buy/sell qualification.',
      'Acknowledge professionally in English and transfer to a manager immediately.',
    ].join(' ');
  }

  /**
   * Clear lead state for a specific chat.
   */
  clearLeadState(chatId: string): void {
    this.leadStates.delete(chatId);
    this.persistence?.removeItem(PERSISTENCE_NAMESPACE, chatId);
  }

  private createInitialState(): LeadCaptureState {
    return {
      status: 'collecting',
      escalationReason: '',
      handoffCompleted: false,
      messageCount: 0,
      processedMessageIds: new Set<string>(),
    };
  }

  private hasRequiredLeadFields(state: LeadCaptureState): boolean {
    if (!state.clientName || !state.clientPhone || !state.inquiryPurpose) {
      return false;
    }

    if (state.inquiryPurpose === 'selling') {
      return Boolean(
        state.businessType &&
          state.annualRevenueAed &&
          state.desiredSellingPriceAed
      );
    }

    return true;
  }

  private normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private applyFirstMessageScenario(
    state: LeadCaptureState,
    content: string,
    fieldsUpdated: string[]
  ): void {
    const entryType = this.detectEntryType(content);
    state.entryType = entryType;

    if (entryType === 'unknown') {
      return;
    }

    fieldsUpdated.push('entry_type');

    if (entryType === 'seller_inbound' && !state.inquiryPurpose) {
      state.inquiryPurpose = 'selling';
      fieldsUpdated.push('inquiry_purpose');
      return;
    }

    if (entryType === 'broker_lead') {
      const details = this.parseBrokerLeadDetails(content);
      state.brokerLeadSummary = details.summary;
      if (details.score) {
        state.brokerLeadScore = details.score;
      }

      if (!state.handoffCompleted) {
        const reason = `SHARH broker lead discussion: ${details.summary}${
          details.score ? ` (Score ${details.score})` : ''
        }`;
        this.earlyEscalation(state, reason);
      }
    }
  }

  private detectEntryType(value: string): LeadEntryType {
    const normalized = value.toLowerCase();

    if (
      /\bsharh\s+broker\b/.test(normalized) &&
      /\bdiscussing\s+a\s+lead\b/.test(normalized)
    ) {
      return 'broker_lead';
    }

    if (
      /\b(want|wants)\s+to\s+sell\s+(my\s+)?business\b/.test(normalized) ||
      /\bselling\s+my\s+business\b/.test(normalized) ||
      /\bi\s+want\s+to\s+sell\b/.test(normalized)
    ) {
      return 'seller_inbound';
    }

    return 'unknown';
  }

  private parseBrokerLeadDetails(value: string): {
    summary: string;
    score: string;
  } {
    const scoreMatch = value.match(/score\s*(\d+)\s*\/\s*100/i);
    const leadMatch = value.match(
      /discussing\s+a\s+lead:\s*(.+?)(?:\s*\(score|\s*$)/i
    );

    return {
      summary: leadMatch?.[1]?.trim() || value.trim(),
      score: scoreMatch?.[1] ? `${scoreMatch[1]}/100` : '',
    };
  }

  private extractInquiryPurpose(value: string): LeadInquiryPurpose | null {
    const normalized = value.toLowerCase();
    const sellingMatch =
      /\b(sell|selling|seller|sale|list my business|selling a business)\b/.test(
        normalized
      );
    const buyingMatch =
      /\b(buy|buying|buyer|purchase|acquire|acquisition|invest)\b/.test(
        normalized
      );

    if (sellingMatch && !buyingMatch) {
      return 'selling';
    }

    if (buyingMatch && !sellingMatch) {
      return 'buying';
    }

    if (sellingMatch && buyingMatch) {
      if (/\bsell my business\b|\bselling my business\b/.test(normalized)) {
        return 'selling';
      }
      return 'buying';
    }

    return null;
  }

  private extractClientName(value: string): string | null {
    const patterns: RegExp[] = [
      /\bmy name is\s+([a-z][a-z\s'-]{1,60})$/i,
      /\bi am\s+([a-z][a-z\s'-]{1,60})$/i,
      /\bthis is\s+([a-z][a-z\s'-]{1,60})$/i,
      /\bname\s*[:=-]\s*([a-z][a-z\s'-]{1,60})$/i,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (!match || !match[1]) {
        continue;
      }

      const normalizedName = this.normalizeName(match[1]);
      if (normalizedName) {
        return normalizedName;
      }
    }

    // Fallback for short standalone name responses such as "John".
    if (this.looksLikeStandaloneName(value)) {
      return this.normalizeName(value);
    }

    return null;
  }

  private looksLikeStandaloneName(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 40) {
      return false;
    }

    if (/\d/.test(trimmed) || /[?!.]/.test(trimmed)) {
      return false;
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 3) {
      return false;
    }

    return words.every(word => /^[a-z][a-z'-]*$/i.test(word));
  }

  private normalizeName(value: string): string | null {
    const trimmed = value.trim().replace(/^['\-\s]+|['\-\s]+$/g, '');
    if (!trimmed) {
      return null;
    }

    return trimmed
      .split(/\s+/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }

  private extractBusinessType(value: string): string | null {
    const patterns: RegExp[] = [
      /\b(?:business\s*(?:type|is|does|category)?|we (?:are|run)|i (?:run|own))\s*[:=-]?\s*([a-z][a-z0-9&,\-/'\s]{2,80})$/i,
      /\b(?:it is|it's)\s+(?:a|an)\s+([a-z][a-z0-9&,\-/'\s]{2,80})$/i,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (!match || !match[1]) {
        continue;
      }

      const normalized = this.normalizeBusinessText(match[1]);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private extractAnnualRevenueAed(value: string): string | null {
    const hasRevenueHint =
      /\b(revenue|turnover|annual sales|yearly sales|sales per year)\b/i.test(
        value
      );
    if (!hasRevenueHint) {
      return null;
    }

    const amount = this.extractMoneyAmount(value);
    return amount ? this.formatAedAmount(amount) : null;
  }

  private extractDesiredSellingPriceAed(value: string): string | null {
    const hasPriceHint =
      /\b(asking price|sell(?:ing)? price|desired price|price range|expected price|selling for)\b/i.test(
        value
      );
    if (!hasPriceHint) {
      return null;
    }

    const amount = this.extractMoneyAmount(value);
    return amount ? this.formatAedAmount(amount) : null;
  }

  private extractMoneyAmount(value: string): number | null {
    const millionMatch = value.match(/(\d+(?:\.\d+)?)\s*(m|mn|million)\b/i);
    if (millionMatch?.[1]) {
      const base = parseFloat(millionMatch[1]);
      if (!Number.isNaN(base)) {
        return Math.round(base * 1_000_000);
      }
    }

    const thousandMatch = value.match(/(\d+(?:\.\d+)?)\s*(k|thousand)\b/i);
    if (thousandMatch?.[1]) {
      const base = parseFloat(thousandMatch[1]);
      if (!Number.isNaN(base)) {
        return Math.round(base * 1_000);
      }
    }

    const compact = value.match(
      /(?:aed|dhs?|dirhams?)?\s*(\d{1,3}(?:,\d{3})+|\d{5,10})(?:\s*(?:aed|dhs?|dirhams?))?/i
    );
    if (compact?.[1]) {
      const digits = compact[1].replace(/,/g, '');
      const parsed = parseInt(digits, 10);
      if (!Number.isNaN(parsed) && parsed >= 1000) {
        return parsed;
      }
    }

    return null;
  }

  private formatAedAmount(amount: number): string {
    return `AED ${amount.toLocaleString('en-US')}`;
  }

  private normalizeBusinessText(value: string): string | null {
    const cleaned = value
      .replace(/\b(?:in dubai|in abu dhabi|uae)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[-,.:;\s]+|[-,.:;\s]+$/g, '');

    if (!cleaned) {
      return null;
    }

    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  private extractPhoneFromText(value: string): string | null {
    const match = value.match(/(?:\+?\d[\d\s()-]{6,}\d)/);
    if (!match || !match[0]) {
      return null;
    }

    return this.normalizePhoneNumber(match[0]);
  }

  private extractPhoneFromJid(jid: string): string | null {
    const numberPart = jid.split('@')[0] || '';
    return this.normalizePhoneNumber(numberPart);
  }

  private normalizePhoneNumber(value: string): string | null {
    const trimmed = value.trim();
    const hasPlusPrefix = trimmed.startsWith('+');
    const digitsOnly = trimmed.replace(/\D/g, '');

    if (digitsOnly.length < 8) {
      return null;
    }

    return hasPlusPrefix ? `+${digitsOnly}` : digitsOnly;
  }

  private detectEarlyEscalationReason(
    value: string,
    purpose?: LeadInquiryPurpose
  ): string | null {
    const normalized = value.toLowerCase();

    const managerRequest =
      /\b(connect|transfer|speak|talk)\b.{0,25}\b(manager|human|agent|representative|consultant)\b|\blive manager\b|\bhuman agent\b/.test(
        normalized
      );
    if (managerRequest) {
      return 'Explicit client request for a live manager';
    }

    const aggression =
      /\b(stupid|idiot|useless|terrible|worst|damn|shit|fuck)\b/.test(
        normalized
      );
    if (aggression) {
      return 'Aggressive language detected';
    }

    const urgency =
      /\b(urgent|asap|immediately|right now|today only|need now)\b/.test(
        normalized
      );
    if (urgency) {
      return 'Significant urgency detected';
    }

    const complexQuestion =
      /\b(legal|tax|compliance|valuation method|due diligence|contract clause|liability structure|corporate structure)\b/.test(
        normalized
      );
    if (complexQuestion) {
      return 'Complex question requiring manager review';
    }

    const asksSpecificListing =
      /\blisting\b/.test(normalized) &&
      /\b(id|code|number|specific|#)\b/.test(normalized);
    if (asksSpecificListing && purpose === 'buying') {
      return 'Buyer requested details for a specific listing';
    }

    if (asksSpecificListing && !purpose) {
      return 'Requested details for a specific listing';
    }

    return null;
  }

  /**
   * Mark a lead as qualified and ready for manager handoff.
   */
  private qualifiedLeadHandoff(state: LeadCaptureState): void {
    state.status = 'qualified_lead';
    state.escalationReason = 'qualified_lead';
    state.handoffCompleted = true;
  }

  /**
   * Trigger an early escalation and stop further qualification.
   */
  private earlyEscalation(state: LeadCaptureState, reason: string): void {
    state.status = 'early_escalation';
    state.escalationReason = 'early_escalation';
    state.escalationNotes = reason;
    state.handoffCompleted = true;
  }
}
