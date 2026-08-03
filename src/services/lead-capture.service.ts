import { WhatsAppMessage } from '../types';
import { PersistenceService } from './persistence.service';
import { SalesPlaybookService, ObjectionTopic } from './sales-playbook.service';
import { LeadScoringService } from './lead-scoring.service';
import { ConversationSummaryService } from './conversation-summary.service';

const PERSISTENCE_NAMESPACE = 'leadStates';
const STATE_VERSION = 6;
const MAX_PROCESSED_MESSAGE_IDS = 500;

export type LeadInquiryPurpose = 'buying' | 'selling';
export type LeadEntryType = 'broker_lead' | 'seller_inbound' | 'buyer_inbound' | 'unknown';
export type LeadCaptureStatus = 'new' | 'contacted' | 'qualified';
export type FunnelStage =
  | 'new'
  | 'intent_identified'
  | 'identity_collected'
  | 'terms_presented'
  | 'terms_accepted'
  | 'qualifying';
export type ConversationLanguage = 'en' | 'ru' | 'ar';
export type ConversationOwner = 'bot';
export type ReviewReason = '' | 'internal_review';
export type { ObjectionTopic } from './sales-playbook.service';

export type LeadField =
  | 'inquiry_purpose'
  | 'client_name'
  | 'seller_terms'
  | 'business_type'
  | 'business_location'
  | 'annual_revenue_aed'
  | 'lease_details'
  | 'desired_selling_price_aed'
  | 'year_established'
  | 'employee_count'
  | 'monthly_operating_expenses_aed'
  | 'monthly_net_profit_aed'
  | 'liabilities'
  | 'contracts_licenses'
  | 'sale_reason_urgency'
  | 'included_assets'
  | 'buyer_budget_aed'
  | 'buyer_location'
  | 'buyer_timeline'
  | 'buyer_involvement'
  | 'buyer_funding_status'
  | 'buyer_additional_comments';

export interface LeadCaptureRecord {
  timestamp: string;
  chatId: string;
  sourceJid: string;
  isGroup: boolean;
  status: LeadCaptureStatus;
  funnelStage: FunnelStage;
  owner: ConversationOwner;
  escalationReason: ReviewReason;
  clientName: string;
  clientPhone: string;
  language: ConversationLanguage;
  inquiryPurpose: '' | LeadInquiryPurpose;
  specificListingCode: string;
  termsAccepted: string;
  annualRevenueAed: string;
  businessType: string;
  businessLocation: string;
  leaseDetails: string;
  desiredSellingPriceAed: string;
  yearEstablished: string;
  employeeCount: string;
  monthlyOperatingExpensesAed: string;
  monthlyNetProfitAed: string;
  liabilities: string;
  contractsLicenses: string;
  saleReasonUrgency: string;
  includedAssets: string;
  buyerBudgetAed: string;
  buyerLocation: string;
  buyerTimeline: string;
  buyerInvolvement: string;
  buyerFundingStatus: string;
  buyerAdditionalComments: string;
  completionPercent: number;
  nextField: string;
  fieldsUpdated: string;
  latestMessage: string;
  notes: string;
  playbookVersion: string;
  leadScore: number;
  leadGrade: 'A' | 'B' | 'C' | 'D';
  leadTemperature: 'hot' | 'warm' | 'nurture' | 'incomplete';
  scoreReasons: string;
  riskFlags: string;
  nextBestAction: string;
  nextBestActionCode: string;
  objectionsDetected: string;
  conversationSummary: string;
  reviewBrief: string;
}

export interface LeadCaptureUpdate {
  shouldPersist: boolean;
  record?: LeadCaptureRecord | undefined;
}

export interface FunnelDirective {
  stage: FunnelStage;
  owner: ConversationOwner;
  shouldRespond: boolean;
  directResponse?: string | undefined;
  expectedField?: LeadField | undefined;
  markOnSend?: 'question_sent' | 'terms_presented' | undefined;
  markReviewNoticeOnSend?: boolean | undefined;
  markQualificationNoticeOnSend?: boolean | undefined;
}

interface LeadCaptureState {
  version: number;
  entryType: LeadEntryType;
  brokerLeadSummary?: string | undefined;
  brokerLeadScore?: string | undefined;
  clientName?: string | undefined;
  clientPhone?: string | undefined;
  language: ConversationLanguage;
  inquiryPurpose?: LeadInquiryPurpose | undefined;
  specificListingCode?: string | undefined;
  termsPresented: boolean;
  termsAccepted?: boolean | undefined;
  businessType?: string | undefined;
  businessLocation?: string | undefined;
  annualRevenueAed?: string | undefined;
  leaseDetails?: string | undefined;
  desiredSellingPriceAed?: string | undefined;
  yearEstablished?: string | undefined;
  employeeCount?: string | undefined;
  monthlyOperatingExpensesAed?: string | undefined;
  monthlyNetProfitAed?: string | undefined;
  liabilities?: string | undefined;
  contractsLicenses?: string | undefined;
  saleReasonUrgency?: string | undefined;
  includedAssets?: string | undefined;
  buyerBudgetAed?: string | undefined;
  buyerLocation?: string | undefined;
  buyerTimeline?: string | undefined;
  buyerInvolvement?: string | undefined;
  buyerFundingStatus?: string | undefined;
  buyerAdditionalComments?: string | undefined;
  status: LeadCaptureStatus;
  stage: FunnelStage;
  owner: ConversationOwner;
  escalationReason: ReviewReason;
  escalationNotes?: string | undefined;
  reviewNoticeSent: boolean;
  qualificationNoticeSent: boolean;
  expectedField?: LeadField | undefined;
  pendingObjection?: ObjectionTopic | undefined;
  objectionsDetected: ObjectionTopic[];
  messageCount: number;
  processedMessageIds: Set<string>;
}

type SerializedLeadState = Partial<
  Omit<
    LeadCaptureState,
    | 'processedMessageIds'
    | 'status'
    | 'stage'
    | 'owner'
    | 'reviewNoticeSent'
    | 'qualificationNoticeSent'
  >
> & {
  processedMessageIds?: string[];
  reviewNoticeSent?: boolean;
  qualificationNoticeSent?: boolean;
  status?:
    | LeadCaptureStatus
    | 'collecting'
    | 'qualified_lead'
    | 'early_escalation'
    | 'handoff_pending'
    | 'human_owned';
  stage?: FunnelStage | 'handoff_pending' | 'human_owned';
  owner?: ConversationOwner | 'human';
  handoffCompleted?: boolean;
  closingMessageSent?: boolean;
  pendingNoticeSent?: boolean;
};

const SELLER_REQUIRED_FIELDS: Array<keyof LeadCaptureState> = [
  'businessType',
  'businessLocation',
  'annualRevenueAed',
  'leaseDetails',
  'desiredSellingPriceAed',
  'yearEstablished',
  'employeeCount',
  'monthlyOperatingExpensesAed',
  'monthlyNetProfitAed',
  'liabilities',
  'contractsLicenses',
  'saleReasonUrgency',
  'includedAssets',
];

const BUYER_REQUIRED_FIELDS: Array<keyof LeadCaptureState> = [
  'businessType',
  'buyerBudgetAed',
  'buyerLocation',
  'buyerTimeline',
  'buyerInvolvement',
  'buyerFundingStatus',
  'buyerAdditionalComments',
];

const FIELD_TO_STATE_KEY: Record<LeadField, keyof LeadCaptureState> = {
  inquiry_purpose: 'inquiryPurpose',
  client_name: 'clientName',
  seller_terms: 'termsAccepted',
  business_type: 'businessType',
  business_location: 'businessLocation',
  annual_revenue_aed: 'annualRevenueAed',
  lease_details: 'leaseDetails',
  desired_selling_price_aed: 'desiredSellingPriceAed',
  year_established: 'yearEstablished',
  employee_count: 'employeeCount',
  monthly_operating_expenses_aed: 'monthlyOperatingExpensesAed',
  monthly_net_profit_aed: 'monthlyNetProfitAed',
  liabilities: 'liabilities',
  contracts_licenses: 'contractsLicenses',
  sale_reason_urgency: 'saleReasonUrgency',
  included_assets: 'includedAssets',
  buyer_budget_aed: 'buyerBudgetAed',
  buyer_location: 'buyerLocation',
  buyer_timeline: 'buyerTimeline',
  buyer_involvement: 'buyerInvolvement',
  buyer_funding_status: 'buyerFundingStatus',
  buyer_additional_comments: 'buyerAdditionalComments',
};

/**
 * Deterministic SHARH sales-funnel engine.
 *
 * The model may phrase non-standard answers, but this service owns stage,
 * required fields, qualification, and the information written to SHARH.
 */
export class LeadCaptureService {
  private readonly leadStates: Map<string, LeadCaptureState> = new Map();
  private readonly persistence: PersistenceService | null;
  private readonly playbook: SalesPlaybookService;
  private readonly scoring: LeadScoringService;
  private readonly summaries: ConversationSummaryService;

  constructor(
    persistence: PersistenceService | null = null,
    playbook: SalesPlaybookService = new SalesPlaybookService()
  ) {
    this.persistence = persistence;
    this.playbook = playbook;
    this.scoring = new LeadScoringService(playbook);
    this.summaries = new ConversationSummaryService();
    this.hydrate();
  }

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

      const initial = this.createInitialState();
      const restoredStatus = this.normalizeLegacyStatus(serialized);
      const restored: LeadCaptureState = {
        ...initial,
        ...serialized,
        version: STATE_VERSION,
        entryType: serialized.entryType || 'unknown',
        language: serialized.language || 'en',
        status: restoredStatus,
        stage: this.normalizeLegacyStage(serialized, restoredStatus),
        owner: 'bot',
        escalationReason:
          serialized.escalationReason === 'internal_review' ||
          serialized.status === 'early_escalation' ||
          serialized.status === 'handoff_pending'
            ? 'internal_review'
            : '',
        reviewNoticeSent:
          Boolean(serialized.reviewNoticeSent && restoredStatus !== 'qualified') ||
          serialized.pendingNoticeSent ||
          false,
        qualificationNoticeSent:
          serialized.qualificationNoticeSent ||
          serialized.closingMessageSent ||
          Boolean(serialized.reviewNoticeSent && restoredStatus === 'qualified') ||
          false,
        objectionsDetected: serialized.objectionsDetected || [],
        processedMessageIds: new Set(serialized.processedMessageIds || []),
      };
      this.leadStates.set(chatId, restored);
    }
  }

  private normalizeLegacyStatus(serialized: SerializedLeadState): LeadCaptureStatus {
    if (
      serialized.status === 'qualified' ||
      serialized.status === 'qualified_lead' ||
      serialized.status === 'human_owned' ||
      serialized.handoffCompleted
    ) {
      return 'qualified';
    }
    if (serialized.status === 'new' && !serialized.messageCount) {
      return 'new';
    }
    return 'contacted';
  }

  private normalizeLegacyStage(
    serialized: SerializedLeadState,
    status: LeadCaptureStatus
  ): FunnelStage {
    if (status === 'qualified') return 'qualifying';
    if (serialized.termsAccepted) return 'terms_accepted';
    if (serialized.termsPresented) return 'terms_presented';
    if (serialized.clientName) return 'identity_collected';
    if (serialized.inquiryPurpose) return 'intent_identified';
    return 'new';
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

  updateFromMessage(
    chatId: string,
    message: WhatsAppMessage
  ): LeadCaptureUpdate {
    const state = this.leadStates.get(chatId) ?? this.createInitialState();

    if (state.processedMessageIds.has(message.id)) {
      return { shouldPersist: false };
    }

    const previousStatus = state.status;
    const previousStage = state.stage;

    state.processedMessageIds.add(message.id);
    this.trimProcessedMessageIds(state);
    state.messageCount += 1;
    if (state.status === 'new') {
      state.status = 'contacted';
    }
    const fieldsUpdated: string[] = [];
    const normalizedContent = this.normalizeWhitespace(message.content);

    const detectedLanguage = this.detectLanguage(
      normalizedContent,
      state.language,
      state.messageCount === 1
    );
    if (detectedLanguage !== state.language) {
      state.language = detectedLanguage;
      fieldsUpdated.push('language');
    }

    if (state.messageCount === 1) {
      this.applyFirstMessageScenario(state, normalizedContent, fieldsUpdated);
    }

    const channelPhone = this.extractPhoneFromJid(message.from);
    if (!state.clientPhone && channelPhone) {
      state.clientPhone = channelPhone;
      fieldsUpdated.push('client_phone');
    }

    // Objections are handled as objections, not accidentally stored as the
    // answer to the current qualification question. Explicit structured values
    // can still be extracted from a mixed answer below.
    const objection = this.playbook.detectObjection(normalizedContent);
    if (objection) {
      state.pendingObjection = objection;
      if (!state.objectionsDetected.includes(objection)) {
        state.objectionsDetected.push(objection);
        fieldsUpdated.push('objection_detected');
      }
    } else {
      // The answer to the application-owned current question has priority over
      // broad pattern matching, which preserves details such as district names.
      this.applyExpectedField(state, normalizedContent, fieldsUpdated);
    }
    this.applyExplicitExtractions(state, normalizedContent, fieldsUpdated);

    const reviewReason = this.detectEarlyEscalationReason(
      normalizedContent,
      state.inquiryPurpose
    );
    if (reviewReason) {
      this.markForReview(state, reviewReason);
    }

    if (state.status !== 'qualified' && this.hasRequiredLeadFields(state)) {
      this.markQualified(state);
    }

    this.recalculateStage(state);
    this.leadStates.set(chatId, state);
    this.persist(chatId);

    const statusChanged = previousStatus !== state.status;
    const stageChanged = previousStage !== state.stage;
    const shouldPersist =
      fieldsUpdated.length > 0 ||
      statusChanged ||
      stageChanged ||
      state.messageCount === 1;

    if (!shouldPersist) {
      return { shouldPersist: false };
    }

    return {
      shouldPersist: true,
      record: this.buildRecord(chatId, message, state, fieldsUpdated),
    };
  }

  /** Return the next application-owned action for the conversation. */
  getDirective(chatId: string): FunnelDirective {
    const state = this.leadStates.get(chatId) ?? this.createInitialState();

    if (state.status === 'qualified') {
      if (!state.qualificationNoticeSent) {
        return {
          stage: 'qualifying',
          owner: 'bot',
          shouldRespond: true,
          directResponse: this.template(state.language, 'qualification_complete'),
          markQualificationNoticeOnSend: true,
        };
      }
      return {
        stage: 'qualifying',
        owner: 'bot',
        shouldRespond: true,
      };
    }

    let directive: FunnelDirective;

    if (!state.inquiryPurpose) {
      directive = this.questionDirective(
        state,
        'inquiry_purpose',
        this.template(state.language, 'ask_purpose')
      );
      return this.finalizeDirective(state, directive);
    }

    if (!state.clientName) {
      directive = this.questionDirective(
        state,
        'client_name',
        this.template(state.language, 'ask_name')
      );
      return this.finalizeDirective(state, directive);
    }

    if (state.inquiryPurpose === 'selling') {
      if (!state.termsPresented) {
        return this.finalizeDirective(state, {
          stage: 'identity_collected',
          owner: 'bot',
          shouldRespond: true,
          directResponse: this.template(state.language, 'seller_terms'),
          expectedField: 'seller_terms',
          markOnSend: 'terms_presented',
        });
      }

      if (state.termsAccepted !== true) {
        directive = this.questionDirective(
          state,
          'seller_terms',
          state.termsAccepted === false
            ? this.template(state.language, 'terms_declined')
            : this.template(state.language, 'ask_terms_acceptance')
        );
        return this.finalizeDirective(state, directive);
      }

      const sellerField = this.nextMissingSellerField(state);
      if (sellerField) {
        directive = this.questionDirective(
          state,
          sellerField,
          this.questionForField(state.language, sellerField, 'selling')
        );
        return this.finalizeDirective(state, directive);
      }
    }

    if (state.inquiryPurpose === 'buying') {
      const buyerField = this.nextMissingBuyerField(state);
      if (buyerField) {
        directive = this.questionDirective(
          state,
          buyerField,
          this.questionForField(state.language, buyerField, 'buying')
        );
        return this.finalizeDirective(state, directive);
      }
    }

    return {
      stage: state.stage,
      owner: state.owner,
      shouldRespond: false,
    };
  }

  /** Apply state transitions that are only valid after an outbound message sent. */
  confirmDirectiveSent(chatId: string, directive: FunnelDirective): void {
    const state = this.leadStates.get(chatId);
    if (!state) {
      return;
    }

    if (directive.expectedField) {
      state.expectedField = directive.expectedField;
    }

    switch (directive.markOnSend) {
      case 'terms_presented':
        state.termsPresented = true;
        state.stage = 'terms_presented';
        break;
      case 'question_sent':
      default:
        break;
    }

    if (directive.markReviewNoticeOnSend) {
      state.reviewNoticeSent = true;
    }
    if (directive.markQualificationNoticeOnSend) {
      state.qualificationNoticeSent = true;
    }

    state.pendingObjection = undefined;
    this.persist(chatId);
  }

  getConversationContext(chatId: string): string | null {
    const state = this.leadStates.get(chatId);
    if (!state) {
      return null;
    }

    const lines = [
      `FUNNEL STAGE: ${state.stage}`,
      `CONVERSATION OWNER: ${state.owner}`,
      `LANGUAGE: ${state.language}`,
    ];

    if (state.entryType === 'seller_inbound') {
      lines.push(
        'ENTRY SCENARIO: Seller inbound. Do not ask whether they want to buy or sell.'
      );
    } else if (state.entryType === 'buyer_inbound') {
      lines.push(
        'ENTRY SCENARIO: Buyer inbound. Do not ask whether they want to buy or sell.'
      );
    } else if (state.entryType === 'broker_lead') {
      lines.push(
        'ENTRY SCENARIO: SHARH broker lead. Record the available details for internal review and answer only with verified information.'
      );
    }

    const directive = this.getDirective(chatId);
    if (directive.expectedField) {
      lines.push(`NEXT REQUIRED FIELD: ${directive.expectedField}`);
    }
    if (directive.directResponse) {
      lines.push(`APPLICATION-OWNED NEXT MESSAGE: ${directive.directResponse}`);
    }
    if (state.status === 'qualified') {
      lines.push('CONTROL: Qualification is complete. Continue safe follow-up without restarting the questionnaire.');
    } else if (state.escalationReason === 'internal_review') {
      lines.push('CONTROL: The conversation is flagged for internal review. Continue the normal funnel using only verified, non-sensitive guidance.');
    }

    return lines.join('\n');
  }

  getKnownFactsBlock(chatId: string): string | null {
    const state = this.leadStates.get(chatId);
    if (!state) {
      return null;
    }

    const facts: string[] = [];
    const add = (label: string, value?: string): void => {
      if (value) facts.push(`- ${label}: ${value}`);
    };

    add('Name', state.clientName);
    add('Phone', state.clientPhone);
    add('Purpose', state.inquiryPurpose);
    add('Specific listing', state.specificListingCode);
    add('Business / sector', state.businessType);
    add('Location', state.businessLocation || state.buyerLocation);
    add('Annual revenue', state.annualRevenueAed);
    add('Lease', state.leaseDetails);
    add('Asking price', state.desiredSellingPriceAed);
    add('Year established', state.yearEstablished);
    add('Employees', state.employeeCount);
    add('Monthly operating expenses', state.monthlyOperatingExpensesAed);
    add('Monthly net profit', state.monthlyNetProfitAed);
    add('Liabilities', state.liabilities);
    add('Contracts / licences', state.contractsLicenses);
    add('Reason / urgency', state.saleReasonUrgency);
    add('Included assets', state.includedAssets);
    add('Buyer budget', state.buyerBudgetAed);
    add('Buyer timeline', state.buyerTimeline);
    add('Buyer involvement', state.buyerInvolvement);
    add('Funding status', state.buyerFundingStatus);
    add('Buyer comments', state.buyerAdditionalComments);

    const lines = [
      'KNOWN FACTS (authoritative; never ask for these again):',
      facts.length ? facts.join('\n') : '- None captured yet',
      `- Seller terms accepted: ${state.termsAccepted === true ? 'yes' : state.termsAccepted === false ? 'no' : 'not answered'}`,
      `- Completion: ${this.calculateCompletionPercent(state)}%`,
      `- Playbook version: ${this.playbook.getVersion()}`,
      `- Objections detected: ${state.objectionsDetected.join(', ') || 'none'}`,
    ];

    return lines.join('\n');
  }

  getCurrentRecord(chatId: string): LeadCaptureRecord | null {
    const state = this.leadStates.get(chatId);
    if (!state) {
      return null;
    }
    const synthetic: WhatsAppMessage = {
      id: 'snapshot',
      from: state.clientPhone || chatId,
      to: chatId,
      timestamp: Date.now(),
      type: 'text',
      content: '',
      isGroup: false,
    };
    return this.buildRecord(chatId, synthetic, state, []);
  }

  clearLeadState(chatId: string): void {
    this.leadStates.delete(chatId);
    this.persistence?.removeItem(PERSISTENCE_NAMESPACE, chatId);
  }

  private createInitialState(): LeadCaptureState {
    return {
      version: STATE_VERSION,
      entryType: 'unknown',
      language: 'en',
      termsPresented: false,
      status: 'new',
      stage: 'new',
      owner: 'bot',
      escalationReason: '',
      reviewNoticeSent: false,
      qualificationNoticeSent: false,
      objectionsDetected: [],
      messageCount: 0,
      processedMessageIds: new Set<string>(),
    };
  }

  private questionDirective(
    state: LeadCaptureState,
    field: LeadField,
    response: string
  ): FunnelDirective {
    return {
      stage: state.stage,
      owner: state.owner,
      shouldRespond: true,
      directResponse: response,
      expectedField: field,
      markOnSend: 'question_sent',
    };
  }

  private finalizeDirective(
    state: LeadCaptureState,
    directive: FunnelDirective
  ): FunnelDirective {
    let response = directive.directResponse;
    if (!response) {
      return directive;
    }

    if (state.pendingObjection) {
      response = `${this.playbook.objectionResponse(
        state.language,
        state.pendingObjection
      )}\n\n${response}`;
    }

    const includeReviewNotice =
      state.escalationReason === 'internal_review' && !state.reviewNoticeSent;
    if (includeReviewNotice) {
      response = `${this.template(state.language, 'review_notice')}\n\n${response}`;
    }

    return {
      ...directive,
      directResponse: response,
      markReviewNoticeOnSend: includeReviewNotice || undefined,
    };
  }

  private applyExplicitExtractions(
    state: LeadCaptureState,
    content: string,
    fieldsUpdated: string[]
  ): void {
    const listingCode = this.extractListingCode(content);
    this.setIfMissing(
      state,
      'specificListingCode',
      listingCode,
      'specific_listing_code',
      fieldsUpdated
    );

    const purpose = this.extractInquiryPurpose(content);
    this.setIfMissing(
      state,
      'inquiryPurpose',
      purpose,
      'inquiry_purpose',
      fieldsUpdated
    );

    const name = this.extractClientName(content);
    this.setIfMissing(state, 'clientName', name, 'client_name', fieldsUpdated);

    const textPhone = this.extractPhoneFromText(content);
    this.setIfMissing(
      state,
      'clientPhone',
      textPhone,
      'client_phone',
      fieldsUpdated
    );

    const businessType = this.extractBusinessType(content);
    this.setIfMissing(
      state,
      'businessType',
      businessType,
      'business_type',
      fieldsUpdated
    );

    const location = this.extractLocation(content);
    if (location) {
      if (state.inquiryPurpose === 'buying') {
        this.setIfMissing(
          state,
          'buyerLocation',
          location,
          'buyer_location',
          fieldsUpdated
        );
      } else {
        this.setIfMissing(
          state,
          'businessLocation',
          location,
          'business_location',
          fieldsUpdated
        );
      }
    }

    const annualRevenue = this.extractMoneyByHints(content, [
      /revenue|turnover|annual sales|yearly sales|per year|annually/i,
      /выручк|оборот|годов.*доход|за год/i,
      /الإيراد|المبيعات السنوية|سنوي/i,
    ]);
    this.setIfMissing(
      state,
      'annualRevenueAed',
      annualRevenue,
      'annual_revenue_aed',
      fieldsUpdated
    );

    const askingPrice = this.extractMoneyByHints(content, [
      /asking price|selling price|sell for|desired price|valuation|price/i,
      /цена продаж|хочу получить|оценк|стоимост/i,
      /سعر البيع|السعر المطلوب|التقييم/i,
    ]);
    this.setIfMissing(
      state,
      'desiredSellingPriceAed',
      askingPrice,
      'desired_selling_price_aed',
      fieldsUpdated
    );

    const buyerBudget = this.extractMoneyByHints(content, [
      /budget|invest(?:ment)? amount/i,
      /бюджет|сумма инвестиц/i,
      /الميزانية|مبلغ الاستثمار/i,
    ]);
    this.setIfMissing(
      state,
      'buyerBudgetAed',
      buyerBudget,
      'buyer_budget_aed',
      fieldsUpdated
    );

    const monthlyExpenses = this.extractMoneyByHints(content, [
      /operating expenses|monthly expenses|opex|costs per month/i,
      /операционн.*расход|ежемесячн.*расход|затрат.*месяц/i,
      /المصاريف التشغيلية|المصاريف الشهرية/i,
    ]);
    this.setIfMissing(
      state,
      'monthlyOperatingExpensesAed',
      monthlyExpenses,
      'monthly_operating_expenses_aed',
      fieldsUpdated
    );

    const monthlyProfit = this.extractMoneyByHints(content, [
      /net profit|monthly profit|profit per month/i,
      /чист.*прибыл|прибыл.*месяц/i,
      /صافي الربح|الربح الشهري/i,
    ]);
    this.setIfMissing(
      state,
      'monthlyNetProfitAed',
      monthlyProfit,
      'monthly_net_profit_aed',
      fieldsUpdated
    );

    const year = this.extractYearEstablished(content);
    this.setIfMissing(
      state,
      'yearEstablished',
      year,
      'year_established',
      fieldsUpdated
    );

    const employees = this.extractEmployeeCount(content);
    this.setIfMissing(
      state,
      'employeeCount',
      employees,
      'employee_count',
      fieldsUpdated
    );

    if (state.termsPresented && state.termsAccepted !== true) {
      const acceptance = this.extractAcceptance(content);
      if (acceptance !== null && state.termsAccepted !== acceptance) {
        state.termsAccepted = acceptance;
        fieldsUpdated.push('terms_accepted');
      }
    }
  }

  private applyExpectedField(
    state: LeadCaptureState,
    content: string,
    fieldsUpdated: string[]
  ): void {
    const expected = state.expectedField;
    if (!expected) {
      return;
    }

    if (expected === 'seller_terms') {
      const acceptance = this.extractAcceptance(content);
      if (acceptance !== null) {
        if (state.termsAccepted !== acceptance) {
          state.termsAccepted = acceptance;
          fieldsUpdated.push('terms_accepted');
        }
        state.expectedField = undefined;
      }
      return;
    }

    if (expected === 'inquiry_purpose') {
      const purpose = this.extractInquiryPurpose(content);
      if (purpose) {
        this.setIfMissing(
          state,
          'inquiryPurpose',
          purpose,
          'inquiry_purpose',
          fieldsUpdated
        );
        state.expectedField = undefined;
      }
      return;
    }

    if (expected === 'client_name') {
      const name = this.extractClientName(content, true);
      if (name) {
        this.setIfMissing(
          state,
          'clientName',
          name,
          'client_name',
          fieldsUpdated
        );
        state.expectedField = undefined;
      }
      return;
    }

    const stateKey = FIELD_TO_STATE_KEY[expected];
    if (this.hasValue(state[stateKey])) {
      state.expectedField = undefined;
      return;
    }

    if (this.looksLikeQuestion(content) && !this.isExplicitUnknown(content)) {
      return;
    }

    const extracted = this.extractExpectedValue(expected, content);
    if (!extracted) {
      return;
    }

    (state as unknown as Record<string, unknown>)[stateKey] = extracted;
    fieldsUpdated.push(expected);
    state.expectedField = undefined;
  }

  private extractExpectedValue(field: LeadField, content: string): string | null {
    if (this.isExplicitUnknown(content)) {
      return 'Unknown / to confirm';
    }

    switch (field) {
      case 'business_type':
        return this.extractBusinessType(content, true);
      case 'business_location':
      case 'buyer_location':
        return this.extractLocation(content, true);
      case 'annual_revenue_aed':
      case 'desired_selling_price_aed':
      case 'buyer_budget_aed':
      case 'monthly_operating_expenses_aed':
      case 'monthly_net_profit_aed':
        return this.extractMoneyExpression(content);
      case 'year_established':
        return this.extractYearEstablished(content, true);
      case 'employee_count':
        return this.extractEmployeeCount(content, true);
      case 'lease_details':
      case 'liabilities':
      case 'contracts_licenses':
      case 'sale_reason_urgency':
      case 'included_assets':
      case 'buyer_timeline':
      case 'buyer_involvement':
      case 'buyer_funding_status':
      case 'buyer_additional_comments':
        return this.cleanFreeTextAnswer(content);
      case 'inquiry_purpose':
      case 'client_name':
      case 'seller_terms':
        return null;
      default:
        return null;
    }
  }

  private setIfMissing<K extends keyof LeadCaptureState>(
    state: LeadCaptureState,
    key: K,
    value: LeadCaptureState[K] | null,
    fieldName: string,
    fieldsUpdated: string[]
  ): void {
    if (!this.hasValue(state[key]) && value !== null && this.hasValue(value)) {
      state[key] = value;
      fieldsUpdated.push(fieldName);
      if (state.expectedField && FIELD_TO_STATE_KEY[state.expectedField] === key) {
        state.expectedField = undefined;
      }
    }
  }

  private hasRequiredLeadFields(state: LeadCaptureState): boolean {
    if (!state.clientName || !state.clientPhone || !state.inquiryPurpose) {
      return false;
    }

    if (state.inquiryPurpose === 'selling') {
      return Boolean(
        state.termsAccepted === true &&
          SELLER_REQUIRED_FIELDS.every(field => this.hasValue(state[field]))
      );
    }

    return BUYER_REQUIRED_FIELDS.every(field => this.hasValue(state[field]));
  }

  private nextMissingSellerField(state: LeadCaptureState): LeadField | null {
    const ordered: Array<[keyof LeadCaptureState, LeadField]> = [
      ['businessType', 'business_type'],
      ['businessLocation', 'business_location'],
      ['annualRevenueAed', 'annual_revenue_aed'],
      ['leaseDetails', 'lease_details'],
      ['desiredSellingPriceAed', 'desired_selling_price_aed'],
      ['yearEstablished', 'year_established'],
      ['employeeCount', 'employee_count'],
      ['monthlyOperatingExpensesAed', 'monthly_operating_expenses_aed'],
      ['monthlyNetProfitAed', 'monthly_net_profit_aed'],
      ['liabilities', 'liabilities'],
      ['contractsLicenses', 'contracts_licenses'],
      ['saleReasonUrgency', 'sale_reason_urgency'],
      ['includedAssets', 'included_assets'],
    ];
    return ordered.find(([key]) => !this.hasValue(state[key]))?.[1] || null;
  }

  private nextMissingBuyerField(state: LeadCaptureState): LeadField | null {
    const ordered: Array<[keyof LeadCaptureState, LeadField]> = [
      ['businessType', 'business_type'],
      ['buyerBudgetAed', 'buyer_budget_aed'],
      ['buyerLocation', 'buyer_location'],
      ['buyerTimeline', 'buyer_timeline'],
      ['buyerInvolvement', 'buyer_involvement'],
      ['buyerFundingStatus', 'buyer_funding_status'],
      ['buyerAdditionalComments', 'buyer_additional_comments'],
    ];
    return ordered.find(([key]) => !this.hasValue(state[key]))?.[1] || null;
  }

  private recalculateStage(state: LeadCaptureState): void {
    if (state.status === 'qualified') {
      state.stage = 'qualifying';
      return;
    }

    if (state.inquiryPurpose === 'selling' && state.termsAccepted === true) {
      state.stage = 'qualifying';
      return;
    }

    if (state.inquiryPurpose === 'buying' && state.clientName) {
      state.stage = 'qualifying';
      return;
    }

    if (state.termsPresented) {
      state.stage = 'terms_presented';
      return;
    }

    if (state.clientName) {
      state.stage = 'identity_collected';
      return;
    }

    if (state.inquiryPurpose) {
      state.stage = 'intent_identified';
      return;
    }

    state.stage = 'new';
  }

  private buildRecord(
    chatId: string,
    message: WhatsAppMessage,
    state: LeadCaptureState,
    fieldsUpdated: string[]
  ): LeadCaptureRecord {
    const nextDirective = this.getDirective(chatId);
    const base: LeadCaptureRecord = {
      timestamp: new Date(message.timestamp).toISOString(),
      chatId,
      sourceJid: message.from,
      isGroup: message.isGroup,
      status: state.status,
      funnelStage: state.stage,
      owner: state.owner,
      escalationReason: state.escalationReason,
      clientName: state.clientName || '',
      clientPhone: state.clientPhone || '',
      language: state.language,
      inquiryPurpose: state.inquiryPurpose || '',
      specificListingCode: state.specificListingCode || '',
      termsAccepted:
        state.termsAccepted === true
          ? 'yes'
          : state.termsAccepted === false
            ? 'no'
            : '',
      annualRevenueAed: state.annualRevenueAed || '',
      businessType: state.businessType || '',
      businessLocation: state.businessLocation || '',
      leaseDetails: state.leaseDetails || '',
      desiredSellingPriceAed: state.desiredSellingPriceAed || '',
      yearEstablished: state.yearEstablished || '',
      employeeCount: state.employeeCount || '',
      monthlyOperatingExpensesAed: state.monthlyOperatingExpensesAed || '',
      monthlyNetProfitAed: state.monthlyNetProfitAed || '',
      liabilities: state.liabilities || '',
      contractsLicenses: state.contractsLicenses || '',
      saleReasonUrgency: state.saleReasonUrgency || '',
      includedAssets: state.includedAssets || '',
      buyerBudgetAed: state.buyerBudgetAed || '',
      buyerLocation: state.buyerLocation || '',
      buyerTimeline: state.buyerTimeline || '',
      buyerInvolvement: state.buyerInvolvement || '',
      buyerFundingStatus: state.buyerFundingStatus || '',
      buyerAdditionalComments: state.buyerAdditionalComments || '',
      completionPercent: this.calculateCompletionPercent(state),
      nextField: nextDirective.expectedField || '',
      fieldsUpdated: fieldsUpdated.join(', '),
      latestMessage: this.normalizeWhitespace(message.content),
      notes: state.escalationNotes || '',
      playbookVersion: this.playbook.getVersion(),
      leadScore: 0,
      leadGrade: 'D',
      leadTemperature: 'incomplete',
      scoreReasons: '',
      riskFlags: '',
      nextBestAction: '',
      nextBestActionCode: '',
      objectionsDetected: state.objectionsDetected.join(', '),
      conversationSummary: '',
      reviewBrief: '',
    };
    const score = this.scoring.evaluate(base);
    base.leadScore = score.score;
    base.leadGrade = score.grade;
    base.leadTemperature = score.temperature;
    base.scoreReasons = score.reasons.join(' | ');
    base.riskFlags = score.riskFlags.join(' | ');
    base.nextBestAction = score.nextBestAction;
    base.nextBestActionCode = score.nextBestActionCode;
    base.conversationSummary = this.summaries.build(base);
    base.reviewBrief = this.summaries.buildReviewBrief(base);
    return base;
  }

  private calculateCompletionPercent(state: LeadCaptureState): number {
    const base: Array<keyof LeadCaptureState> = [
      'clientName',
      'clientPhone',
      'inquiryPurpose',
    ];
    const fields =
      state.inquiryPurpose === 'selling'
        ? [...base, 'termsAccepted' as keyof LeadCaptureState, ...SELLER_REQUIRED_FIELDS]
        : state.inquiryPurpose === 'buying'
          ? [...base, ...BUYER_REQUIRED_FIELDS]
          : base;

    const completed = fields.filter(field => {
      if (field === 'termsAccepted') return state.termsAccepted === true;
      return this.hasValue(state[field]);
    }).length;
    return Math.round((completed / fields.length) * 100);
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

    if (entryType === 'buyer_inbound' && !state.inquiryPurpose) {
      state.inquiryPurpose = 'buying';
      fieldsUpdated.push('inquiry_purpose');
      return;
    }

    if (entryType === 'broker_lead') {
      const details = this.parseBrokerLeadDetails(content);
      state.brokerLeadSummary = details.summary;
      if (details.score) state.brokerLeadScore = details.score;
      this.markForReview(
        state,
        `SHARH broker lead discussion: ${details.summary}${
          details.score ? ` (Score ${details.score})` : ''
        }`
      );
    }
  }

  private detectEntryType(value: string): LeadEntryType {
    const normalized = value.toLowerCase();
    if (
      /sharh\s+broker/.test(normalized) &&
      /discussing\s+a\s+lead/.test(normalized)
    ) {
      return 'broker_lead';
    }
    const purpose = this.extractInquiryPurpose(value);
    if (purpose === 'selling') return 'seller_inbound';
    if (purpose === 'buying') return 'buyer_inbound';
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
      /\b(sell|selling|seller|sale|list my business)\b/.test(normalized) ||
      /(продать|продаю|продажа|продавец|выставить бизнес)/i.test(value) ||
      /(بيع|أبيع|بائع|عرض مشروعي للبيع)/i.test(value);
    const buyingMatch =
      /\b(buy|buying|buyer|purchase|acquire|acquisition|invest)\b/.test(
        normalized
      ) ||
      /(купить|покупаю|покупка|покупатель|приобрести|инвестировать)/i.test(
        value
      ) ||
      /(شراء|أشتري|مشتري|استحواذ|استثمار)/i.test(value);

    if (sellingMatch && !buyingMatch) return 'selling';
    if (buyingMatch && !sellingMatch) return 'buying';
    if (sellingMatch && buyingMatch) {
      if (/sell my business|продать.*бизнес|بيع.*مشروع/i.test(value)) {
        return 'selling';
      }
      return 'buying';
    }
    return null;
  }

  private extractClientName(
    value: string,
    allowStandalone: boolean = false
  ): string | null {
    const patterns: RegExp[] = [
      /\bmy name is\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
      /\bi am\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
      /\bi'?m\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
      /\bthis is\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
      /меня\s+зовут\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
      /(?:мо[её]\s+имя|имя)\s*[:=-]?\s*([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
      /(?:اسمي|أنا)\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
      /\bname\s*[:=-]\s*([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      const candidate = match?.[1] ? this.trimToPlausibleName(match[1]) : null;
      if (candidate) return this.normalizeName(candidate);
    }

    if (allowStandalone && this.looksLikeStandaloneName(value)) {
      const candidate = this.trimToPlausibleName(value);
      if (candidate && this.looksLikeStandaloneName(candidate)) {
        return this.normalizeName(candidate);
      }
    }
    return null;
  }

  private static readonly NAME_STOPWORDS = new Set<string>([
    'hello', 'hi', 'hey', 'yes', 'no', 'ok', 'okay', 'thanks', 'please',
    'and', 'i', 'we', 'want', 'would', 'like', 'looking', 'interested', 'need',
    'business', 'buy', 'buying', 'sell', 'selling', 'manager', 'agent',
    'привет', 'здравствуйте', 'да', 'нет', 'спасибо', 'и', 'я', 'мы', 'хочу',
    'бизнес', 'купить', 'продать', 'менеджер', 'агент', 'مرحبا', 'نعم', 'لا',
    'شكرا', 'أنا', 'أريد', 'مشروع',
    'شراء', 'بيع', 'مدير',
  ]);

  private trimToPlausibleName(value: string): string | null {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    const kept: string[] = [];
    for (const token of tokens) {
      const bare = token.replace(/[^\p{L}'’-]/gu, '').toLowerCase();
      if (!bare || LeadCaptureService.NAME_STOPWORDS.has(bare)) break;
      kept.push(token);
      if (kept.length === 3) break;
    }
    return kept.length ? kept.join(' ') : null;
  }

  private looksLikeStandaloneName(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 50 || /\d|[?!.:,;]/u.test(trimmed)) {
      return false;
    }
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 3) return false;
    if (!words.every(word => /^[\p{L}][\p{L}'’-]*$/u.test(word))) return false;
    return !words.every(word =>
      LeadCaptureService.NAME_STOPWORDS.has(word.toLowerCase())
    );
  }

  private normalizeName(value: string): string {
    return value
      .trim()
      .replace(/^['\-\s]+|['\-\s]+$/g, '')
      .split(/\s+/)
      .map(part => {
        if (/\p{Script=Arabic}/u.test(part)) return part;
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join(' ');
  }

  private extractBusinessType(
    value: string,
    allowWholeAnswer: boolean = false
  ): string | null {
    const patterns: RegExp[] = [
      /(?:business\s*(?:type|is|does|category)?|we (?:are|run)|i (?:run|own))\s*[:=-]?\s*(.+)$/i,
      /(?:it is|it's)\s+(?:a|an)\s+(.+)$/i,
      /(?:бизнес|компания|мы занимаемся|я владею|сфера)\s*[:=-]?\s*(.+)$/i,
      /(?:نشاط|المشروع|الشركة|أملك|ندير)\s*[:=-]?\s*(.+)$/i,
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match?.[1]) {
        const normalized = this.normalizeBusinessText(match[1]);
        if (normalized) return normalized;
      }
    }
    if (allowWholeAnswer) return this.normalizeBusinessText(value);
    return null;
  }

  private extractLocation(
    value: string,
    allowWholeAnswer: boolean = false
  ): string | null {
    if (allowWholeAnswer) return this.cleanFreeTextAnswer(value);

    const emirates = value.match(
      /\b(Dubai|Abu Dhabi|Sharjah|Ajman|Fujairah|Ras Al Khaimah|RAK|Umm Al Quwain)\b/i
    );
    if (emirates?.[0]) {
      const area = value.match(
        /(?:in|located in|area|district|район|в|منطقة|في)\s+([^,.!?]{2,60})/i
      );
      return this.cleanFreeTextAnswer(area?.[1] || emirates[0]);
    }
    if (/(дубай|абу-?даби|шардж|аджман|фуджейр|рас-?эль-?хайм|умм-?эль-?кувейн)/i.test(value)) {
      return this.cleanFreeTextAnswer(value);
    }
    if (/(دبي|أبوظبي|الشارقة|عجمان|الفجيرة|رأس الخيمة|أم القيوين)/i.test(value)) {
      return this.cleanFreeTextAnswer(value);
    }
    if (allowWholeAnswer) return this.cleanFreeTextAnswer(value);
    return null;
  }

  private extractMoneyByHints(value: string, hints: RegExp[]): string | null {
    if (!hints.some(hint => hint.test(value))) return null;
    return this.extractMoneyExpression(value);
  }

  private extractMoneyExpression(value: string): string | null {
    if (this.isExplicitUnknown(value)) return 'Unknown / to confirm';

    const rangeMatch = value.match(
      /(\d+(?:[.,]\d+)?)\s*(?:-|–|to|до|إلى)\s*(\d+(?:[.,]\d+)?)\s*(m|mn|million|k|thousand|млн|тыс|مليون|ألف)?/iu
    );
    if (rangeMatch?.[1] && rangeMatch[2]) {
      const unit = rangeMatch[3] || '';
      const first = this.scaleMoneyNumber(rangeMatch[1], unit);
      const second = this.scaleMoneyNumber(rangeMatch[2], unit);
      if (first && second) {
        return `AED ${first.toLocaleString('en-US')}–${second.toLocaleString('en-US')}`;
      }
    }

    const wordMillion = value.match(
      /\b(half|quarter|a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:a\s+)?million\b/i
    );
    if (wordMillion?.[1]) {
      const multipliers: Record<string, number> = {
        half: 0.5,
        quarter: 0.25,
        a: 1,
        one: 1,
        two: 2,
        three: 3,
        four: 4,
        five: 5,
        six: 6,
        seven: 7,
        eight: 8,
        nine: 9,
        ten: 10,
      };
      const multiplier = multipliers[wordMillion[1].toLowerCase()];
      if (multiplier) return this.formatAedAmount(multiplier * 1_000_000);
    }

    const scaled = value.match(
      /(\d+(?:[.,]\d+)?)\s*(m|mn|million|k|thousand|млн|миллион(?:а|ов)?|тыс(?:яч[аи]?)?|مليون|ألف)\b/iu
    );
    if (scaled?.[1] && scaled[2]) {
      const amount = this.scaleMoneyNumber(scaled[1], scaled[2]);
      if (amount) return this.formatAedAmount(amount);
    }

    const compact = value.match(
      /(?:aed|dhs?|dirhams?|дирхам(?:ов|а)?|درهم)?\s*(\d{1,3}(?:[ ,]\d{3})+|\d{4,12})(?:\s*(?:aed|dhs?|dirhams?|дирхам(?:ов|а)?|درهم))?/iu
    );
    if (compact?.[1]) {
      const parsed = Number.parseInt(compact[1].replace(/[ ,]/g, ''), 10);
      if (Number.isFinite(parsed) && parsed >= 1000) {
        return this.formatAedAmount(parsed);
      }
    }
    return null;
  }

  private scaleMoneyNumber(raw: string, unit: string): number | null {
    const base = Number.parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(base)) return null;
    const normalized = unit.toLowerCase();
    const multiplier = /^(m|mn|million|млн|миллион|миллиона|миллионов|مليون)$/u.test(
      normalized
    )
      ? 1_000_000
      : /^(k|thousand|тыс|тысяча|тысячи|тысяч|ألف)$/u.test(normalized)
        ? 1_000
        : 1;
    return Math.round(base * multiplier);
  }

  private formatAedAmount(amount: number): string {
    return `AED ${Math.round(amount).toLocaleString('en-US')}`;
  }

  private extractYearEstablished(
    value: string,
    allowWholeAnswer: boolean = false
  ): string | null {
    const match = value.match(/\b(19\d{2}|20\d{2})\b/);
    if (match?.[1]) return match[1];
    if (allowWholeAnswer && this.isExplicitUnknown(value)) {
      return 'Unknown / to confirm';
    }
    return null;
  }

  private extractEmployeeCount(
    value: string,
    allowWholeAnswer: boolean = false
  ): string | null {
    const match = value.match(
      /(\d{1,5})\s*(?:employees?|staff|people|сотрудник(?:а|ов)?|человек|موظف(?:ين)?)/iu
    );
    if (match?.[1]) return match[1];
    if (allowWholeAnswer) {
      const standalone = value.trim().match(/^\d{1,5}$/);
      if (standalone?.[0]) return standalone[0];
      if (this.isExplicitUnknown(value)) return 'Unknown / to confirm';
    }
    return null;
  }

  private extractAcceptance(value: string): boolean | null {
    const normalized = value.toLowerCase().trim();
    const reject =
      /\b(no|not agree|do not agree|decline|reject)\b/.test(normalized) ||
      /(нет|не согласен|не согласна|отказываюсь)/i.test(value) ||
      /(لا|غير موافق|لا أوافق|أرفض)/i.test(value);
    if (reject) return false;
    const accept =
      /\b(yes|agree|accepted|i accept|sounds good|okay|ok|proceed)\b/.test(
        normalized
      ) ||
      /(да|согласен|согласна|принимаю|подходит|продолжим)/i.test(value) ||
      /(نعم|موافق|أوافق|أقبل|تابع)/i.test(value);
    if (accept) return true;
    return null;
  }

  private extractListingCode(value: string): string | null {
    const match = value.match(/\bSH[-\s]?\d{1,12}\b/i);
    return match?.[0] ? match[0].replace(/\s/g, '-').toUpperCase() : null;
  }

  private extractPhoneFromText(value: string): string | null {
    const match = value.match(/(?:\+?\d[\d\s()-]{6,}\d)/);
    return match?.[0] ? this.normalizePhoneNumber(match[0]) : null;
  }

  private extractPhoneFromJid(jid: string): string | null {
    return this.normalizePhoneNumber(jid.split('@')[0] || '');
  }

  private normalizePhoneNumber(value: string): string | null {
    const trimmed = value.trim();
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (digitsOnly.length < 8) return null;
    return trimmed.startsWith('+') ? `+${digitsOnly}` : digitsOnly;
  }

  private detectEarlyEscalationReason(
    value: string,
    purpose?: LeadInquiryPurpose
  ): string | null {
    const normalized = value.toLowerCase();
    const managerRequest =
      /(connect|transfer|speak|talk).{0,25}(manager|human|agent|representative|consultant)|live manager|human agent/i.test(
        value
      ) ||
      /(соедин|перевед|поговорить|связаться).{0,25}(менеджер|человек|консультант)|живой оператор/i.test(
        value
      ) ||
      /(مدير|موظف|شخص حقيقي).{0,20}(تحدث|حول|اربط)|أريد مدير/i.test(value);
    if (managerRequest) return 'Explicit client request for human follow-up';

    const aggression =
      /\b(stupid|idiot|useless|terrible|worst|damn|shit|fuck)\b/.test(
        normalized
      ) || /(туп|идиот|бесполез|дерьм|ху[йяе])/i.test(value);
    if (aggression) return 'Aggressive language detected';

    const urgency =
      /\b(urgent|asap|immediately|right now|today only|need now)\b/.test(
        normalized
      ) || /(срочно|немедленно|прямо сейчас|сегодня)/i.test(value) ||
      /(عاجل|فوراً|الآن|اليوم)/i.test(value);
    if (urgency) return 'Significant urgency detected';

    const complexQuestion =
      /\b(legal|tax|compliance|valuation method|due diligence|contract clause|liability structure|corporate structure)\b/.test(
        normalized
      ) ||
      /(юридическ|налог|комплаенс|метод оценк|due diligence|структур.*обязательств)/i.test(
        value
      ) ||
      /(قانون|ضريبة|امتثال|طريقة التقييم|العناية الواجبة|بند العقد)/i.test(value);
    if (complexQuestion) return 'Complex question requiring internal review';

    return null;
  }


  private markQualified(state: LeadCaptureState): void {
    state.status = 'qualified';
    state.stage = 'qualifying';
    state.expectedField = undefined;
    state.qualificationNoticeSent = false;
  }

  private markForReview(state: LeadCaptureState, reason: string): void {
    if (
      state.escalationReason !== 'internal_review' ||
      state.escalationNotes !== reason
    ) {
      state.reviewNoticeSent = false;
    }
    state.escalationReason = 'internal_review';
    state.escalationNotes = reason;
  }

  private detectLanguage(
    value: string,
    current: ConversationLanguage,
    firstMessage: boolean
  ): ConversationLanguage {
    if (/\p{Script=Arabic}/u.test(value)) return 'ar';
    if (/\p{Script=Cyrillic}/u.test(value)) return 'ru';

    // Short neutral answers such as a location, a number, "yes", or an English
    // brand name must not unexpectedly switch a Russian or Arabic conversation.
    if (current !== 'en') {
      const explicitEnglishSwitch =
        /(?:continue|speak|reply|answer).{0,20}english|english\s+please/i.test(
          value
        );
      return explicitEnglishSwitch ? 'en' : current;
    }

    return firstMessage || /\p{Script=Latin}/u.test(value) ? 'en' : current;
  }

  private trimProcessedMessageIds(state: LeadCaptureState): void {
    while (state.processedMessageIds.size > MAX_PROCESSED_MESSAGE_IDS) {
      const oldest = state.processedMessageIds.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      state.processedMessageIds.delete(oldest);
    }
  }

  private normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private normalizeBusinessText(value: string): string | null {
    const cleaned = this.cleanFreeTextAnswer(value)
      ?.replace(/\b(?:in dubai|in abu dhabi|uae)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 2) return null;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  private cleanFreeTextAnswer(value: string): string | null {
    const cleaned = value
      .replace(/^[-–—,.:;\s]+|[-–—,.:;\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length > 1000) return null;
    return cleaned;
  }

  private looksLikeQuestion(value: string): boolean {
    return (
      /\?/.test(value) ||
      /^(what|why|how|when|where|who|can|do|does|is|are|will|could|would)\b/i.test(
        value
      ) ||
      /^(что|почему|как|когда|где|кто|можно|будет|есть ли)\b/i.test(value) ||
      /^(ما|ماذا|لماذا|كيف|متى|أين|هل|من)\b/u.test(value)
    );
  }

  private isExplicitUnknown(value: string): boolean {
    return (
      /\b(don't know|do not know|not sure|unknown|to confirm|n\/a)\b/i.test(
        value
      ) ||
      /(не знаю|не уверен|не уверена|нужно уточнить|нет данных)/i.test(value) ||
      /(لا أعرف|غير متأكد|غير معروفة|يحتاج تأكيد)/i.test(value)
    );
  }

  private hasValue(value: unknown): boolean {
    if (typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return typeof value === 'string' ? value.trim().length > 0 : value != null;
  }

  private questionForField(
    language: ConversationLanguage,
    field: LeadField,
    purpose?: LeadInquiryPurpose
  ): string {
    const questions: Record<ConversationLanguage, Partial<Record<LeadField, string>>> = {
      en: {
        business_type: 'What does the business do, or which sector interests you?',
        business_location: 'In which emirate and area is the business located?',
        annual_revenue_aed: 'What was the business’s revenue over the last 12 months?',
        lease_details: 'Is the premises leased, and what are the monthly rent and remaining lease term?',
        desired_selling_price_aed: 'What selling price or price range do you expect?',
        year_established: 'In which year was the business established?',
        employee_count: 'How many employees does the business have?',
        monthly_operating_expenses_aed: 'What are the approximate monthly operating expenses?',
        monthly_net_profit_aed: 'What is the approximate monthly net profit?',
        liabilities: 'Are there any debts or other liabilities?',
        contracts_licenses: 'Which active licences, supplier agreements, or important contracts are in place?',
        sale_reason_urgency: 'Why are you selling, and what timing do you have in mind?',
        included_assets: 'What is included in the sale, such as equipment, inventory, brand, or licences?',
        buyer_budget_aed: 'What budget or budget range have you allocated?',
        buyer_location: 'Which emirates or areas would you consider?',
        buyer_timeline: 'When would you like to complete an acquisition?',
        buyer_involvement: 'Do you want to operate the business yourself or invest more passively?',
        buyer_funding_status: 'Are the funds available now, or will financing be required?',
        buyer_additional_comments: 'Are there any other requirements I should record?',
      },
      ru: {
        business_type: 'Чем занимается бизнес или какая сфера вас интересует?',
        business_location: 'В каком эмирате и районе находится бизнес?',
        annual_revenue_aed: 'Какова выручка бизнеса за последние 12 месяцев?',
        lease_details: 'Помещение арендуется, и если да, какова месячная аренда и оставшийся срок договора?',
        desired_selling_price_aed: 'Какую цену продажи или диапазон вы ожидаете?',
        year_established: 'В каком году был основан бизнес?',
        employee_count: 'Сколько сотрудников работает в бизнесе?',
        monthly_operating_expenses_aed: 'Каковы примерные ежемесячные операционные расходы?',
        monthly_net_profit_aed: 'Какова примерная ежемесячная чистая прибыль?',
        liabilities: 'Есть ли долги или другие обязательства?',
        contracts_licenses: 'Какие действующие лицензии, договоры с поставщиками или важные контракты есть у бизнеса?',
        sale_reason_urgency: 'Почему вы продаёте бизнес и в какие сроки хотите завершить сделку?',
        included_assets: 'Что входит в продажу: оборудование, запасы, бренд, лицензии или другие активы?',
        buyer_budget_aed: 'Какой бюджет или диапазон бюджета вы предусмотрели?',
        buyer_location: 'Какие эмираты или районы вы рассматриваете?',
        buyer_timeline: 'Когда вы хотели бы завершить покупку?',
        buyer_involvement: 'Вы хотите управлять бизнесом лично или рассматриваете пассивную инвестицию?',
        buyer_funding_status: 'Средства уже доступны или потребуется финансирование?',
        buyer_additional_comments: 'Есть ли другие требования, которые нужно зафиксировать?',
      },
      ar: {
        business_type: 'ما نشاط المشروع أو القطاع الذي تهتم به؟',
        business_location: 'في أي إمارة ومنطقة يقع المشروع؟',
        annual_revenue_aed: 'ما إيرادات المشروع خلال آخر 12 شهراً؟',
        lease_details: 'هل الموقع مستأجر، وما قيمة الإيجار الشهري والمدة المتبقية في العقد؟',
        desired_selling_price_aed: 'ما سعر البيع أو النطاق السعري المتوقع؟',
        year_established: 'في أي سنة تأسس المشروع؟',
        employee_count: 'كم عدد الموظفين في المشروع؟',
        monthly_operating_expenses_aed: 'ما المصاريف التشغيلية الشهرية التقريبية؟',
        monthly_net_profit_aed: 'ما صافي الربح الشهري التقريبي؟',
        liabilities: 'هل توجد ديون أو التزامات أخرى؟',
        contracts_licenses: 'ما التراخيص والعقود المهمة أو اتفاقيات الموردين السارية؟',
        sale_reason_urgency: 'ما سبب البيع وما الإطار الزمني المطلوب لإتمام الصفقة؟',
        included_assets: 'ما الذي يشمله البيع، مثل المعدات أو المخزون أو العلامة التجارية أو التراخيص؟',
        buyer_budget_aed: 'ما الميزانية أو نطاق الميزانية المخصص؟',
        buyer_location: 'ما الإمارات أو المناطق التي تفضلها؟',
        buyer_timeline: 'متى ترغب في إتمام عملية الاستحواذ؟',
        buyer_involvement: 'هل تريد إدارة المشروع بنفسك أم تفضل استثماراً أكثر سلبية؟',
        buyer_funding_status: 'هل الأموال متاحة الآن أم ستحتاج إلى تمويل؟',
        buyer_additional_comments: 'هل توجد متطلبات أخرى تريد تسجيلها؟',
      },
    };
    if (field === 'business_type') {
      const purposeQuestions: Record<ConversationLanguage, Record<LeadInquiryPurpose, string>> = {
        en: {
          selling: 'What does your business do?',
          buying: 'Which business sector interests you?',
        },
        ru: {
          selling: 'Чем занимается ваш бизнес?',
          buying: 'Какая сфера бизнеса вас интересует?',
        },
        ar: {
          selling: 'ما نشاط مشروعك؟',
          buying: 'ما قطاع الأعمال الذي تهتم به؟',
        },
      };
      if (purpose) return purposeQuestions[language][purpose];
    }
    return questions[language][field] || questions.en[field] || 'Please provide the requested information.';
  }

  private template(
    language: ConversationLanguage,
    key:
      | 'ask_purpose'
      | 'ask_name'
      | 'seller_terms'
      | 'ask_terms_acceptance'
      | 'terms_declined'
      | 'review_notice'
      | 'qualification_complete'
  ): string {
    const templates: Record<ConversationLanguage, Record<string, string>> = {
      en: {
        ask_purpose:
          'Welcome to SHARH. We help clients buy and sell businesses across the UAE. Are you looking to buy or sell a business?',
        ask_name: 'Thank you. What name should I use?',
        seller_terms:
          'Before we continue: your information is treated as confidential, we sign an agreement before work begins, and approved businesses may be marketed through sharh.ae and SHARH channels. Our commission is 2% for transactions above USD 500,000 and USD 10,000 for transactions below that threshold. Do you agree to these terms?',
        ask_terms_acceptance: 'Do you agree to the SHARH confidentiality, process, and commission terms?',
        terms_declined:
          'Understood. Which part of the terms would you like clarified?',
        review_notice:
          'I have recorded this for SHARH review. I can continue helping with verified information and clarify any remaining details.',
        qualification_complete:
          'Thank you. Your information has been recorded successfully for SHARH review. I can still help with questions or clarify any details.',
      },
      ru: {
        ask_purpose:
          'Добро пожаловать в SHARH. Мы помогаем покупать и продавать бизнес по всему ОАЭ. Вы хотите купить или продать бизнес?',
        ask_name: 'Спасибо. Как я могу к вам обращаться?',
        seller_terms:
          'Перед продолжением: информация обрабатывается конфиденциально, до начала работы мы подписываем договор, а одобренный бизнес может продвигаться через sharh.ae и каналы SHARH. Комиссия составляет 2% для сделок свыше 500 000 USD и 10 000 USD для сделок ниже этого порога. Вы согласны с этими условиями?',
        ask_terms_acceptance:
          'Вы согласны с условиями SHARH по конфиденциальности, процессу и комиссии?',
        terms_declined: 'Понял. Какую часть условий нужно уточнить?',
        review_notice:
          'Я зафиксировал информацию для рассмотрения командой SHARH. Я могу продолжить отвечать на подтверждённые вопросы и уточнять детали.',
        qualification_complete:
          'Спасибо. Информация успешно сохранена для рассмотрения командой SHARH. Я могу продолжить отвечать на вопросы или уточнять детали.',
      },
      ar: {
        ask_purpose:
          'مرحباً بك في SHARH. نساعد العملاء على شراء وبيع المشاريع في جميع أنحاء الإمارات. هل ترغب في شراء مشروع أم بيعه؟',
        ask_name: 'شكراً. ما الاسم الذي تفضل أن أخاطبك به؟',
        seller_terms:
          'قبل المتابعة: نتعامل مع معلوماتك بسرية، ونوقع اتفاقية قبل بدء العمل، ويمكن تسويق المشروع المعتمد عبر sharh.ae وقنوات SHARH. العمولة 2% للصفقات التي تتجاوز 500,000 دولار و10,000 دولار للصفقات الأقل من ذلك. هل توافق على هذه الشروط؟',
        ask_terms_acceptance:
          'هل توافق على شروط SHARH المتعلقة بالسرية والإجراءات والعمولة؟',
        terms_declined: 'مفهوم. أي جزء من الشروط تريد توضيحه؟',
        review_notice:
          'تم تسجيل المعلومات لمراجعة فريق SHARH. ويمكنني الاستمرار في تقديم المعلومات الموثقة وتوضيح التفاصيل.',
        qualification_complete:
          'شكراً. تم حفظ معلوماتك بنجاح لمراجعة فريق SHARH. ويمكنني الاستمرار في الإجابة عن الأسئلة أو توضيح التفاصيل.',
      },
    };
    return templates[language][key] || templates.en[key] || '';
  }

}
