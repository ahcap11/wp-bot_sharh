import { WhatsAppMessage } from '../types';
import { PersistenceService } from './persistence.service';
import { SalesPlaybookService, ObjectionTopic } from './sales-playbook.service';
import { LeadScoringService } from './lead-scoring.service';
import { ConversationSummaryService } from './conversation-summary.service';
import { SHARH_FEE_TERMS } from '../playbooks/sharh-sales.v1';
import type {
  SalesMessageInterpretation,
  SalesMessageClassification,
} from './sales-message-intelligence.types';

const PERSISTENCE_NAMESPACE = 'leadStates';
const STATE_VERSION = 14;
const REENTRY_REPEAT_WINDOW_MS = 30 * 60 * 1000;
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
  | 'qualifying'
  | 'ready_for_review';
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
  | 'buyer_additional_comments'
  | 'contact_preference';

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
  buyerMinimumAnnualProfitAed: string;
  buyerMinimumRoiPct: string;
  buyerReturnPeriod: string;
  buyerExcludedSectors: string;
  buyerProfitableOnly: boolean;
  contactPreference: string;
  nextStep: string;
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
  markInputIssueHandledOnSend?: boolean | undefined;
}

export interface NavigationResult {
  handled: boolean;
  response?: string | undefined;
  resetAiUsage?: boolean | undefined;
  restartConfirmed?: boolean | undefined;
  continueFunnel?: boolean | undefined;
  action?: 'back' | 'change' | 'review' | 'restart' | 'switch' | 'pause' | 'resume' | 'help' | undefined;
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
  buyerMinimumAnnualProfitAed?: string | undefined;
  buyerMinimumRoiPct?: string | undefined;
  buyerReturnAmountAed?: string | undefined;
  buyerReturnPeriod?: 'annual' | 'monthly' | 'ambiguous' | undefined;
  buyerExcludedSectors?: string | undefined;
  buyerProfitableOnly?: boolean | undefined;
  contactPreference?: string | undefined;
  nextStep?: 'submit' | 'details' | 'contact' | 'website' | 'later' | undefined;
  optionalDetailsMode: boolean;
  pendingContactRequest: boolean;
  pendingSubmitRequest: boolean;
  submittedForReview: boolean;
  websiteLinkSent: boolean;
  continueLater: boolean;
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
  suggestedSellingPriceAed?: string | undefined;
  lastPromptField?: LeadField | undefined;
  promptRepeatCount: number;
  invalidAttempts: Partial<Record<LeadField, number>>;
  lastInputClassification?: SalesMessageClassification | undefined;
  lastInputIssue?: string | undefined;
  pendingConfirmation?:
    | { field: LeadField; value: string; reason: string }
    | undefined;
  priceGuidanceCount: number;
  paused: boolean;
  pendingRestartConfirmation: boolean;
  lastUserMessageAt?: number | undefined;
  lastReentryPromptAt?: number | undefined;
  awaitingReentryChoice: boolean;
  reentryPromptCount: number;
  activeCaseStartedAt?: number | undefined;
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
  'desiredSellingPriceAed',
];

const SELLER_PROFILE_FIELDS: Array<keyof LeadCaptureState> = [
  'businessType',
  'businessLocation',
  'annualRevenueAed',
  'monthlyNetProfitAed',
  'monthlyOperatingExpensesAed',
  'leaseDetails',
  'desiredSellingPriceAed',
  'yearEstablished',
  'employeeCount',
  'liabilities',
  'contractsLicenses',
  'saleReasonUrgency',
  'includedAssets',
];

const BUYER_REQUIRED_FIELDS: Array<keyof LeadCaptureState> = [
  'businessType',
  'buyerBudgetAed',
];

const BUYER_PROFILE_FIELDS: Array<keyof LeadCaptureState> = [
  'businessType',
  'buyerBudgetAed',
  'buyerLocation',
  'buyerTimeline',
  'buyerInvolvement',
  'buyerFundingStatus',
  'buyerAdditionalComments',
];

const BUYER_CRITERIA_FIELDS: Array<keyof LeadCaptureState> = [
  'buyerMinimumAnnualProfitAed',
  'buyerMinimumRoiPct',
  'buyerReturnAmountAed',
  'buyerReturnPeriod',
  'buyerExcludedSectors',
  'buyerProfitableOnly',
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
  contact_preference: 'contactPreference',
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
      const migratedFromOlderFlow = (serialized.version || 0) < STATE_VERSION;
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
          (migratedFromOlderFlow && restoredStatus === 'qualified') ||
          serialized.qualificationNoticeSent ||
          serialized.closingMessageSent ||
          Boolean(serialized.reviewNoticeSent && restoredStatus === 'qualified') ||
          false,
        awaitingReentryChoice: false,
        reentryPromptCount: 0,
        lastReentryPromptAt: undefined,
        objectionsDetected: serialized.objectionsDetected || [],
        promptRepeatCount: serialized.promptRepeatCount || 0,
        invalidAttempts: serialized.invalidAttempts || {},
        lastInputClassification: serialized.lastInputClassification,
        lastInputIssue: serialized.lastInputIssue,
        pendingConfirmation: serialized.pendingConfirmation,
        priceGuidanceCount: serialized.priceGuidanceCount || 0,
        paused: serialized.paused || false,
        pendingRestartConfirmation: serialized.pendingRestartConfirmation || false,
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
    if (status === 'qualified') return 'ready_for_review';
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
    message: WhatsAppMessage,
    interpretation: SalesMessageInterpretation | null = null
  ): LeadCaptureUpdate {
    const state = this.leadStates.get(chatId) ?? this.createInitialState();

    if (state.processedMessageIds.has(message.id)) {
      return { shouldPersist: false };
    }

    const previousStatus = state.status;
    const previousStage = state.stage;
    const expectedBefore = state.expectedField;

    state.processedMessageIds.add(message.id);
    this.trimProcessedMessageIds(state);
    state.messageCount += 1;
    state.lastUserMessageAt = Date.now();
    if (state.status === 'new') {
      state.status = 'contacted';
    }
    const fieldsUpdated: string[] = [];
    const normalizedContent = this.normalizeWhitespace(message.content);
    if (!this.isGreeting(normalizedContent)) {
      state.awaitingReentryChoice = false;
    }

    const interpretedLanguage =
      interpretation && interpretation.confidence >= 0.65
        ? interpretation.language
        : null;
    const detectedLanguage =
      interpretedLanguage ||
      this.detectLanguage(
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

    const confirmationHandled = this.applyPendingConfirmation(
      state,
      normalizedContent,
      fieldsUpdated
    );

    const objection = this.playbook.detectObjection(normalizedContent);
    if (objection) {
      state.pendingObjection = objection;
      if (!state.objectionsDetected.includes(objection)) {
        state.objectionsDetected.push(objection);
        fieldsUpdated.push('objection_detected');
      }
    }

    let intelligenceAccepted = 0;
    if (interpretation && interpretation.confidence >= 0.5) {
      state.lastInputClassification = interpretation.classification;
      intelligenceAccepted = this.applyIntelligentInterpretation(
        state,
        interpretation,
        fieldsUpdated
      );
    }

    const blocksDeterministicAnswer = Boolean(
      interpretation &&
        interpretation.confidence >= 0.65 &&
        ['question', 'off_topic', 'nonsense', 'abusive'].includes(
          interpretation.classification
        ) &&
        intelligenceAccepted === 0
    );

    const interpretationMentionedExpected = Boolean(
      expectedBefore &&
        interpretation &&
        (Object.prototype.hasOwnProperty.call(
          interpretation.fields,
          expectedBefore
        ) || interpretation.unknownFields.includes(expectedBefore))
    );
    const interpretationProvidedOtherFields = Boolean(
      interpretation &&
        (Object.keys(interpretation.fields).length > 0 ||
          interpretation.unknownFields.length > 0) &&
        !interpretationMentionedExpected
    );

    if (
      !confirmationHandled &&
      !objection &&
      !blocksDeterministicAnswer &&
      !state.pendingConfirmation &&
      !(
        interpretation &&
        interpretation.confidence >= 0.65 &&
        interpretationProvidedOtherFields
      )
    ) {
      // The current application-owned question has priority. If the AI
      // interpreter already populated it, this is a no-op. When the user is
      // explicitly correcting another field, do not reinterpret the same
      // number as an answer to the currently expected field.
      this.applyExpectedField(state, normalizedContent, fieldsUpdated);
    }

    const interpretationProvidedValidatedFields = Boolean(
      interpretation &&
        interpretation.confidence >= 0.65 &&
        (Object.keys(interpretation.fields).length > 0 ||
          interpretation.unknownFields.length > 0)
    );
    if (
      !blocksDeterministicAnswer &&
      !state.pendingConfirmation &&
      !interpretationProvidedValidatedFields
    ) {
      // Deterministic extraction is a fallback when structured interpretation
      // is unavailable. It is deliberately skipped for high-confidence
      // multi-value messages because one unlabelled number must never be copied
      // into several financial fields.
      this.applyExplicitExtractions(state, normalizedContent, fieldsUpdated);
    }

    // Buyer matching criteria are safety-critical and must be extracted even
    // when the AI interpreter supplied other structured fields. The parser is
    // deterministic and only handles explicit budget/return/involvement text.
    if (state.inquiryPurpose === 'buying') {
      this.applyBuyerCriteriaExtractions(state, normalizedContent, fieldsUpdated);
    }

    const expectedStillMissing = Boolean(
      expectedBefore && !this.hasValue(state[FIELD_TO_STATE_KEY[expectedBefore]])
    );
    if (
      expectedBefore &&
      expectedStillMissing &&
      !confirmationHandled &&
      !objection &&
      !this.looksLikeQuestion(normalizedContent) &&
      !this.isExplicitUnknown(normalizedContent)
    ) {
      const classification = interpretation?.classification;
      if (
        !classification ||
        ['valid_answer', 'multiple_answers', 'correction', 'nonsense', 'off_topic', 'abusive'].includes(
          classification
        )
      ) {
        this.registerInvalidAttempt(
          state,
          expectedBefore,
          interpretation?.reason || 'The answer could not be validated.'
        );
      }
    } else if (
      expectedBefore &&
      this.hasValue(state[FIELD_TO_STATE_KEY[expectedBefore]])
    ) {
      state.lastInputIssue = undefined;
    }

    const reviewReason = this.detectEarlyEscalationReason(normalizedContent);
    if (reviewReason) {
      this.markForReview(state, reviewReason);
    }

    const meaningfulUpdates = fieldsUpdated.filter(
      field => !['language', 'client_phone', 'entry_type'].includes(field)
    );
    if (state.optionalDetailsMode && (meaningfulUpdates.length > 0 || this.isExplicitUnknown(normalizedContent))) {
      state.optionalDetailsMode = false;
      state.nextStep = 'details';
      state.qualificationNoticeSent = false;
    }
    if (state.continueLater) {
      state.continueLater = false;
    }

    if (state.status !== 'qualified' && this.hasRequiredLeadFields(state)) {
      this.markQualified(state);
    } else if (state.status === 'qualified' && meaningfulUpdates.length > 0) {
      state.qualificationNoticeSent = false;
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
      state.messageCount === 1 ||
      Boolean(state.lastInputIssue) ||
      Boolean(state.pendingConfirmation);

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

    if (state.paused) {
      return {
        stage: state.stage,
        owner: state.owner,
        shouldRespond: false,
      };
    }

    if (state.pendingConfirmation) {
      return {
        stage: state.stage,
        owner: state.owner,
        shouldRespond: true,
        directResponse: this.confirmationQuestion(
          state.language,
          state.pendingConfirmation
        ),
        expectedField: state.pendingConfirmation.field,
        markOnSend: 'question_sent',
      };
    }

    if (state.lastInputIssue && state.expectedField) {
      return {
        stage: state.stage,
        owner: state.owner,
        shouldRespond: true,
        directResponse: this.invalidAnswerResponse(
          state.language,
          state.expectedField,
          state.invalidAttempts[state.expectedField] || 1,
          state.lastInputClassification
        ),
        expectedField: state.expectedField,
        markOnSend: 'question_sent',
        markInputIssueHandledOnSend: true,
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

    if (state.inquiryPurpose === 'selling') {
      if (!state.pendingContactRequest && !state.termsPresented) {
        return this.finalizeDirective(state, {
          stage: 'intent_identified',
          owner: 'bot',
          shouldRespond: true,
          directResponse: this.template(state.language, 'seller_terms'),
          expectedField: 'seller_terms',
          markOnSend: 'terms_presented',
        });
      }

      if (!state.pendingContactRequest && state.termsAccepted !== true) {
        directive = this.questionDirective(
          state,
          'seller_terms',
          state.termsAccepted === false
            ? this.template(state.language, 'terms_declined')
            : this.template(state.language, 'ask_terms_acceptance')
        );
        return this.finalizeDirective(state, directive);
      }
    }

    if (state.pendingContactRequest) {
      if (!state.contactPreference) {
        return this.questionDirective(
          state,
          'contact_preference',
          this.contactRequestPrompt(state.language)
        );
      }
      state.pendingContactRequest = false;
      state.submittedForReview = true;
      state.nextStep = 'contact';
      this.persist(chatId);
      return {
        stage: 'ready_for_review',
        owner: 'bot',
        shouldRespond: true,
        directResponse: this.contactRequestConfirmed(state.language),
        markQualificationNoticeOnSend: true,
      };
    }

    if (state.pendingSubmitRequest) {
      if (!state.clientName) {
        return this.questionDirective(
          state,
          'client_name',
          this.template(state.language, 'ask_name')
        );
      }
      state.pendingSubmitRequest = false;
      state.submittedForReview = true;
      state.nextStep = 'submit';
      this.persist(chatId);
      return {
        stage: 'ready_for_review',
        owner: 'bot',
        shouldRespond: true,
        directResponse: this.submissionConfirmed(state.language),
        markQualificationNoticeOnSend: true,
      };
    }

    if (state.optionalDetailsMode) {
      return {
        stage: 'ready_for_review',
        owner: 'bot',
        shouldRespond: true,
        directResponse: this.optionalDetailsPrompt(state.language, state.inquiryPurpose),
      };
    }

    if (state.status !== 'qualified') {
      if (state.inquiryPurpose === 'selling') {
        const sellerField = this.nextMissingSellerField(state);
        if (sellerField) {
          directive = this.questionDirective(
            state,
            sellerField,
            this.questionForField(
              state.language,
              sellerField,
              'selling',
              state.lastPromptField === sellerField && state.promptRepeatCount > 0
            )
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
            this.questionForField(
              state.language,
              buyerField,
              'buying',
              state.lastPromptField === buyerField && state.promptRepeatCount > 0
            )
          );
          return this.finalizeDirective(state, directive);
        }
      }
    }

    if (state.status === 'qualified') {
      if (!state.qualificationNoticeSent) {
        return {
          stage: 'ready_for_review',
          owner: 'bot',
          shouldRespond: true,
          directResponse: this.nextStepMenu(state),
          markQualificationNoticeOnSend: true,
        };
      }
      return {
        stage: 'ready_for_review',
        owner: 'bot',
        shouldRespond: true,
      };
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
      if (state.lastPromptField === directive.expectedField) {
        state.promptRepeatCount += 1;
      } else {
        state.lastPromptField = directive.expectedField;
        state.promptRepeatCount = 1;
      }
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
    if (directive.markInputIssueHandledOnSend) {
      state.lastInputIssue = undefined;
    }

    state.pendingObjection = undefined;
    this.persist(chatId);
  }

  isPriceGuidanceRequest(chatId: string, content: string): boolean {
    const state = this.leadStates.get(chatId);
    if (!state || state.inquiryPurpose !== 'selling') return false;

    const normalized = content.trim().toLowerCase();
    const selectedGuidanceOption =
      state.expectedField === 'desired_selling_price_aed' && normalized === '6';
    return (
      selectedGuidanceOption ||
      /(?:what (?:would|do) you suggest|suggest(?:ed)? price|recommend(?:ed)? price|how much (?:should|can) i sell|what(?:'s| is) (?:it|the business) worth|give me (?:a )?(?:price|valuation)|price guidance)/i.test(content) ||
      /(?:какую цену (?:вы )?предложите|что посоветуете|рекомендуемая цена|сколько стоит бизнес|оцените бизнес|предложите цену)/i.test(content) ||
      /(?:ما السعر الذي تقترحه|اقترح سعراً|كم تساوي الشركة|تقييم المشروع|السعر المقترح)/u.test(content)
    );
  }

  setSuggestedSellingPrice(chatId: string, value: string): void {
    const state = this.leadStates.get(chatId);
    if (!state) return;
    state.suggestedSellingPriceAed = value;
    state.expectedField = 'desired_selling_price_aed';
    this.persist(chatId);
  }

  getPriceGuidanceDirective(
    chatId: string,
    suggestedRange?: string
  ): FunnelDirective {
    const state = this.leadStates.get(chatId) ?? this.createInitialState();

    if (suggestedRange) {
      const repeated =
        state.priceGuidanceCount > 0 &&
        state.suggestedSellingPriceAed === suggestedRange;
      state.suggestedSellingPriceAed = suggestedRange;
      state.priceGuidanceCount += 1;
      this.leadStates.set(chatId, state);
      this.persist(chatId);
      const firstMessages: Record<ConversationLanguage, string> = {
        en: `Based on the information recorded so far, SHARH's indicative range is ${suggestedRange}. This is a preliminary estimate, not a final valuation.

1. Use this as my expected range
2. I will enter a different price
3. Record price as undecided`,
        ru: `По текущим данным ориентировочный диапазон SHARH — ${suggestedRange}. Это предварительная оценка, а не финальная стоимость.

1. Использовать этот диапазон как ожидаемую цену
2. Я укажу другую цену
3. Пока цена не определена`,
        ar: `استناداً إلى المعلومات المسجلة حتى الآن، النطاق التقديري من SHARH هو ${suggestedRange}. هذا تقدير أولي وليس تقييماً نهائياً.

1. استخدام هذا النطاق كسعري المتوقع
2. سأدخل سعراً مختلفاً
3. تسجيل السعر كغير محدد حالياً`,
      };
      const repeatMessages: Record<ConversationLanguage, string> = {
        en: `The current indicative range remains ${suggestedRange}. Please reply with 1 to use it, 2 to enter another price, or 3 to leave the price undecided.`,
        ru: `Текущий ориентировочный диапазон остаётся ${suggestedRange}. Ответьте 1, чтобы использовать его, 2 — указать другую цену, или 3 — пока не определять цену.`,
        ar: `يبقى النطاق التقديري الحالي ${suggestedRange}. أجب 1 لاستخدامه، أو 2 لإدخال سعر آخر، أو 3 لترك السعر غير محدد حالياً.`,
      };
      const messages = repeated ? repeatMessages : firstMessages;
      return this.questionDirective(
        state,
        'desired_selling_price_aed',
        messages[state.language]
      );
    }

    const fallback: Record<ConversationLanguage, string> = {
      en: `I can suggest an indicative range, but I could not calculate it at this moment. Please type your own range, choose one of the options below, or reply “unknown”.

1. Under AED 250,000
2. AED 250,000–500,000
3. AED 500,000–1,000,000
4. AED 1,000,000–3,000,000
5. AED 3,000,000+
6. Try the SHARH estimate again`,
      ru: `Я могу предложить ориентировочный диапазон, но сейчас расчёт недоступен. Укажите свой диапазон, выберите вариант ниже или ответьте «не знаю».

1. До 250 000 AED
2. 250 000–500 000 AED
3. 500 000–1 000 000 AED
4. 1 000 000–3 000 000 AED
5. Более 3 000 000 AED
6. Повторить расчёт SHARH`,
      ar: `يمكنني اقتراح نطاق تقديري، لكن تعذر إجراء الحساب الآن. اكتب نطاقك، اختر أحد الخيارات أدناه، أو اكتب «غير معروف».

1. أقل من 250,000 درهم
2. 250,000–500,000 درهم
3. 500,000–1,000,000 درهم
4. 1,000,000–3,000,000 درهم
5. أكثر من 3,000,000 درهم
6. إعادة محاولة تقدير SHARH`,
    };
    return this.questionDirective(
      state,
      'desired_selling_price_aed',
      fallback[state.language]
    );
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
    add('Contact preference', state.contactPreference);
    add('Selected next step', state.nextStep);

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

  isRestartRecoveryCommand(chatId: string, rawContent: string): boolean {
    const content = this.normalizeWhitespace(rawContent).toLowerCase();
    const state = this.leadStates.get(chatId);
    if (this.isStartOverCommand(content)) return true;
    if (!state?.pendingRestartConfirmation) return false;
    return /^(?:yes|yes start over|confirm|1|no|cancel|2|да|подтверждаю|нет|отмена|نعم|تأكيد|لا|إلغاء)$/iu.test(content);
  }

  handleNavigationCommand(chatId: string, rawContent: string): NavigationResult {
    const content = this.normalizeWhitespace(rawContent);
    const lower = content.toLowerCase();
    const state = this.leadStates.get(chatId) ?? this.createInitialState();
    this.leadStates.set(chatId, state);

    if (state.pendingRestartConfirmation) {
      if (/^(?:yes|yes start over|confirm|1|да|подтверждаю|نعم|تأكيد)$/iu.test(lower)) {
        const language = state.language;
        const phone = state.clientPhone;
        const fresh = this.createInitialState();
        fresh.language = language;
        fresh.clientPhone = phone;
        this.leadStates.set(chatId, fresh);
        this.persist(chatId);
        const directive = this.getDirective(chatId);
        return {
          handled: true,
          response: this.navigationPrefix(language, 'restart_done', directive.directResponse),
          resetAiUsage: true,
          restartConfirmed: true,
          continueFunnel: true,
          action: 'restart',
        };
      }
      if (/^(?:no|cancel|2|нет|отмена|لا|إلغاء)$/iu.test(lower)) {
        state.pendingRestartConfirmation = false;
        this.persist(chatId);
        return {
          handled: true,
          response: this.navigationMessage(state.language, 'restart_cancelled'),
          action: 'restart',
        };
      }
    }

    if (this.isStartOverCommand(lower)) {
      state.pendingRestartConfirmation = true;
      this.persist(chatId);
      return {
        handled: true,
        response: this.navigationMessage(state.language, 'restart_confirm'),
        action: 'restart',
      };
    }

    if (/^(?:stop|pause|cancel for now|стоп|пауза|остановить|توقف|إيقاف مؤقت)$/iu.test(lower)) {
      state.paused = true;
      this.persist(chatId);
      return {
        handled: true,
        response: this.navigationMessage(state.language, 'paused'),
        action: 'pause',
      };
    }

    if (state.paused) {
      if (/^(?:resume|continue|carry on|продолжить|возобновить|تابع|استئناف)$/iu.test(lower)) {
        state.paused = false;
        this.persist(chatId);
        const directive = this.getDirective(chatId);
        return {
          handled: true,
          response: this.navigationPrefix(state.language, 'resumed', directive.directResponse),
          continueFunnel: true,
          action: 'resume',
        };
      }
      return {
        handled: true,
        response: this.navigationMessage(state.language, 'still_paused'),
        action: 'pause',
      };
    }

    const requestedLanguage = this.detectExplicitLanguageSwitch(lower);
    if (requestedLanguage) {
      state.language = requestedLanguage;
      state.lastInputIssue = undefined;
      state.qualificationNoticeSent = false;
      this.persist(chatId);
      const directive = this.getDirective(chatId);
      const prefix: Record<ConversationLanguage, string> = {
        en: 'Certainly. I will continue in English.',
        ru: 'Хорошо. Продолжу на русском языке.',
        ar: 'بالتأكيد. سأتابع باللغة العربية.',
      };
      return {
        handled: true,
        response: [prefix[requestedLanguage], directive.directResponse].filter(Boolean).join('\n\n'),
        continueFunnel: true,
        action: 'help',
      };
    }

    const previousUserMessageAt = state.lastUserMessageAt;
    const now = Date.now();
    state.lastUserMessageAt = now;

    if (state.status === 'qualified') {
      const newCasePurpose = this.detectNewCasePurpose(lower, state.awaitingReentryChoice);
      if (newCasePurpose) {
        const language = state.language;
        this.beginSeparateCase(state, newCasePurpose);
        this.persist(chatId);
        const directive = this.getDirective(chatId);
        return {
          handled: true,
          response: this.newCasePrefix(language, newCasePurpose, directive.directResponse),
          resetAiUsage: true,
          restartConfirmed: true,
          continueFunnel: true,
          action: 'switch',
        };
      }

      if (this.isNewRequestCommand(lower)) {
        state.awaitingReentryChoice = true;
        state.lastReentryPromptAt = now;
        state.reentryPromptCount += 1;
        this.persist(chatId);
        return {
          handled: true,
          response: this.newRequestDisambiguation(state.language),
          action: 'help',
        };
      }

      if (this.isGreeting(content)) {
        const recentlyPrompted = Boolean(
          state.lastReentryPromptAt && now - state.lastReentryPromptAt < REENTRY_REPEAT_WINDOW_MS
        );
        state.awaitingReentryChoice = true;
        state.lastReentryPromptAt = now;
        state.reentryPromptCount += 1;
        this.persist(chatId);
        return {
          handled: true,
          response: recentlyPrompted
            ? this.shortReentryPrompt(state)
            : this.contextualReentryPrompt(state),
          action: 'help',
        };
      }

      if (state.awaitingReentryChoice && this.isCurrentCaseReference(lower)) {
        state.awaitingReentryChoice = false;
        this.persist(chatId);
        return {
          handled: true,
          response: this.currentCaseStatus(state),
          action: 'review',
        };
      }

      if (
        this.isCurrentCaseStatusQuestion(lower) ||
        (previousUserMessageAt && now - previousUserMessageAt > REENTRY_REPEAT_WINDOW_MS && this.isVagueHelpRequest(lower))
      ) {
        state.awaitingReentryChoice = false;
        this.persist(chatId);
        return {
          handled: true,
          response: this.currentCaseStatus(state),
          action: 'review',
        };
      }
    }

    if (state.status === 'qualified' && state.inquiryPurpose === 'selling') {
      if (/^(?:1|submit|submit it|submit for review|send for review|review it|подать|отправить на рассмотрение|إرسال للمراجعة)$/iu.test(lower)) {
        state.pendingSubmitRequest = true;
        state.nextStep = undefined;
        state.qualificationNoticeSent = false;
        this.persist(chatId);
        const directive = this.getDirective(chatId);
        return { handled: true, response: directive.directResponse, continueFunnel: true, action: 'review' };
      }
      if (/^(?:2|add details|add more details|more details|continue with details|добавить детали|добавить подробности|إضافة تفاصيل)$/iu.test(lower)) {
        state.optionalDetailsMode = true;
        state.nextStep = 'details';
        state.qualificationNoticeSent = true;
        this.persist(chatId);
        return { handled: true, response: this.optionalDetailsPrompt(state.language, 'selling'), action: 'review' };
      }
      if (/^(?:3|website|continue on website|open website|send the website link|site|перейти на сайт|продолжить на сайте|الموقع|تابع على الموقع)$/iu.test(lower)) {
        state.websiteLinkSent = true;
        state.nextStep = 'website';
        this.persist(chatId);
        return { handled: true, response: this.websiteContinuationMessage(state.language, 'selling'), action: 'review' };
      }
      if (/^(?:contact me|ask sharh to contact me|call me|request a call|speak to someone|human|свяжитесь со мной|позвоните мне|живой человек|تواصلوا معي|اتصلوا بي)$/iu.test(lower)) {
        state.pendingSubmitRequest = true;
        state.nextStep = undefined;
        state.qualificationNoticeSent = false;
        this.persist(chatId);
        const directive = this.getDirective(chatId);
        return { handled: true, response: directive.directResponse, continueFunnel: true, action: 'review' };
      }
    }

    if (state.status === 'qualified' && state.inquiryPurpose === 'buying') {
      if (/^(?:4|contact me|ask sharh to contact me|request a call|call me|свяжитесь со мной|позвоните мне|تواصلوا معي|اتصلوا بي)$/iu.test(lower)) {
        state.pendingContactRequest = true;
        state.nextStep = 'contact';
        state.qualificationNoticeSent = false;
        this.persist(chatId);
        const directive = this.getDirective(chatId);
        return { handled: true, response: directive.directResponse, continueFunnel: true, action: 'review' };
      }
      if (/^(?:5|refine|refine search|change search|уточнить поиск|изменить поиск|تحسين البحث|تعديل البحث)$/iu.test(lower)) {
        state.status = 'contacted';
        state.expectedField = 'business_type';
        state.qualificationNoticeSent = false;
        state.lastInputIssue = undefined;
        this.persist(chatId);
        const prompts: Record<ConversationLanguage, string> = {
          en: 'Send the updated business type, location, or budget in one message. I will keep anything you do not change.',
          ru: 'Отправьте обновлённую сферу, локацию или бюджет одним сообщением. Всё, что вы не меняете, останется сохранённым.',
          ar: 'أرسل نوع المشروع أو الموقع أو الميزانية المعدلة في رسالة واحدة. سأحتفظ بأي معلومات لا تغيّرها.',
        };
        return { handled: true, response: prompts[state.language], continueFunnel: true, action: 'change' };
      }
      if (/^(?:6|save search|save this search|notify me|сохранить поиск|уведомить меня|حفظ البحث|أبلغني)$/iu.test(lower)) {
        state.submittedForReview = true;
        state.nextStep = 'submit';
        this.persist(chatId);
        return { handled: true, response: this.buyerSearchSavedMessage(state.language), action: 'review' };
      }
      if (/^(?:7|website|open marketplace|continue on website|перейти на сайт|открыть маркетплейс|الموقع|افتح السوق)$/iu.test(lower)) {
        state.websiteLinkSent = true;
        state.nextStep = 'website';
        this.persist(chatId);
        return { handled: true, response: this.websiteContinuationMessage(state.language, 'buying'), action: 'review' };
      }
    }

    if (/^(?:review|review answers|review my answers|summary|show my answers|проверить ответы|покажи ответы|сводка|مراجعة|راجع إجاباتي|ملخص)$/iu.test(lower)) {
      return {
        handled: true,
        response: this.buildReviewMessage(state),
        action: 'review',
      };
    }

    if (/^(?:back|go back|go one step back|previous|назад|вернуться|الرجوع|السابق)$/iu.test(lower)) {
      return this.goBack(chatId, state);
    }

    const switchPurpose = this.detectPurposeSwitch(lower);
    if (switchPurpose) {
      this.switchPurpose(state, switchPurpose);
      this.persist(chatId);
      const directive = this.getDirective(chatId);
      return {
        handled: true,
        response: this.navigationPrefix(state.language, switchPurpose === 'buying' ? 'switched_buying' : 'switched_selling', directive.directResponse),
        continueFunnel: true,
        action: 'switch',
      };
    }

    const directChangeMatch = content.match(
      /^(?:change|edit|update|correct|изменить|исправить|поменять|تغيير|تعديل)\s+(?:my\s+)?(.+?)\s+(?:to|=|на|إلى)\s+(.+)$/iu
    );
    if (directChangeMatch?.[1] && directChangeMatch[2]) {
      let field = this.resolveFieldAlias(directChangeMatch[1]);
      if (field === 'business_location' && state.inquiryPurpose === 'buying') {
        field = 'buyer_location';
      }
      if (field) {
        const fieldsUpdated: string[] = [];
        const accepted = this.applyValidatedField(
          state,
          field,
          directChangeMatch[2],
          true,
          fieldsUpdated
        );
        if (!accepted) {
          return this.changeField(chatId, state, field);
        }
        state.status = this.hasRequiredLeadFields(state) ? 'qualified' : 'contacted';
        state.qualificationNoticeSent = false;
        state.lastInputIssue = undefined;
        state.pendingConfirmation = undefined;
        this.recalculateStage(state);
        this.persist(chatId);
        const directive = this.getDirective(chatId);
        return {
          handled: true,
          response: this.navigationPrefix(
            state.language,
            'answer_updated',
            directive.directResponse
          ),
          continueFunnel: true,
          action: 'change',
        };
      }
    }

    const changeMatch = lower.match(/^(?:change|edit|update|correct|изменить|исправить|поменять|تغيير|تعديل)\s+(?:my\s+)?(.+?)$/iu);
    if (changeMatch?.[1] && !/\b(?:to|into|на|в|إلى)\b/iu.test(changeMatch[1])) {
      let field = this.resolveFieldAlias(changeMatch[1]);
      if (field === 'business_location' && state.inquiryPurpose === 'buying') {
        field = 'buyer_location';
      }
      if (field) {
        return this.changeField(chatId, state, field);
      }
      return {
        handled: true,
        response: this.buildChangeHelp(state),
        action: 'change',
      };
    }

    if (/^(?:change|change my answer|edit answer|correct answer|изменить ответ|исправить ответ|تغيير الإجابة|تعديل الإجابة)$/iu.test(lower)) {
      return {
        handled: true,
        response: this.buildChangeHelp(state),
        action: 'change',
      };
    }

    if (/^(?:help|commands|options|помощь|команды|الخيارات|مساعدة)$/iu.test(lower)) {
      return {
        handled: true,
        response: this.navigationMessage(state.language, 'help'),
        action: 'help',
      };
    }

    return { handled: false };
  }

  private goBack(chatId: string, state: LeadCaptureState): NavigationResult {
    const sequence: LeadField[] = state.inquiryPurpose === 'buying'
      ? ['inquiry_purpose', 'client_name', ...BUYER_REQUIRED_FIELDS.map(key => this.stateKeyToField(key)).filter((field): field is LeadField => Boolean(field))]
      : ['inquiry_purpose', 'client_name', 'seller_terms', ...SELLER_REQUIRED_FIELDS.map(key => this.stateKeyToField(key)).filter((field): field is LeadField => Boolean(field))];
    const current = state.expectedField;
    let start = current ? sequence.indexOf(current) - 1 : sequence.length - 1;
    if (start < 0) start = sequence.length - 1;
    let target: LeadField | undefined;
    for (let index = start; index >= 0; index -= 1) {
      const candidate = sequence[index];
      if (candidate && this.fieldHasCapturedValue(state, candidate)) {
        target = candidate;
        break;
      }
    }
    if (!target) {
      return {
        handled: true,
        response: this.navigationMessage(state.language, 'nothing_to_go_back'),
        action: 'back',
      };
    }
    this.clearField(state, target);
    state.expectedField = target;
    state.status = 'contacted';
    state.qualificationNoticeSent = false;
    state.lastInputIssue = undefined;
    state.pendingConfirmation = undefined;
    this.recalculateStage(state);
    this.persist(chatId);
    const directive = this.getDirective(chatId);
    return {
      handled: true,
      response: this.navigationPrefix(state.language, 'going_back', directive.directResponse),
      continueFunnel: true,
      action: 'back',
    };
  }

  private changeField(chatId: string, state: LeadCaptureState, field: LeadField): NavigationResult {
    this.clearField(state, field);
    state.expectedField = field;
    state.status = 'contacted';
    state.qualificationNoticeSent = false;
    state.lastInputIssue = undefined;
    state.pendingConfirmation = undefined;
    this.recalculateStage(state);
    this.persist(chatId);
    const directive = this.getDirective(chatId);
    return {
      handled: true,
      response: this.navigationPrefix(state.language, 'change_field', directive.directResponse),
      continueFunnel: true,
      action: 'change',
    };
  }

  private switchPurpose(state: LeadCaptureState, purpose: LeadInquiryPurpose): void {
    state.inquiryPurpose = purpose;
    state.status = 'contacted';
    state.stage = state.clientName ? 'identity_collected' : 'intent_identified';
    state.qualificationNoticeSent = false;
    state.expectedField = undefined;
    state.lastInputIssue = undefined;
    state.pendingConfirmation = undefined;
    state.pendingObjection = undefined;
    state.termsPresented = false;
    state.termsAccepted = undefined;
    for (const key of SELLER_PROFILE_FIELDS) Reflect.deleteProperty(state, key);
    for (const key of BUYER_PROFILE_FIELDS) Reflect.deleteProperty(state, key);
    for (const key of BUYER_CRITERIA_FIELDS) Reflect.deleteProperty(state, key);
    state.contactPreference = undefined;
    state.nextStep = undefined;
    state.optionalDetailsMode = false;
    state.pendingContactRequest = false;
    state.pendingSubmitRequest = false;
    state.submittedForReview = false;
    state.websiteLinkSent = false;
    state.continueLater = false;
  }

  private detectPurposeSwitch(content: string): LeadInquiryPurpose | null {
    if (/^(?:switch|change|move)\s+(?:me\s+)?to\s+(?:buy|buying|buyer)|^(?:i want to buy instead)|^(?:переключить|перейти)\s+на\s+покупку|^(?:хочу покупать)|(?:التحويل إلى الشراء|أريد الشراء بدلاً)/iu.test(content)) return 'buying';
    if (/^(?:switch|change|move)\s+(?:me\s+)?to\s+(?:sell|selling|seller)|^(?:i want to sell instead)|^(?:переключить|перейти)\s+на\s+продажу|^(?:хочу продавать)|(?:التحويل إلى البيع|أريد البيع بدلاً)/iu.test(content)) return 'selling';
    return null;
  }

  private resolveFieldAlias(value: string): LeadField | null {
    const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const aliases: Array<[LeadField, RegExp]> = [
      ['inquiry_purpose', /^(?:purpose|buy or sell|intent|цель|покупка или продажа|الهدف)$/iu],
      ['client_name', /^(?:name|my name|имя|моё имя|الاسم)$/iu],
      ['seller_terms', /^(?:terms|agreement|fee|commission|условия|комиссия|الشروط|الرسوم)$/iu],
      ['business_type', /^(?:business|business type|sector|industry|сфера|тип бизнеса|قطاع|نوع المشروع)$/iu],
      ['business_location', /^(?:business location|location|emirate|area|местоположение|эмират|район|موقع المشروع|الإمارة|المنطقة)$/iu],
      ['annual_revenue_aed', /^(?:revenue|annual revenue|turnover|выручка|годовая выручка|الإيرادات)$/iu],
      ['lease_details', /^(?:lease|rent|premises|аренда|помещение|الإيجار|الموقع)$/iu],
      ['desired_selling_price_aed', /^(?:price|selling price|asking price|цена|цена продажи|سعر البيع|السعر)$/iu],
      ['year_established', /^(?:year|established|founded|год|год основания|سنة التأسيس)$/iu],
      ['employee_count', /^(?:employees|staff|team|сотрудники|персонал|الموظفون)$/iu],
      ['monthly_operating_expenses_aed', /^(?:expenses|operating expenses|costs|расходы|операционные расходы|المصاريف)$/iu],
      ['monthly_net_profit_aed', /^(?:profit|net profit|прибыль|чистая прибыль|صافي الربح)$/iu],
      ['liabilities', /^(?:liabilities|debts|debt|долги|обязательства|الديون|الالتزامات)$/iu],
      ['contracts_licenses', /^(?:contracts|licenses|licences|договоры|лицензии|العقود|التراخيص)$/iu],
      ['sale_reason_urgency', /^(?:reason|reason for sale|timing|urgency|причина|сроки|سبب البيع|المدة)$/iu],
      ['included_assets', /^(?:assets|included|equipment|активы|что входит|الأصول|المعدات)$/iu],
      ['buyer_budget_aed', /^(?:budget|buyer budget|бюджет|ميزانية)$/iu],
      ['buyer_location', /^(?:preferred location|buyer location|preferred emirate|локация покупки|эмират покупки|الموقع المفضل)$/iu],
      ['buyer_timeline', /^(?:timeline|purchase timing|срок покупки|موعد الشراء)$/iu],
      ['buyer_involvement', /^(?:involvement|role|participation|участие|роль|المشاركة)$/iu],
      ['buyer_funding_status', /^(?:funding|finance|financing|финансирование|تمويل)$/iu],
      ['buyer_additional_comments', /^(?:requirements|comments|other requirements|требования|комментарии|متطلبات|ملاحظات)$/iu],
      ['contact_preference', /^(?:contact|contact preference|call time|best time|callback|связь|время звонка|удобное время|التواصل|وقت الاتصال)$/iu],
    ];
    return aliases.find(([, pattern]) => pattern.test(normalized))?.[0] || null;
  }

  private stateKeyToField(key: keyof LeadCaptureState): LeadField | undefined {
    return (Object.entries(FIELD_TO_STATE_KEY) as Array<[LeadField, keyof LeadCaptureState]>).find(([, value]) => value === key)?.[0];
  }

  private fieldHasCapturedValue(state: LeadCaptureState, field: LeadField): boolean {
    if (field === 'seller_terms') return state.termsAccepted !== undefined;
    if (field === 'inquiry_purpose') return Boolean(state.inquiryPurpose);
    const key = FIELD_TO_STATE_KEY[field];
    return Boolean(key && this.hasValue(state[key]));
  }

  private clearField(state: LeadCaptureState, field: LeadField): void {
    if (field === 'seller_terms') {
      state.termsAccepted = undefined;
      state.termsPresented = true;
      return;
    }
    if (field === 'inquiry_purpose') {
      state.inquiryPurpose = undefined;
      this.switchPurpose(state, 'selling');
      state.inquiryPurpose = undefined;
      state.stage = 'new';
      return;
    }
    const key = FIELD_TO_STATE_KEY[field];
    if (key) Reflect.deleteProperty(state, key);
  }

  private buildReviewMessage(state: LeadCaptureState): string {
    const rows: string[] = [];
    const add = (label: string, value?: string): void => {
      if (value) rows.push(`${rows.length + 1}. ${label}: ${value}`);
    };
    if (state.language === 'ru') {
      add('Цель', state.inquiryPurpose === 'buying' ? 'Покупка' : state.inquiryPurpose === 'selling' ? 'Продажа' : undefined);
      add('Имя', state.clientName);
      add('Сфера', state.businessType);
      add('Локация', state.businessLocation || state.buyerLocation);
      add('Выручка', state.annualRevenueAed);
      add('Цена / бюджет', state.desiredSellingPriceAed || state.buyerBudgetAed);
      add('Прибыль', state.monthlyNetProfitAed);
      add('Срок', state.buyerTimeline || state.saleReasonUrgency);
      return `Текущие ответы:\n${rows.length ? rows.join('\n') : 'Пока ничего не сохранено.'}\n\nНапишите, например, «изменить выручку», «назад» или «начать заново».`;
    }
    if (state.language === 'ar') {
      add('الهدف', state.inquiryPurpose === 'buying' ? 'شراء' : state.inquiryPurpose === 'selling' ? 'بيع' : undefined);
      add('الاسم', state.clientName);
      add('القطاع', state.businessType);
      add('الموقع', state.businessLocation || state.buyerLocation);
      add('الإيرادات', state.annualRevenueAed);
      add('السعر / الميزانية', state.desiredSellingPriceAed || state.buyerBudgetAed);
      add('الربح', state.monthlyNetProfitAed);
      add('المدة', state.buyerTimeline || state.saleReasonUrgency);
      return `إجاباتك الحالية:\n${rows.length ? rows.join('\n') : 'لم يتم حفظ أي إجابات بعد.'}\n\nاكتب مثلاً «تغيير الإيرادات» أو «الرجوع» أو «ابدأ من جديد».`;
    }
    add('Purpose', state.inquiryPurpose);
    add('Name', state.clientName);
    add('Business / sector', state.businessType);
    add('Location', state.businessLocation || state.buyerLocation);
    add('Revenue', state.annualRevenueAed);
    add('Price / budget', state.desiredSellingPriceAed || state.buyerBudgetAed);
    add('Profit', state.monthlyNetProfitAed);
    add('Timeline', state.buyerTimeline || state.saleReasonUrgency);
    return `Your current answers:\n${rows.length ? rows.join('\n') : 'Nothing has been saved yet.'}\n\nYou can say “change revenue”, “back”, or “new request”.`;
  }

  private buildChangeHelp(state: LeadCaptureState): string {
    const review = this.buildReviewMessage(state);
    const suffix: Record<ConversationLanguage, string> = {
      en: 'Tell me which item to change, for example “change location” or “change budget”.',
      ru: 'Напишите, что изменить, например «изменить локацию» или «изменить бюджет».',
      ar: 'اكتب المعلومة التي تريد تغييرها، مثل «تغيير الموقع» أو «تغيير الميزانية».',
    };
    return `${review}\n\n${suffix[state.language]}`;
  }

  private navigationPrefix(language: ConversationLanguage, key: 'restart_done' | 'resumed' | 'going_back' | 'change_field' | 'answer_updated' | 'switched_buying' | 'switched_selling', next?: string): string {
    const prefixes: Record<ConversationLanguage, Record<string, string>> = {
      en: {
        restart_done: 'Started over.',
        resumed: 'Continuing from where we stopped.',
        going_back: 'Going back to the previous answer.',
        change_field: 'No problem. Let’s update that answer.',
        answer_updated: 'Updated.',
        switched_buying: 'I have switched this request to buying.',
        switched_selling: 'I have switched this request to selling.',
      },
      ru: {
        restart_done: 'Начинаем заново.',
        resumed: 'Продолжаем с места остановки.',
        going_back: 'Возвращаемся к предыдущему ответу.',
        change_field: 'Хорошо. Обновим этот ответ.',
        answer_updated: 'Ответ обновлён.',
        switched_buying: 'Запрос переключён на покупку.',
        switched_selling: 'Запрос переключён на продажу.',
      },
      ar: {
        restart_done: 'بدأنا من جديد.',
        resumed: 'سنكمل من حيث توقفنا.',
        going_back: 'سنعود إلى الإجابة السابقة.',
        change_field: 'حسناً. سنحدّث هذه الإجابة.',
        answer_updated: 'تم تحديث الإجابة.',
        switched_buying: 'تم تحويل الطلب إلى الشراء.',
        switched_selling: 'تم تحويل الطلب إلى البيع.',
      },
    };
    return [prefixes[language][key], next].filter(Boolean).join('\n\n');
  }

  private navigationMessage(language: ConversationLanguage, key: 'restart_confirm' | 'restart_cancelled' | 'paused' | 'still_paused' | 'nothing_to_go_back' | 'help'): string {
    const messages: Record<ConversationLanguage, Record<string, string>> = {
      en: {
        restart_confirm: 'Starting over will clear the active answers in this chat, while the conversation history remains recorded. Should I start over?',
        restart_cancelled: 'Start-over cancelled. Your current answers are unchanged.',
        paused: 'Paused. Your progress is saved. Reply “resume” whenever you want to continue.',
        still_paused: 'This request is paused. Reply “resume” or “review”.',
        nothing_to_go_back: 'There is no earlier completed answer to return to. You can review your answers or continue.',
        help: 'Available controls: back, change [answer], review, new request, switch to buying/selling, pause, and resume.',
      },
      ru: {
        restart_confirm: 'Начать заново означает очистить активные ответы в этом чате, при этом история переписки сохранится. Начать заново?',
        restart_cancelled: 'Перезапуск отменён. Текущие ответы не изменены.',
        paused: 'Процесс приостановлен, прогресс сохранён. Напишите «продолжить», когда будете готовы.',
        still_paused: 'Запрос приостановлен. Напишите «продолжить», «проверить ответы» или «начать заново».',
        nothing_to_go_back: 'Предыдущего заполненного ответа пока нет. Можно проверить ответы или продолжить.',
        help: 'Команды: назад, изменить [ответ], проверить ответы, начать заново, переключить на покупку/продажу, пауза и продолжить.',
      },
      ar: {
        restart_confirm: 'البدء من جديد سيمسح الإجابات النشطة في هذه المحادثة مع الاحتفاظ بسجل الرسائل. هل أبدأ من جديد؟',
        restart_cancelled: 'تم إلغاء البدء من جديد، ولم تتغير إجاباتك الحالية.',
        paused: 'تم إيقاف الطلب مؤقتاً وحفظ تقدمك. اكتب «تابع» عندما تريد المتابعة.',
        still_paused: 'الطلب متوقف مؤقتاً. اكتب «تابع» أو «مراجعة» أو «ابدأ من جديد».',
        nothing_to_go_back: 'لا توجد إجابة مكتملة سابقة للرجوع إليها. يمكنك مراجعة الإجابات أو المتابعة.',
        help: 'الأوامر المتاحة: الرجوع، تغيير [إجابة]، مراجعة، طلب جديد، التحويل إلى شراء/بيع، توقف، وتابع.',
      },
    };
    return messages[language][key] || messages.en[key] || '';
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
      promptRepeatCount: 0,
      invalidAttempts: {},
      priceGuidanceCount: 0,
      optionalDetailsMode: false,
      pendingContactRequest: false,
      pendingSubmitRequest: false,
      submittedForReview: false,
      websiteLinkSent: false,
      continueLater: false,
      paused: false,
      pendingRestartConfirmation: false,
      awaitingReentryChoice: false,
      reentryPromptCount: 0,
      activeCaseStartedAt: Date.now(),
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

  getExpectedField(chatId: string): LeadField | undefined {
    return this.leadStates.get(chatId)?.expectedField;
  }

  getLanguage(chatId: string): ConversationLanguage {
    return this.leadStates.get(chatId)?.language || 'en';
  }

  private applyIntelligentInterpretation(
    state: LeadCaptureState,
    interpretation: SalesMessageInterpretation,
    fieldsUpdated: string[]
  ): number {
    let accepted = 0;

    if (interpretation.classification === 'unknown') {
      const fields = interpretation.unknownFields.length
        ? interpretation.unknownFields
        : state.expectedField
          ? [state.expectedField]
          : [];
      for (const field of fields) {
        if (this.applyValidatedField(state, field, 'Unknown / to confirm', true, fieldsUpdated)) {
          accepted += 1;
        }
      }
      return accepted;
    }

    for (const field of interpretation.unknownFields) {
      if (this.applyValidatedField(state, field, 'Unknown / to confirm', true, fieldsUpdated)) {
        accepted += 1;
      }
    }

    for (const [rawField, rawValue] of Object.entries(interpretation.fields)) {
      if (!rawValue) continue;
      const field = rawField as LeadField;
      const overwrite =
        interpretation.classification === 'correction' ||
        interpretation.corrections.includes(field);
      if (this.applyValidatedField(state, field, rawValue, overwrite, fieldsUpdated)) {
        accepted += 1;
      }
    }

    if (
      accepted === 0 &&
      ['nonsense', 'off_topic', 'abusive'].includes(interpretation.classification)
    ) {
      state.lastInputIssue = interpretation.reason || interpretation.classification;
    }

    return accepted;
  }

  private applyValidatedField(
    state: LeadCaptureState,
    field: LeadField,
    rawValue: string,
    overwrite: boolean,
    fieldsUpdated: string[]
  ): boolean {
    const key = FIELD_TO_STATE_KEY[field];
    if (!key || key === 'termsAccepted' || key === 'inquiryPurpose') {
      if (field === 'seller_terms') {
        const accepted = this.extractAcceptance(rawValue);
        if (accepted === null) return false;
        if (overwrite || state.termsAccepted === undefined) {
          state.termsAccepted = accepted;
          fieldsUpdated.push('terms_accepted');
          state.expectedField = undefined;
          state.lastInputIssue = undefined;
          return true;
        }
      }
      if (field === 'inquiry_purpose') {
        const purpose = this.extractInquiryPurpose(rawValue);
        if (!purpose) return false;
        if (overwrite || !state.inquiryPurpose) {
          state.inquiryPurpose = purpose;
          fieldsUpdated.push('inquiry_purpose');
          state.expectedField = undefined;
          state.lastInputIssue = undefined;
          return true;
        }
      }
      return false;
    }

    const normalized = this.normalizeInterpretedValue(field, rawValue);
    if (!normalized) return false;

    const contradiction = this.findContradiction(state, field, normalized);
    if (contradiction) {
      state.pendingConfirmation = {
        field,
        value: normalized,
        reason: contradiction,
      };
      state.expectedField = field;
      state.lastInputIssue = undefined;
      return false;
    }

    if (!overwrite && this.hasValue(state[key])) return false;
    (state as unknown as Record<string, unknown>)[key] = normalized;
    fieldsUpdated.push(field);
    if (state.expectedField === field) state.expectedField = undefined;
    if (state.pendingConfirmation?.field === field) {
      state.pendingConfirmation = undefined;
    }
    state.invalidAttempts[field] = 0;
    state.lastInputIssue = undefined;
    return true;
  }

  private normalizeInterpretedValue(
    field: LeadField,
    rawValue: string
  ): string | null {
    if (this.isExplicitUnknown(rawValue) || rawValue === 'Unknown / to confirm') {
      return 'Unknown / to confirm';
    }

    switch (field) {
      case 'client_name':
        return this.extractClientName(rawValue, true);
      case 'business_type':
        return this.isMeaningfulFreeText(rawValue)
          ? this.extractBusinessType(rawValue, true)
          : null;
      case 'business_location':
      case 'buyer_location':
        return this.isMeaningfulFreeText(rawValue)
          ? this.extractLocation(rawValue, true)
          : null;
      case 'annual_revenue_aed':
      case 'desired_selling_price_aed':
      case 'buyer_budget_aed':
      case 'monthly_operating_expenses_aed':
      case 'monthly_net_profit_aed': {
        const money = this.extractMoneyExpression(rawValue);
        const amount = money ? this.parseAedAmount(money) : null;
        if (!money || amount === null || amount <= 0 || amount > 1_000_000_000_000) {
          return null;
        }
        return money;
      }
      case 'year_established': {
        const year = this.extractYearEstablished(rawValue, true);
        if (!year || year === 'Unknown / to confirm') return year;
        const parsed = Number(year);
        const currentYear = new Date().getUTCFullYear();
        return parsed >= 1900 && parsed <= currentYear ? year : null;
      }
      case 'employee_count': {
        const count = this.extractEmployeeCount(rawValue, true);
        if (!count || count === 'Unknown / to confirm') return count;
        const parsed = Number(count);
        return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000
          ? String(parsed)
          : null;
      }
      case 'lease_details':
      case 'liabilities':
      case 'contracts_licenses':
      case 'sale_reason_urgency':
      case 'included_assets':
      case 'buyer_timeline':
      case 'buyer_involvement':
      case 'buyer_funding_status':
      case 'buyer_additional_comments':
      case 'contact_preference':
        return this.isMeaningfulFreeText(rawValue)
          ? this.cleanFreeTextAnswer(rawValue)
          : null;
      case 'inquiry_purpose':
      case 'seller_terms':
        return null;
      default:
        return null;
    }
  }

  private findContradiction(
    state: LeadCaptureState,
    field: LeadField,
    value: string
  ): string | null {
    if (value === 'Unknown / to confirm') return null;
    const newAmount = this.parseAedAmount(value);
    if (newAmount === null) return null;

    const revenue =
      field === 'annual_revenue_aed'
        ? newAmount
        : this.parseAedAmount(state.annualRevenueAed || '');
    const monthlyProfit =
      field === 'monthly_net_profit_aed'
        ? newAmount
        : this.parseAedAmount(state.monthlyNetProfitAed || '');

    if (
      revenue !== null &&
      monthlyProfit !== null &&
      monthlyProfit * 12 > revenue * 1.2
    ) {
      return 'The stated monthly net profit is higher than the annual revenue would normally support.';
    }
    return null;
  }

  private applyPendingConfirmation(
    state: LeadCaptureState,
    content: string,
    fieldsUpdated: string[]
  ): boolean {
    const pending = state.pendingConfirmation;
    if (!pending) return false;
    const acceptance = this.extractAcceptance(content);
    if (acceptance === true) {
      const key = FIELD_TO_STATE_KEY[pending.field];
      (state as unknown as Record<string, unknown>)[key] = pending.value;
      fieldsUpdated.push(pending.field);
      state.pendingConfirmation = undefined;
      state.expectedField = undefined;
      state.invalidAttempts[pending.field] = 0;
      return true;
    }
    if (acceptance === false) {
      const key = FIELD_TO_STATE_KEY[pending.field];
      if ((state as unknown as Record<string, unknown>)[key] === pending.value) {
        (state as unknown as Record<string, unknown>)[key] = undefined;
      }
      state.pendingConfirmation = undefined;
      state.expectedField = pending.field;
      this.registerInvalidAttempt(
        state,
        pending.field,
        'The client rejected the contradictory value.'
      );
      return true;
    }
    if (this.isExplicitUnknown(content)) {
      const key = FIELD_TO_STATE_KEY[pending.field];
      (state as unknown as Record<string, unknown>)[key] = 'Unknown / to confirm';
      fieldsUpdated.push(pending.field);
      state.pendingConfirmation = undefined;
      state.expectedField = undefined;
      return true;
    }
    return false;
  }

  private registerInvalidAttempt(
    state: LeadCaptureState,
    field: LeadField,
    reason: string
  ): void {
    state.invalidAttempts[field] = (state.invalidAttempts[field] || 0) + 1;
    state.lastInputIssue = reason;
    state.lastInputClassification = state.lastInputClassification || 'nonsense';
  }

  private parseAedAmount(value: string): number | null {
    if (!value || /unknown/i.test(value)) return null;
    const rangeParts = value.match(/([\d,]+)(?:\s*[–-]\s*([\d,]+))?/);
    if (!rangeParts?.[1]) return null;
    const first = Number(rangeParts[1].replace(/,/g, ''));
    const second = rangeParts[2]
      ? Number(rangeParts[2].replace(/,/g, ''))
      : null;
    if (!Number.isFinite(first)) return null;
    if (second !== null && Number.isFinite(second)) return (first + second) / 2;
    return first;
  }

  private isMeaningfulFreeText(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 2 || normalized.length > 1000) return false;
    if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
    if (/^(.)\1{2,}$/u.test(normalized.replace(/\s/g, ''))) return false;
    if (/^(?:asdf|qwerty|zxcv|blah|bla|banana|bazilion|bazillion|nonsense|random|test|lol|lmao)$/i.test(normalized)) {
      return false;
    }
    const letters = normalized.match(/\p{L}/gu)?.length || 0;
    return letters >= 2 || /\d/.test(normalized);
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

    if (state.inquiryPurpose === 'selling') {
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
        /asking(?: price)?|selling price|sell for|desired price|expected price|valuation|price/i,
        /цена продаж|хочу получить|ожидаемая цена|оценк|стоимост/i,
        /سعر البيع|السعر المطلوب|التقييم/i,
      ]);
      this.setIfMissing(
        state,
        'desiredSellingPriceAed',
        askingPrice,
        'desired_selling_price_aed',
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
    } else if (state.inquiryPurpose === 'buying') {
      const buyerBudget = this.extractMoneyByHints(content, [
        /budget|invest(?:ment)? amount|under|up to|maximum|max(?:imum)?|not more than|below/i,
        /бюджет|сумма инвестиц|до|не более|максимум/i,
        /الميزانية|مبلغ الاستثمار|أقل من|حتى|الحد الأقصى/i,
      ]);
      this.setIfMissing(
        state,
        'buyerBudgetAed',
        buyerBudget,
        'buyer_budget_aed',
        fieldsUpdated
      );
    }

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

    if (
      expected === 'desired_selling_price_aed' &&
      state.suggestedSellingPriceAed &&
      /^(?:yes|use (?:it|that|this)|use the range|that works|ok|okay|да|используйте|подходит|نعم|استخدمه)$/iu.test(content.trim())
    ) {
      (state as unknown as Record<string, unknown>)[stateKey] =
        state.suggestedSellingPriceAed;
      fieldsUpdated.push(expected);
      state.expectedField = undefined;
      return;
    }

    const choiceValue = this.extractChoiceValue(expected, content, state);
    if (choiceValue) {
      (state as unknown as Record<string, unknown>)[stateKey] = choiceValue;
      fieldsUpdated.push(expected);
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

  private extractChoiceValue(
    field: LeadField,
    content: string,
    state: LeadCaptureState
  ): string | null {
    const choice = content.trim().toLowerCase();

    if (field === 'business_location' || field === 'buyer_location') {
      const emirates: Record<string, string> = {
        '1': 'Dubai',
        '2': 'Abu Dhabi',
        '3': 'Sharjah',
        '4': 'Ajman',
        '5': 'Ras Al Khaimah',
        '6': 'Fujairah',
        '7': 'Umm Al Quwain',
      };
      return emirates[choice] || null;
    }

    if (field === 'desired_selling_price_aed') {
      if (choice === '1' && state.suggestedSellingPriceAed) {
        return state.suggestedSellingPriceAed;
      }
      if (choice === '2' && state.suggestedSellingPriceAed) {
        state.suggestedSellingPriceAed = undefined;
        return null;
      }
      if (choice === '3' && state.suggestedSellingPriceAed) {
        return 'Unknown / to confirm';
      }
      const ranges: Record<string, string> = {
        '1': 'Under AED 250,000',
        '2': 'AED 250,000–500,000',
        '3': 'AED 500,000–1,000,000',
        '4': 'AED 1,000,000–3,000,000',
        '5': 'AED 3,000,000+',
      };
      return ranges[choice] || null;
    }

    if (field === 'buyer_budget_aed') {
      const ranges: Record<string, string> = {
        '1': 'Under AED 250,000',
        '2': 'AED 250,000–500,000',
        '3': 'AED 500,000–1,000,000',
        '4': 'AED 1,000,000–3,000,000',
        '5': 'AED 3,000,000+',
      };
      return ranges[choice] || null;
    }

    if (field === 'buyer_timeline') {
      return ({
        '1': 'Within 3 months',
        '2': 'Within 3–6 months',
        '3': 'Within 6–12 months',
        '4': 'Flexible / exploring',
      } as Record<string, string>)[choice] || null;
    }

    if (field === 'buyer_involvement') {
      return ({
        '1': 'Operate the business personally',
        '2': 'Passive investment',
        '3': 'Open to either',
      } as Record<string, string>)[choice] || null;
    }

    if (field === 'buyer_funding_status') {
      return ({
        '1': 'Funds available now',
        '2': 'Financing required',
        '3': 'Combination of own funds and financing',
      } as Record<string, string>)[choice] || null;
    }

    return null;
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
      case 'contact_preference':
        return this.isMeaningfulFreeText(content)
          ? this.cleanFreeTextAnswer(content)
          : null;
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
    if (!state.clientPhone || !state.inquiryPurpose) {
      return false;
    }

    if (state.inquiryPurpose === 'selling') {
      return Boolean(
        state.termsAccepted === true &&
        this.hasValue(state.businessType) &&
        this.hasValue(state.businessLocation) &&
        this.hasValue(state.desiredSellingPriceAed)
      );
    }

    if (this.hasValue(state.specificListingCode)) {
      return true;
    }
    return Boolean(
      this.hasValue(state.businessType) &&
      this.hasValue(state.buyerBudgetAed)
    );
  }

  private nextMissingSellerField(state: LeadCaptureState): LeadField | null {
    if (!this.hasValue(state.businessType)) return 'business_type';
    if (!this.hasValue(state.businessLocation)) return 'business_location';
    if (!this.hasValue(state.desiredSellingPriceAed)) {
      return 'desired_selling_price_aed';
    }
    return null;
  }

  private nextMissingBuyerField(state: LeadCaptureState): LeadField | null {
    if (this.hasValue(state.specificListingCode)) return null;
    if (!this.hasValue(state.businessType)) return 'business_type';
    if (!this.hasValue(state.buyerBudgetAed)) return 'buyer_budget_aed';
    return null;
  }

  private recalculateStage(state: LeadCaptureState): void {
    if (state.status === 'qualified') {
      state.stage = 'ready_for_review';
      return;
    }

    if (state.inquiryPurpose === 'selling' && state.termsAccepted === true) {
      state.stage = 'qualifying';
      return;
    }

    if (state.inquiryPurpose === 'buying') {
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
      buyerMinimumAnnualProfitAed: state.buyerMinimumAnnualProfitAed || '',
      buyerMinimumRoiPct: state.buyerMinimumRoiPct || '',
      buyerReturnPeriod: state.buyerReturnPeriod || '',
      buyerExcludedSectors: state.buyerExcludedSectors || '',
      buyerProfitableOnly: Boolean(state.buyerProfitableOnly),
      contactPreference: state.contactPreference || '',
      nextStep: state.nextStep || '',
      completionPercent: this.calculateCompletionPercent(state),
      nextField: nextDirective.expectedField || '',
      fieldsUpdated: Array.from(new Set(fieldsUpdated)).join(', '),
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
    const base: Array<keyof LeadCaptureState> = ['clientPhone', 'inquiryPurpose'];
    const fields =
      state.inquiryPurpose === 'selling'
        ? [...base, 'termsAccepted' as keyof LeadCaptureState, ...SELLER_PROFILE_FIELDS]
        : state.inquiryPurpose === 'buying'
          ? [...base, ...BUYER_PROFILE_FIELDS]
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
      /\b(?:looking for|seeking|interested in)\s+(?:an?\s+)?(?:(?:cash[- ]?generating|profitable|established|passive|hands[- ]?off|manager[- ]?run)\s+)*(?:business|company|investment opportunity)\b/i.test(
        value
      ) ||
      /\b(?:my|our)\s+budget\s+(?:is|would be|up to|max(?:imum)?(?: is)?)\b/i.test(
        value
      ) ||
      /(купить|покупаю|покупка|покупатель|приобрести|инвестировать|ищу\s+(?:прибыльный|готовый|пассивный)?\s*(?:бизнес|компанию)|мой\s+бюджет)/i.test(
        value
      ) ||
      /(شراء|أشتري|مشتري|استحواذ|استثمار|أبحث\s+عن\s+(?:مشروع|شركة)|ميزانيتي)/i.test(value);

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
    'banana', 'bazilion', 'bazillion', 'asdf', 'qwerty', 'test',
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
    const beforeKnownLocation = value.match(
      /^(.+?)\s+(?:in|located in|based in)\s+(?:Dubai|Abu Dhabi|Sharjah|Ajman|Fujairah|Ras Al Khaimah|RAK|Umm Al Quwain)\b/i
    );
    if (beforeKnownLocation?.[1]) {
      const normalized = this.normalizeBusinessText(beforeKnownLocation[1]);
      if (normalized) return normalized;
    }

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
    if (allowWholeAnswer) {
      const known = this.extractLocation(value, false);
      if (known) return known;
      return this.isMeaningfulFreeText(value)
        ? this.cleanFreeTextAnswer(value)
        : null;
    }

    const emirates = value.match(
      /\b(Dubai|Abu Dhabi|Sharjah|Ajman|Fujairah|Ras Al Khaimah|RAK|Umm Al Quwain)\b/i
    );
    if (emirates?.[0]) {
      const area = value.match(
        /(?:in|located in|based in|area|district|район|в|منطقة|في)\s+([^,.!?]{2,80})/i
      );
      const candidate = (area?.[1] || emirates[0])
        .split(/\b(?:annual|yearly|monthly|revenue|turnover|sales|profit|asking|expected|selling price|budget|under|up to|maximum|max|lease|rent)\b/i)[0]
        ?.trim();
      return this.cleanFreeTextAnswer(candidate || emirates[0]);
    }
    if (/(дубай|абу-?даби|шардж|аджман|фуджейр|рас-?эль-?хайм|умм-?эль-?кувейн)/i.test(value)) {
      const candidate = value
        .split(/(?:годов|ежемесяч|выруч|оборот|прибыл|цена|бюджет|до\s+\d)/i)[0]
        ?.trim();
      return this.cleanFreeTextAnswer(candidate || value);
    }
    if (/(دبي|أبوظبي|الشارقة|عجمان|الفجيرة|رأس الخيمة|أم القيوين)/i.test(value)) {
      const candidate = value
        .split(/(?:سنوي|شهري|الإيراد|المبيعات|الربح|السعر|الميزانية)/u)[0]
        ?.trim();
      return this.cleanFreeTextAnswer(candidate || value);
    }
    return null;
  }

  private applyBuyerCriteriaExtractions(
    state: LeadCaptureState,
    content: string,
    fieldsUpdated: string[]
  ): void {
    const normalized = content.trim();
    const lowered = normalized.toLowerCase();

    const sectorPreference = this.extractBuyerSectorPreference(normalized);
    if (sectorPreference && state.businessType !== sectorPreference) {
      state.businessType = sectorPreference;
      fieldsUpdated.push('business_type');
    } else if (state.businessType && this.isGenericBuyerSector(state.businessType)) {
      if (state.businessType !== 'Any profitable business') {
        state.businessType = 'Any profitable business';
        fieldsUpdated.push('business_type');
      }
    }

    const flexibleBudget = /\b(?:budget is flexible|flexible budget|no fixed budget|open budget)\b/i.test(normalized)
      || /(?:бюджет гибкий|без фиксированного бюджета)/iu.test(normalized)
      || /(?:الميزانية مرنة|لا توجد ميزانية ثابتة)/u.test(normalized);
    const budget = this.extractBuyerBudgetRequirement(normalized);
    if (flexibleBudget) {
      if (state.buyerBudgetAed !== 'Flexible / no fixed maximum') {
        state.buyerBudgetAed = 'Flexible / no fixed maximum';
        fieldsUpdated.push('buyer_budget_aed');
      }
    } else if (budget !== null) {
      const formatted = this.formatAedAmount(budget);
      if (state.buyerBudgetAed !== formatted) {
        state.buyerBudgetAed = formatted;
        fieldsUpdated.push('buyer_budget_aed');
      }
    }

    const buyerLocation = this.extractLocation(normalized, false);
    const locationIntent = /\b(?:prefer|preferred|only|location|emirate|area|located|in)\b/i.test(normalized)
      || /(?:предпоч|только|локац|эмират|район|\bв\b)/iu.test(normalized)
      || /(?:أفضل|فقط|الموقع|الإمارة|المنطقة|في)/u.test(normalized);
    if (
      buyerLocation &&
      locationIntent &&
      state.buyerLocation !== buyerLocation
    ) {
      state.buyerLocation = buyerLocation;
      fieldsUpdated.push('buyer_location');
    }

    const clearProfitRequirement = /\b(?:profit (?:is )?not required|profitability (?:is )?not required|pre[- ]?revenue is acceptable|loss[- ]?making is acceptable)\b/i.test(normalized)
      || /(?:прибыль не обязательна|можно без прибыли|убыточный бизнес допустим)/iu.test(normalized)
      || /(?:الربح غير مطلوب|يمكن أن يكون بدون ربح)/u.test(normalized);
    if (clearProfitRequirement) {
      state.buyerProfitableOnly = false;
      state.buyerMinimumAnnualProfitAed = undefined;
      state.buyerReturnAmountAed = undefined;
      state.buyerReturnPeriod = undefined;
      fieldsUpdated.push(
        'buyer_profitable_only',
        'buyer_minimum_annual_profit_aed',
        'buyer_return_period'
      );
    } else if (
      /\b(?:cash[- ]?generating|profitable|positive cash ?flow|makes? money|earning business)\b/i.test(normalized)
      || /(?:прибыльн|генерир.*денежн|положительн.*денежн.*поток)/iu.test(normalized)
      || /(?:مربح|تدفق نقدي إيجابي|يدر دخلاً)/u.test(normalized)
    ) {
      if (!state.buyerProfitableOnly) {
        state.buyerProfitableOnly = true;
        fieldsUpdated.push('buyer_profitable_only');
      }
    }

    const openToActive = /\b(?:active management is acceptable|active involvement is acceptable|active is (?:fine|ok|acceptable)|passive (?:is )?not required|open to either|either active or passive|either passive or active|can manage (?:it|the business)|willing to manage)\b/i.test(normalized)
      || /(?:можно активное управление|готов управлять|пассивность не обязательна|рассматриваю оба варианта)/iu.test(normalized)
      || /(?:الإدارة النشطة مقبولة|يمكنني إدارة المشروع|الدور السلبي غير مطلوب|منفتح على الخيارين)/u.test(normalized);
    const passivePreferred = /\b(?:prefer(?:red)? passive|passive preferred|ideally passive|preferably passive)\b/i.test(normalized)
      || /(?:предпочтительно пассив|желательно пассив)/iu.test(normalized)
      || /(?:أفضل.*استثمار.*سلبي|يفضل.*دور.*سلبي)/u.test(normalized);
    const passiveRequired = /\b(?:passive|passively|hands[- ]?off|absentee|without (?:me )?managing|manager[- ]?run|fully managed|managed business)\b/i.test(normalized)
      || /(?:пассивн|без моего участия|управляющая команда)/iu.test(normalized)
      || /(?:استثمار سلبي|دون إدارتي|إدارة قائمة)/u.test(normalized);
    const activeRequired = /\b(?:operate|manage|run) (?:it|the business) (?:myself|personally)|active involvement required\b/i.test(normalized)
      || /(?:буду управлять лично|активное участие обязательно)/iu.test(normalized)
      || /(?:سأدير المشروع بنفسي|إدارة شخصية)/u.test(normalized);

    const involvement = openToActive
      ? 'Open to either'
      : passivePreferred
        ? 'Passive preferred'
        : passiveRequired
          ? 'Passive required'
          : activeRequired
            ? 'Operate the business personally'
            : null;
    if (involvement && state.buyerInvolvement !== involvement) {
      state.buyerInvolvement = involvement;
      fieldsUpdated.push('buyer_involvement');
    }

    const roiMatch = normalized.match(
      /(?:minimum|min|at least|over|more than|target|не менее|минимум)?\s*(\d+(?:[.,]\d+)?)\s*%\s*(?:roi|return|yield|доходност|окупаемост)|(?:roi|return|yield|доходност|окупаемост)\D{0,20}(\d+(?:[.,]\d+)?)\s*%/iu
    );
    const roiRaw = roiMatch?.[1] || roiMatch?.[2];
    if (roiRaw) {
      const roi = Number.parseFloat(roiRaw.replace(',', '.'));
      if (Number.isFinite(roi) && roi >= 0 && roi <= 1000) {
        const formatted = `${roi}%`;
        if (state.buyerMinimumRoiPct !== formatted) {
          state.buyerMinimumRoiPct = formatted;
          fieldsUpdated.push('buyer_minimum_roi_pct');
        }
      }
    }

    const periodClarification = normalized.match(
      /^(?:it is |that is |i mean |make it |это |имею в виду )?(annual|annually|yearly|per year|a year|monthly|per month|a month|годовая|годовой|в год|ежемесячная|ежемесячный|в месяц)(?=\s|[.,;!?]|$)/iu
    )?.[1]?.toLowerCase();
    if (
      periodClarification &&
      state.buyerReturnAmountAed &&
      state.buyerReturnPeriod === 'ambiguous'
    ) {
      const amount = this.parseAedAmount(state.buyerReturnAmountAed);
      if (amount !== null) {
        const monthly = /month|месяц/u.test(periodClarification);
        state.buyerReturnPeriod = monthly ? 'monthly' : 'annual';
        state.buyerMinimumAnnualProfitAed = this.formatAedAmount(
          monthly ? amount * 12 : amount
        );
        state.buyerProfitableOnly = true;
        fieldsUpdated.push(
          'buyer_return_period',
          'buyer_minimum_annual_profit_aed',
          'buyer_profitable_only'
        );
      }
    } else if (!clearProfitRequirement) {
      const requirement = this.extractBuyerReturnRequirement(normalized);
      if (requirement) {
        let period = requirement.period;
        const isCorrection = /\b(?:change|update|instead|make it|actually|now)\b/i.test(normalized)
          || /(?:измен|вместо|теперь|исправ)/iu.test(normalized)
          || /(?:غيّر|بدلاً|الآن|تعديل)/u.test(normalized);
        if (
          period === 'ambiguous' &&
          (isCorrection || state.buyerMinimumAnnualProfitAed) &&
          (state.buyerReturnPeriod === 'annual' || state.buyerReturnPeriod === 'monthly')
        ) {
          period = state.buyerReturnPeriod;
        }

        state.buyerReturnAmountAed = this.formatAedAmount(requirement.amount);
        state.buyerReturnPeriod = period;
        state.buyerProfitableOnly = true;
        if (period === 'monthly') {
          state.buyerMinimumAnnualProfitAed = this.formatAedAmount(
            requirement.amount * 12
          );
        } else if (period === 'annual') {
          state.buyerMinimumAnnualProfitAed = this.formatAedAmount(
            requirement.amount
          );
        } else {
          state.buyerMinimumAnnualProfitAed = undefined;
        }
        fieldsUpdated.push('buyer_return_period', 'buyer_profitable_only');
        if (state.buyerMinimumAnnualProfitAed) {
          fieldsUpdated.push('buyer_minimum_annual_profit_aed');
        }
      }
    }

    const exclusions = this.extractBuyerExclusions(normalized);
    if (exclusions.length > 0) {
      const existing = (state.buyerExcludedSectors || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      const merged = Array.from(new Set([...existing, ...exclusions]));
      const rendered = merged.join(', ');
      if (rendered !== state.buyerExcludedSectors) {
        state.buyerExcludedSectors = rendered;
        fieldsUpdated.push('buyer_excluded_sectors');
      }
    }

    const hasBuyerPreference = Boolean(
      state.buyerProfitableOnly ||
      state.buyerMinimumAnnualProfitAed ||
      state.buyerMinimumRoiPct ||
      state.buyerReturnPeriod === 'ambiguous' ||
      state.buyerInvolvement ||
      state.buyerExcludedSectors
    );
    if (hasBuyerPreference && this.isMeaningfulFreeText(normalized)) {
      const existing = state.buyerAdditionalComments || '';
      if (!existing.toLowerCase().includes(lowered)) {
        state.buyerAdditionalComments = [existing, normalized]
          .filter(Boolean)
          .join(' | ')
          .slice(-1000);
        fieldsUpdated.push('buyer_additional_comments');
      }
    }
  }

  private extractBuyerSectorPreference(value: string): string | null {
    const patterns = [
      /(?:looking for|want to (?:buy|acquire)|interested in|seeking)\s+(?:(?:a|an|the)\s+)?(.+?)(?=\s+(?:in|under|below|up to|with (?:a\s+)?budget|within (?:a\s+)?budget|that|which|if)\b|[,.;]|$)/i,
      /(?:buy|acquire)\s+(?:(?:a|an|the)\s+)?(.+?)(?=\s+(?:in|under|below|up to|with|for)\b|[,.;]|$)/i,
      /(?:sector|industry|business type)\s*(?:is|to|=|:)?\s*(.+?)(?=\s+(?:in|under|below|up to|with|budget)\b|[,.;]|$)/i,
      /(?:ищу|хочу купить|интересует|рассматриваю)\s+(.+?)(?=\s+(?:в|до|с бюджетом|бюджет)\b|[,.;]|$)/iu,
      /(?:أبحث عن|أريد شراء|مهتم بـ)\s*(.+?)(?=\s+(?:في|بميزانية|حتى)\b|[,.;]|$)/u,
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (!match?.[1]) continue;
      const candidate = this.normalizeBusinessText(match[1]);
      if (!candidate || this.isBuyerCriteriaOnlyText(candidate)) continue;
      return this.isGenericBuyerSector(candidate)
        ? 'Any profitable business'
        : candidate;
    }

    const beforeLocation = this.extractBusinessType(value, false);
    if (beforeLocation && !this.isBuyerCriteriaOnlyText(beforeLocation)) {
      return this.isGenericBuyerSector(beforeLocation)
        ? 'Any profitable business'
        : beforeLocation;
    }
    return null;
  }

  private isGenericBuyerSector(value: string): boolean {
    const normalized = value
      .toLowerCase()
      .replace(/\b(?:cash[- ]?generating|profitable|passive|investment|opportunity|established|good|any)\b/g, ' ')
      .replace(/(?:прибыльн|пассивн|инвестиц|возможност|любой|хорош)/gu, ' ')
      .replace(/(?:مربح|سلبي|استثمار|فرصة|أي)/gu, ' ')
      .replace(/\b(?:business(?:es)?|company|companies)\b/g, ' ')
      .replace(/(?:бизнес|компан(?:ия|ии)|проект)/gu, ' ')
      .replace(/(?:مشروع|شركة|أعمال)/gu, ' ')
      .replace(/(?:aed|dhs?|dirhams?)?\s*\d+(?:[.,]\d+)?\s*(?:m|mn|million|k|thousand)?/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    return normalized.length === 0;
  }

  private isBuyerCriteriaOnlyText(value: string): boolean {
    const stripped = value
      .toLowerCase()
      .replace(/(?:budget|profit|income|return|roi|yield|passive|annual|monthly|price|cash|flow|aed|dhs?|dirhams?|бюджет|прибыл|доход|пассив|год|месяц|цена|ميزانية|ربح|دخل|سلبي|سنوي|شهري|سعر)/gu, ' ')
      .replace(/\d+(?:[.,]\d+)?\s*(?:m|mn|million|k|thousand|%?)/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    return stripped.length === 0;
  }

  private extractBuyerBudgetRequirement(value: string): number | null {
    if (/\b(?:budget is flexible|flexible budget|no fixed budget)\b/i.test(value)) {
      return null;
    }
    const amountPattern = '(\\d{1,3}(?:[, ]\\d{3})+|\\d+(?:[.,]\\d+)?)\\s*(b|bn|billion|m|mn|mln|million|k|thousand)?';
    const patterns = [
      new RegExp(`(?:budget|maximum budget|max budget|purchase price|can spend|invest(?:ment)? amount|up to|under|below|not more than)\\D{0,25}(?:aed|dhs?|dirhams?)?\\s*${amountPattern}`, 'i'),
      new RegExp(`(?:aed|dhs?|dirhams?)?\\s*${amountPattern}\\D{0,20}(?:budget|maximum|max|to spend)`, 'i'),
      new RegExp(`(?:бюджет|максимум|до|не более|готов вложить)\\D{0,25}(?:aed|дирхам(?:ов|а)?)?\\s*${amountPattern}`, 'iu'),
      new RegExp(`(?:الميزانية|الحد الأقصى|حتى|أستطيع دفع)\\D{0,25}(?:درهم)?\\s*${amountPattern}`, 'u'),
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (!match?.[1]) continue;
      const amount = this.scaleMoneyNumber(match[1], match[2] || '');
      if (amount !== null && amount >= 1000) return amount;
    }
    return null;
  }

  private extractBuyerReturnRequirement(
    value: string
  ): { amount: number; period: 'annual' | 'monthly' | 'ambiguous' } | null {
    const amountPattern = '(\\d{1,3}(?:[, ]\\d{3})+|\\d+(?:[.,]\\d+)?)\\s*(b|bn|billion|m|mn|mln|million|k|thousand)?';
    const patterns = [
      new RegExp(`(?:net\\s+profit|profit|income|cash\\s*flow|cashflow|earnings?|earns?|makes?|brings?|return)\\D{0,40}?(?:more than|over|at least|minimum|min|above|of)?\\s*(?:aed|dhs?|dirhams?)?\\s*${amountPattern}`, 'i'),
      new RegExp(`(?:more than|over|at least|minimum|min|above)?\\s*(?:aed|dhs?|dirhams?)?\\s*${amountPattern}\\D{0,30}(?:net\\s+profit|profit|income|cash\\s*flow|cashflow|earnings?|return)`, 'i'),
      new RegExp(`(?:прибыл|доход|денежн(?:ый|ого)? поток|зарабатывает|приносит)\\D{0,40}?(?:не менее|больше|свыше|от)?\\s*(?:aed|дирхам(?:ов|а)?)?\\s*${amountPattern}`, 'iu'),
      new RegExp(`(?:ربح|دخل|تدفق نقدي|يدر|عائد)\\D{0,40}?(?:أكثر من|على الأقل)?\\s*(?:درهم)?\\s*${amountPattern}`, 'u'),
    ];
    let match: RegExpMatchArray | null = null;
    for (const pattern of patterns) {
      match = value.match(pattern);
      if (match?.[1]) break;
    }
    if (!match?.[1]) return null;
    const amount = this.scaleMoneyNumber(match[1], match[2] || '');
    if (!amount || amount < 1000) return null;

    const monthly = /\b(?:monthly|per month|a month|each month)\b/i.test(value)
      || /(?:ежемесяч|в месяц|за месяц)/iu.test(value)
      || /(?:شهري|في الشهر|كل شهر)/u.test(value);
    const annual = /\b(?:annual|annually|yearly|per year|a year|each year|12 months)\b/i.test(value)
      || /(?:годов|в год|за год|ежегод)/iu.test(value)
      || /(?:سنوي|في السنة|كل سنة)/u.test(value);
    return {
      amount,
      period: monthly ? 'monthly' : annual ? 'annual' : 'ambiguous',
    };
  }

  private extractBuyerExclusions(value: string): string[] {
    const results: string[] = [];
    const patterns = [
      /\b(?:no|not|exclude|excluding|avoid|except)\s+(?!(?:more than|required|important|sure|fixed|available)\b)([^,.;]{2,80})/gi,
      /\b(?:anything but|everything except)\s+([^,.;]{2,80})/gi,
      /(?:не рассматриваю|исключить|без)\s+([^,.;]{2,80})/giu,
      /(?:لا أريد|استبعاد|باستثناء)\s+([^,.;]{2,80})/gu,
    ];
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const raw = match[1]
          ?.split(/\b(?:with|under|below|up to|budget|profit|income|return|in dubai|in abu dhabi)\b/i)[0]
          ?.trim();
        if (!raw) continue;
        for (const part of raw.split(/\s+(?:or|and|или|и|أو|و)\s+|\//iu)) {
          const clean = part
            .replace(/^(?:a|an|the)\s+/i, '')
            .replace(/\b(?:business(?:es)?|sector|industry)\b/gi, '')
            .replace(/(?:бизнес|сектор|отрасль|مشروع|قطاع)/giu, '')
            .trim();
          if (clean.length >= 2 && clean.length <= 50) results.push(clean);
        }
      }
    }
    return Array.from(new Set(results.map(item => item.toLowerCase())));
  }

  private extractMoneyByHints(value: string, hints: RegExp[]): string | null {
    for (const hint of hints) {
      const flags = hint.flags.replace(/g/g, '');
      const matcher = new RegExp(hint.source, flags);
      const match = matcher.exec(value);
      if (!match || match.index === undefined) continue;

      const after = value.slice(match.index + match[0].length, match.index + match[0].length + 100);
      const afterAmount = this.extractMoneyExpression(after);
      if (afterAmount) return afterAmount;

      const beforeRaw = value.slice(Math.max(0, match.index - 100), match.index);
      const boundary = Math.max(
        beforeRaw.lastIndexOf(','),
        beforeRaw.lastIndexOf(';'),
        beforeRaw.lastIndexOf('.'),
        beforeRaw.toLowerCase().lastIndexOf(' and ')
      );
      const before = boundary >= 0 ? beforeRaw.slice(boundary + 1) : beforeRaw;
      const beforeAmount = this.extractMoneyExpression(before);
      if (beforeAmount) return beforeAmount;
    }
    return null;
  }

  private extractMoneyExpression(value: string): string | null {
    if (this.isExplicitUnknown(value)) return 'Unknown / to confirm';

    const rangeMatch = value.match(
      /(\d+(?:[.,]\d+)?)\s*(?:-|–|to|до|إلى)\s*(\d+(?:[.,]\d+)?)\s*(m|mn|mln|million|k|thousand|млн|тыс|مليون|ألف)?/iu
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
      /(\d+(?:[.,]\d+)?)\s*(m|mn|mln|million|k|thousand|млн|миллион(?:а|ов)?|тыс(?:яч[аи]?)?|مليون|ألف)\b/iu
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
    const compact = raw.replace(/\s/g, '');
    const normalizedNumber = /^\d{1,3}(?:,\d{3})+$/.test(compact)
      ? compact.replace(/,/g, '')
      : compact.includes(',') && !compact.includes('.')
        ? compact.replace(',', '.')
        : compact.replace(/,/g, '');
    const base = Number.parseFloat(normalizedNumber);
    if (!Number.isFinite(base)) return null;
    const normalized = unit.toLowerCase();
    const multiplier = /^(b|bn|billion)$/u.test(normalized)
      ? 1_000_000_000
      : /^(m|mn|mln|million|млн|миллион|миллиона|миллионов|مليون)$/u.test(
          normalized
        )
        ? 1_000_000
        : /^(k|thousand|тыс|тысяча|тысячи|тысяч|ألف)$/u.test(normalized)
          ? 1_000
          : 1;
    const amount = Math.round(base * multiplier);
    return Number.isSafeInteger(amount) ? amount : null;
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
    if (normalized === '1') return true;
    if (normalized === '2') return false;
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
    const trimmed = jid.trim();
    const separator = trimmed.indexOf('@');
    if (separator >= 0) {
      const domain = trimmed.slice(separator + 1).toLowerCase();
      if (domain !== 's.whatsapp.net') return null;
      return this.normalizePhoneNumber(trimmed.slice(0, separator));
    }
    return this.normalizePhoneNumber(trimmed);
  }

  private normalizePhoneNumber(value: string): string | null {
    const trimmed = value.trim();
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (digitsOnly.length < 8) return null;
    return trimmed.startsWith('+') ? `+${digitsOnly}` : digitsOnly;
  }

  private detectEarlyEscalationReason(value: string): string | null {
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
    state.stage = 'ready_for_review';
    state.expectedField = undefined;
    state.pendingConfirmation = undefined;
    state.lastInputIssue = undefined;
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
    let cleaned = this.cleanFreeTextAnswer(value) || '';
    cleaned = cleaned
      .replace(/^(?:i\s+(?:want|would like|need|plan)\s+to\s+|i(?:'m| am)\s+|we\s+)(?:sell(?:ing)?|buy(?:ing)?|acquir(?:e|ing)|looking for)\s+(?:a\s+|an\s+|the\s+)?/i, '')
      .replace(/^(?:sell|selling|buy|buying|acquire|acquiring|looking for)\s+(?:a\s+|an\s+|the\s+)?/i, '')
      .replace(/^(?:we\s+(?:operate|run|own|have|are)|i\s+(?:operate|run|own|have))\s+(?:a\s+|an\s+|the\s+)?/i, '')
      .replace(/^business\s*[:=-]?\s*/i, '')
      .replace(/^(?:a|an|the)\s+/i, '');

    const boundary = cleaned.search(
      /(?:[,;.]|\s+(?:in|located in|based in)\s+(?=Dubai|Abu Dhabi|Sharjah|Ajman|Fujairah|Ras Al Khaimah|RAK|Umm Al Quwain)|\s+(?:with\s+)?(?:annual|yearly|monthly)?\s*(?:revenue|turnover|sales|profit|expenses)|\s+(?:asking(?: price)?|expected price|selling price|sell for|looking for|budget|under|up to|maximum|max(?:imum)?)\b)/i
    );
    if (boundary > 0) cleaned = cleaned.slice(0, boundary);

    cleaned = cleaned
      .replace(/\b(?:in dubai|in abu dhabi|uae)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 2 || !this.isMeaningfulFreeText(cleaned)) {
      return null;
    }
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

  private isStartOverCommand(value: string): boolean {
    const normalized = this.normalizeWhitespace(value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
    if (/^(?:start over|start all over again|start again|begin again|restart|reset|clear everything|начать заново|начать сначала|перезапустить|ابدأ من جديد|إعادة البدء)$/iu.test(normalized)) {
      return true;
    }
    // Tolerate short command typos such as “start pver” without applying fuzzy
    // matching to normal conversational sentences.
    if (normalized.length >= 7 && normalized.length <= 12 && normalized.startsWith('start ')) {
      return this.editDistance(normalized, 'start over') <= 2;
    }
    return false;
  }

  private editDistance(left: string, right: string): number {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      let diagonal = previous[0] ?? 0;
      previous[0] = i;
      for (let j = 1; j <= right.length; j += 1) {
        const above = previous[j] ?? j;
        const candidate = Math.min(
          (previous[j - 1] ?? i) + 1,
          above + 1,
          diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
        );
        diagonal = above;
        previous[j] = candidate;
      }
    }
    return previous[right.length] ?? Math.max(left.length, right.length);
  }

  private isGreeting(value: string): boolean {
    const normalized = this.normalizeWhitespace(value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
    return /^(?:hi|hello|hey|salam|assalamu alaikum|good morning|good afternoon|good evening|привет|здравствуйте|добрый день|добрый вечер|салам|مرحبا|السلام عليكم|أهلا)$/iu.test(normalized);
  }

  private isNewRequestCommand(value: string): boolean {
    return /^(?:new request|another request|new case|another case|i have another one|новый запрос|другой запрос|ещё один запрос|طلب جديد|طلب آخر)$/iu.test(value);
  }

  private detectNewCasePurpose(value: string, awaitingChoice: boolean): LeadInquiryPurpose | null {
    const buying =
      /\b(?:i\s+(?:want|would like|need|plan)\s+to|looking\s+to|interested\s+to)\s+(?:buy|purchase|acquire)\b/iu.test(value) ||
      /\b(?:another|new)\s+(?:buyer|buying|acquisition)\s+(?:request|case)?\b/iu.test(value) ||
      /(?:хочу|нужно|планирую)\s+(?:купить|приобрести)|новый запрос на покупку/iu.test(value) ||
      /(?:أريد|أرغب)\s+(?:شراء|الاستحواذ)|طلب شراء جديد/u.test(value) ||
      (awaitingChoice && /^(?:buy|buying|buyer|purchase|покупка|купить|شراء)$/iu.test(value));
    if (buying) return 'buying';

    const selling =
      /\b(?:i\s+(?:also\s+)?(?:have|want|would like|need|plan)\s+to|looking\s+to)\s+(?:sell|list)\b/iu.test(value) ||
      /\bi\s+(?:also\s+)?have\s+.{1,80}\bto\s+(?:sell|list)\b/iu.test(value) ||
      /\b(?:another|new|different)\s+(?:business|company|seller|selling)\b.*\b(?:sell|request|case)?\b/iu.test(value) ||
      /\b(?:sell|selling|list)\b.*\b(?:another|new|different)\s+(?:business|company|one)\b/iu.test(value) ||
      /(?:хочу|нужно|планирую)\s+продать|ещ[ёе] один бизнес|новый запрос на продажу/iu.test(value) ||
      /(?:أريد|أرغب)\s+بيع|مشروع آخر للبيع|طلب بيع جديد/u.test(value) ||
      (awaitingChoice && /^(?:sell|selling|seller|продажа|продать|بيع)$/iu.test(value));
    return selling ? 'selling' : null;
  }

  private isCurrentCaseReference(value: string): boolean {
    return /^(?:this|that|current|existing|same|my request|the request|about it|first one|этот|текущий|мой запрос|о н[её]м|тот же|هذا|الطلب الحالي|طلبي)$/iu.test(value);
  }

  private isCurrentCaseStatusQuestion(value: string): boolean {
    return /(?:what(?:'s| is) happening|what now|status|progress|any update|what happened|my request|submitted request|что с моим запросом|какой статус|есть новости|что дальше|حالة طلبي|ماذا حدث|ما التالي)/iu.test(value);
  }

  private isVagueHelpRequest(value: string): boolean {
    return /^(?:help|i need help|can you help|what can i do|помоги|нужна помощь|что делать|ساعدني|أحتاج مساعدة)$/iu.test(value);
  }

  private beginSeparateCase(state: LeadCaptureState, purpose: LeadInquiryPurpose): void {
    const language = state.language;
    const phone = state.clientPhone;
    const name = state.clientName;
    const fresh = this.createInitialState();
    fresh.language = language;
    fresh.clientPhone = phone;
    fresh.clientName = name;
    fresh.inquiryPurpose = purpose;
    fresh.entryType = purpose === 'selling' ? 'seller_inbound' : 'buyer_inbound';
    fresh.status = 'contacted';
    fresh.stage = name ? 'identity_collected' : 'intent_identified';
    fresh.activeCaseStartedAt = Date.now();
    for (const key of Object.keys(state) as Array<keyof LeadCaptureState>) {
      Reflect.deleteProperty(state, key);
    }
    Object.assign(state, fresh);
  }

  private currentCaseLabel(state: LeadCaptureState): string {
    if (state.businessType) return state.businessType;
    return state.inquiryPurpose === 'buying' ? 'buyer search' : 'seller request';
  }

  private contextualReentryPrompt(state: LeadCaptureState): string {
    const name = state.clientName ? `, ${state.clientName}` : '';
    const label = this.currentCaseLabel(state);
    const messages: Record<ConversationLanguage, string> = {
      en: `Hello${name}. Your ${label} request is saved with SHARH. Are you asking about that request, selling another business, or looking to buy?`,
      ru: `Здравствуйте${name}. Ваш запрос «${label}» сохранён в SHARH. Вы хотите уточнить этот запрос, продать другой бизнес или подобрать бизнес для покупки?`,
      ar: `مرحباً${name}. طلب ${label} محفوظ لدى SHARH. هل تسأل عن هذا الطلب، أم تريد بيع مشروع آخر، أم تبحث عن مشروع للشراء؟`,
    };
    return messages[state.language];
  }

  private shortReentryPrompt(state: LeadCaptureState): string {
    const messages: Record<ConversationLanguage, string> = {
      en: 'How can I help with your SHARH request?',
      ru: 'Чем помочь по вашему запросу в SHARH?',
      ar: 'كيف يمكنني مساعدتك بخصوص طلبك لدى SHARH؟',
    };
    return messages[state.language];
  }

  private currentCaseStatus(state: LeadCaptureState): string {
    const label = this.currentCaseLabel(state);
    const submitted = state.submittedForReview;
    const messages: Record<ConversationLanguage, string> = {
      en: submitted
        ? `Your ${label} request has been submitted for initial SHARH review. You can update any detail here, add more information, or start a separate buyer or seller request.`
        : `Your ${label} request is saved. You can update it, add more information, submit it for review, or start a separate request.`,
      ru: submitted
        ? `Запрос «${label}» отправлен на первичное рассмотрение SHARH. Здесь можно изменить данные, добавить информацию или создать отдельный запрос на покупку или продажу.`
        : `Запрос «${label}» сохранён. Можно изменить или дополнить его, отправить на рассмотрение либо создать отдельный запрос.`,
      ar: submitted
        ? `تم إرسال طلب ${label} للمراجعة الأولية لدى SHARH. يمكنك تحديث أي معلومة أو إضافة تفاصيل أو بدء طلب شراء أو بيع منفصل.`
        : `تم حفظ طلب ${label}. يمكنك تحديثه أو إضافة معلومات أو إرساله للمراجعة أو بدء طلب منفصل.`,
    };
    return messages[state.language];
  }

  private newRequestDisambiguation(language: ConversationLanguage): string {
    const messages: Record<ConversationLanguage, string> = {
      en: 'Is the new request for selling another business or buying a business?',
      ru: 'Новый запрос — на продажу другого бизнеса или на покупку бизнеса?',
      ar: 'هل الطلب الجديد لبيع مشروع آخر أم لشراء مشروع؟',
    };
    return messages[language];
  }

  private newCasePrefix(
    language: ConversationLanguage,
    purpose: LeadInquiryPurpose,
    next?: string
  ): string {
    const prefixes: Record<ConversationLanguage, Record<LeadInquiryPurpose, string>> = {
      en: {
        selling: 'Understood. I will keep the previous request and create a separate seller request.',
        buying: 'Understood. I will keep the previous request and create a separate buyer search.',
      },
      ru: {
        selling: 'Понял. Предыдущий запрос сохранится, а для другого бизнеса будет создан отдельный запрос на продажу.',
        buying: 'Понял. Предыдущий запрос сохранится, а для покупки будет создан отдельный запрос.',
      },
      ar: {
        selling: 'مفهوم. سأحتفظ بالطلب السابق وأنشئ طلب بيع منفصلاً.',
        buying: 'مفهوم. سأحتفظ بالطلب السابق وأنشئ طلب شراء منفصلاً.',
      },
    };
    return [prefixes[language][purpose], next].filter(Boolean).join('\n\n');
  }

  private detectExplicitLanguageSwitch(value: string): ConversationLanguage | null {
    if (/^(?:speak|continue|reply|answer in|use)?\s*english(?:\s+please)?$/iu.test(value) || /(?:speak|continue|reply|answer).{0,20}english/iu.test(value)) {
      return 'en';
    }
    if (/^(?:говори|продолжай|ответь)?\s*(?:по-)?русски$/iu.test(value) || /(?:speak|continue).{0,20}russian/iu.test(value)) {
      return 'ru';
    }
    if (/^(?:تحدث|تابع|أجب)?\s*(?:بالعربية|العربية)$/u.test(value) || /(?:speak|continue).{0,20}arabic/iu.test(value)) {
      return 'ar';
    }
    return null;
  }

  private nextStepMenu(state: LeadCaptureState): string {
    const webBase = (process.env['SHARH_WEB_BASE_URL'] || 'https://sharh.ae').replace(/\/$/, '');
    if (state.inquiryPurpose === 'buying') {
      const messages: Record<ConversationLanguage, string> = {
        en: `You can open a result by replying with its number or SH-XXXX code. You can also refine the search, save your requirements for SHARH review, or open the marketplace: ${webBase}/marketplace`,
        ru: `Чтобы открыть вариант, отправьте его номер или код SH-XXXX. Также можно уточнить поиск, сохранить требования для рассмотрения SHARH или открыть маркетплейс: ${webBase}/marketplace`,
        ar: `لفتح أحد الخيارات، أرسل رقمه أو رمز SH-XXXX. ويمكنك أيضاً تعديل البحث أو حفظ متطلباتك لمراجعة SHARH أو فتح السوق: ${webBase}/marketplace`,
      };
      return messages[state.language];
    }

    const summary: string[] = [];
    if (state.businessType) summary.push(`Business: ${state.businessType}`);
    if (state.businessLocation) summary.push(`Location: ${state.businessLocation}`);
    if (state.desiredSellingPriceAed) summary.push(`Expected price: ${state.desiredSellingPriceAed}`);
    if (state.annualRevenueAed) summary.push(`Annual revenue: ${state.annualRevenueAed}`);
    if (state.monthlyNetProfitAed) summary.push(`Monthly profit: ${state.monthlyNetProfitAed}`);
    const rendered = summary.map((item) => `• ${item}`).join('\n');
    const messages: Record<ConversationLanguage, string> = {
      en: `I have recorded the essential details${rendered ? `:\n${rendered}` : ''}. This is enough for an initial SHARH review. Would you like me to submit it for review, add more details, or send you the website link?`,
      ru: `Я зафиксировал основные данные${rendered ? `:\n${rendered}` : ''}. Этого достаточно для первичного рассмотрения SHARH. Отправить запрос на рассмотрение, добавить подробности или прислать ссылку на сайт?`,
      ar: `تم تسجيل المعلومات الأساسية${rendered ? `:\n${rendered}` : ''}. وهي كافية للمراجعة الأولية من SHARH. هل تريد إرسال الطلب للمراجعة أو إضافة تفاصيل أو الحصول على رابط الموقع؟`,
    };
    return messages[state.language];
  }

  private optionalDetailsPrompt(
    language: ConversationLanguage,
    purpose?: LeadInquiryPurpose
  ): string {
    if (purpose === 'buying') {
      const messages: Record<ConversationLanguage, string> = {
        en: 'Send any additional preferences in one message—for example timeline, funding readiness, preferred involvement, or other requirements. You can also say “done”.',
        ru: 'Отправьте дополнительные пожелания одним сообщением: сроки, готовность финансирования, желаемое участие или другие требования. Можно также написать «готово».',
        ar: 'أرسل أي تفضيلات إضافية في رسالة واحدة، مثل المدة أو جاهزية التمويل أو مستوى المشاركة أو أي متطلبات أخرى. ويمكنك أيضاً كتابة «تم».',
      };
      return messages[language];
    }
    const messages: Record<ConversationLanguage, string> = {
      en: 'Send any additional details in one message. Useful items include monthly profit and expenses, lease and rent, year established, employees, debts, licences or contracts, reason for sale, and what is included. Share only what you know; “done” is enough when finished.',
      ru: 'Отправьте дополнительные сведения одним сообщением: ежемесячная прибыль и расходы, аренда, год основания, сотрудники, долги, лицензии или контракты, причина продажи и что входит в сделку. Укажите только то, что знаете; когда закончите, напишите «готово».',
      ar: 'أرسل أي تفاصيل إضافية في رسالة واحدة، مثل الربح والمصاريف الشهرية والإيجار وسنة التأسيس والموظفين والديون والتراخيص أو العقود وسبب البيع وما يشمله البيع. شارك ما تعرفه فقط، واكتب «تم» عند الانتهاء.',
    };
    return messages[language];
  }

  private contactRequestPrompt(language: ConversationLanguage): string {
    const messages: Record<ConversationLanguage, string> = {
      en: 'Please send the name we should use and a convenient time for SHARH to contact you. Your WhatsApp number is already recorded.',
      ru: 'Напишите, пожалуйста, как к вам обращаться и в какое время удобно связаться. Ваш номер WhatsApp уже сохранён.',
      ar: 'أرسل الاسم الذي نستخدمه والوقت المناسب لتواصل SHARH معك. رقم واتساب مسجل بالفعل.',
    };
    return messages[language];
  }

  private contactRequestConfirmed(language: ConversationLanguage): string {
    const messages: Record<ConversationLanguage, string> = {
      en: 'Your contact request has been recorded. The SHARH team can see this conversation and the details already provided.',
      ru: 'Запрос на связь сохранён. Команда SHARH видит эту переписку и уже предоставленные данные.',
      ar: 'تم تسجيل طلب التواصل. ويمكن لفريق SHARH الاطلاع على هذه المحادثة والتفاصيل المقدمة.',
    };
    return messages[language];
  }

  private submissionConfirmed(language: ConversationLanguage): string {
    const messages: Record<ConversationLanguage, string> = {
      en: 'Submitted for initial SHARH review. The SHARH team can now see the conversation and the information recorded. I can still help you update this request or start a separate one.',
      ru: 'Запрос отправлен на первичное рассмотрение SHARH. Команда видит переписку WhatsApp и сохранённые данные. Я по-прежнему могу помочь обновить этот запрос или создать отдельный.',
      ar: 'تم إرسال الطلب للمراجعة الأولية لدى SHARH. ويمكن للفريق الاطلاع على محادثة واتساب والمعلومات المسجلة. ما زلت أستطيع مساعدتك في تحديث الطلب أو بدء طلب منفصل.',
    };
    return messages[language];
  }

  private websiteContinuationMessage(
    language: ConversationLanguage,
    purpose: LeadInquiryPurpose
  ): string {
    const base = (process.env['SHARH_WEB_BASE_URL'] || 'https://sharh.ae').replace(/\/$/, '');
    const url = purpose === 'selling' ? `${base}/sell/intake` : `${base}/marketplace`;
    const messages: Record<ConversationLanguage, string> = {
      en: `Continue on SHARH here: ${url}\n\nYour WhatsApp conversation remains saved for the team, so you can use the website mainly for additional details, images, or documents.`,
      ru: `Продолжить на сайте SHARH: ${url}\n\nПереписка WhatsApp сохранена для команды, поэтому сайт можно использовать в основном для дополнительных данных, изображений или документов.`,
      ar: `يمكنك المتابعة على موقع SHARH هنا: ${url}\n\nتظل محادثة واتساب محفوظة للفريق، ويمكن استخدام الموقع أساساً لإضافة تفاصيل أو صور أو مستندات.`,
    };
    return messages[language];
  }


  private buyerSearchSavedMessage(language: ConversationLanguage): string {
    const messages: Record<ConversationLanguage, string> = {
      en: 'Your buyer criteria have been saved for SHARH review. The team can see this chat and contact you when a suitable opportunity is available.',
      ru: 'Критерии покупателя сохранены для рассмотрения SHARH. Команда видит этот чат и сможет связаться при появлении подходящего предложения.',
      ar: 'تم حفظ معايير الشراء لمراجعة SHARH. ويمكن للفريق الاطلاع على المحادثة والتواصل عند توفر فرصة مناسبة.',
    };
    return messages[language];
  }

  private questionForField(
    language: ConversationLanguage,
    field: LeadField,
    purpose?: LeadInquiryPurpose,
    isRetry: boolean = false
  ): string {
    if (field === 'business_type' && purpose === 'selling') {
      const prompts: Record<ConversationLanguage, string> = {
        en: 'Please tell me briefly what the business does, where it is located, and the expected selling price. You can write everything naturally in one message, and approximate figures are fine.',
        ru: 'Кратко расскажите, чем занимается бизнес, где он находится и какую цену продажи вы ожидаете. Можно написать всё одним сообщением, приблизительные цифры подходят.',
        ar: 'أخبرني باختصار عن نشاط المشروع وموقعه وسعر البيع المتوقع. يمكنك كتابة كل المعلومات بشكل طبيعي في رسالة واحدة، والأرقام التقريبية مقبولة.',
      };
      return prompts[language];
    }
    if (field === 'business_type' && purpose === 'buying') {
      const prompts: Record<ConversationLanguage, string> = {
        en: 'Describe the business you want in one message: preferred sector (or any sector), maximum budget, location if important, minimum annual profit or ROI, and whether it must be passive/manager-run.',
        ru: 'Опишите желаемый бизнес одним сообщением: сфера (или любая), максимальный бюджет, важная локация, минимальная годовая прибыль или ROI и нужен ли пассивный/управляемый формат.',
        ar: 'صف المشروع المطلوب في رسالة واحدة: القطاع أو أي قطاع، الحد الأقصى للميزانية، الموقع إن كان مهماً، الحد الأدنى للربح السنوي أو العائد، وهل يجب أن يكون مُداراً دون تدخل مباشر.',
      };
      return prompts[language];
    }
    const questions: Record<ConversationLanguage, Partial<Record<LeadField, string>>> = {
      en: {
        business_type: 'What does the business do, or which sector interests you?',
        business_location: 'In which emirate and area is the business located?',
        annual_revenue_aed: 'What was the approximate annual revenue over the last 12 months? You can say “unknown” if it is not available.',
        lease_details: 'Is the premises leased, and what are the monthly rent and remaining lease term?',
        desired_selling_price_aed: 'What selling price or price range do you expect? An approximate amount is fine.',
        year_established: 'In which year was the business established?',
        employee_count: 'How many employees does the business have?',
        monthly_operating_expenses_aed: 'What are the approximate monthly operating expenses?',
        monthly_net_profit_aed: 'What is the approximate monthly net profit?',
        liabilities: 'Are there any debts or other liabilities?',
        contracts_licenses: 'Which active licences, supplier agreements, or important contracts are in place?',
        sale_reason_urgency: 'Why are you selling, and what timing do you have in mind?',
        included_assets: 'What is included in the sale, such as equipment, inventory, brand, or licences?',
        buyer_budget_aed: 'What is your approximate maximum budget? You can also say that the budget is flexible.',
        buyer_location: 'Which emirate or area would you consider? You can include your maximum budget in the same message.',
        buyer_timeline: 'When would you ideally like to complete an acquisition?',
        buyer_involvement: 'Would you prefer to operate the business personally, invest passively, or are you open to either?',
        buyer_funding_status: 'How do you expect to fund the acquisition: available funds, financing, or a combination?',
        buyer_additional_comments: 'Are there any other requirements I should record?',
        contact_preference: 'Please send the name we should use and a convenient time for SHARH to contact you.',
      },
      ru: {
        business_type: 'Чем занимается бизнес или какая сфера вас интересует?',
        business_location: 'В каком эмирате и районе находится бизнес?',
        annual_revenue_aed: 'Какова примерная годовая выручка за последние 12 месяцев? Если данных нет, можно написать «не знаю».',
        lease_details: 'Помещение арендуется, и если да, какова месячная аренда и оставшийся срок договора?',
        desired_selling_price_aed: 'Какую цену продажи или диапазон вы ожидаете? Приблизительной суммы достаточно.',
        year_established: 'В каком году был основан бизнес?',
        employee_count: 'Сколько сотрудников работает в бизнесе?',
        monthly_operating_expenses_aed: 'Каковы примерные ежемесячные операционные расходы?',
        monthly_net_profit_aed: 'Какова примерная ежемесячная чистая прибыль?',
        liabilities: 'Есть ли долги или другие обязательства?',
        contracts_licenses: 'Какие действующие лицензии, договоры с поставщиками или важные контракты есть у бизнеса?',
        sale_reason_urgency: 'Почему вы продаёте бизнес и в какие сроки хотите завершить сделку?',
        included_assets: 'Что входит в продажу: оборудование, запасы, бренд, лицензии или другие активы?',
        buyer_budget_aed: 'Каков ваш примерный максимальный бюджет? Можно также указать, что бюджет гибкий.',
        buyer_location: 'Какой эмират или район вы рассматриваете? В том же сообщении можно указать максимальный бюджет.',
        buyer_timeline: 'Когда вы хотели бы завершить покупку? Можно ответить своими словами, например: в течение 3 месяцев или пока просто изучаю варианты.',
        buyer_involvement: 'Как вы хотите участвовать в бизнесе: управлять лично, инвестировать пассивно или рассматриваете оба варианта?',
        buyer_funding_status: 'Как вы планируете финансировать покупку: собственными средствами, финансированием или их комбинацией?',
        buyer_additional_comments: 'Есть ли другие требования, которые нужно зафиксировать?',
        contact_preference: 'Напишите, пожалуйста, как к вам обращаться и в какое время удобно связаться.',
      },
      ar: {
        business_type: 'ما نشاط المشروع أو القطاع الذي تهتم به؟',
        business_location: 'في أي إمارة ومنطقة يقع المشروع؟',
        annual_revenue_aed: 'ما الإيرادات السنوية التقريبية خلال آخر 12 شهراً؟ يمكنك قول «غير معروف» إذا لم تتوفر البيانات.',
        lease_details: 'هل الموقع مستأجر، وما قيمة الإيجار الشهري والمدة المتبقية في العقد؟',
        desired_selling_price_aed: 'ما سعر البيع أو النطاق السعري المتوقع؟ يكفي مبلغ تقريبي.',
        year_established: 'في أي سنة تأسس المشروع؟',
        employee_count: 'كم عدد الموظفين في المشروع؟',
        monthly_operating_expenses_aed: 'ما المصاريف التشغيلية الشهرية التقريبية؟',
        monthly_net_profit_aed: 'ما صافي الربح الشهري التقريبي؟',
        liabilities: 'هل توجد ديون أو التزامات أخرى؟',
        contracts_licenses: 'ما التراخيص والعقود المهمة أو اتفاقيات الموردين السارية؟',
        sale_reason_urgency: 'ما سبب البيع وما الإطار الزمني المطلوب لإتمام الصفقة؟',
        included_assets: 'ما الذي يشمله البيع، مثل المعدات أو المخزون أو العلامة التجارية أو التراخيص؟',
        buyer_budget_aed: 'ما الحد الأقصى التقريبي لميزانيتك؟ ويمكنك أيضاً القول إن الميزانية مرنة.',
        buyer_location: 'ما الإمارة أو المنطقة التي تفضلها؟ يمكنك أيضاً ذكر الحد الأقصى للميزانية في الرسالة نفسها.',
        buyer_timeline: 'متى ترغب في إتمام عملية الاستحواذ؟ يمكنك الإجابة بطريقتك، مثل خلال ثلاثة أشهر أو أن الوقت مرن.',
        buyer_involvement: 'كيف تريد المشاركة في المشروع: إدارته شخصياً أم استثماراً سلبياً أم أنك منفتح على الخيارين؟',
        buyer_funding_status: 'كيف تخطط لتمويل الاستحواذ: أموال متاحة أم تمويل أم مزيج منهما؟',
        buyer_additional_comments: 'هل توجد متطلبات أخرى تريد تسجيلها؟',
        contact_preference: 'أرسل الاسم الذي نستخدمه والوقت المناسب لتواصل SHARH معك.',
      },
    };
    const base = questions[language][field] || questions.en[field] || 'Please provide the requested information.';
    return isRetry ? `${this.retryPrefix(language)} ${base}` : base;
  }

  private confirmationQuestion(
    language: ConversationLanguage,
    pending: { field: LeadField; value: string; reason: string }
  ): string {
    const fieldLabels: Record<ConversationLanguage, Partial<Record<LeadField, string>>> = {
      en: {
        annual_revenue_aed: 'annual revenue',
        monthly_net_profit_aed: 'monthly net profit',
        monthly_operating_expenses_aed: 'monthly operating expenses',
        desired_selling_price_aed: 'expected selling price',
      },
      ru: {
        annual_revenue_aed: 'годовая выручка',
        monthly_net_profit_aed: 'ежемесячная чистая прибыль',
        monthly_operating_expenses_aed: 'ежемесячные операционные расходы',
        desired_selling_price_aed: 'ожидаемая цена продажи',
      },
      ar: {
        annual_revenue_aed: 'الإيرادات السنوية',
        monthly_net_profit_aed: 'صافي الربح الشهري',
        monthly_operating_expenses_aed: 'المصاريف التشغيلية الشهرية',
        desired_selling_price_aed: 'سعر البيع المتوقع',
      },
    };
    const label = fieldLabels[language][pending.field] || pending.field;
    const messages: Record<ConversationLanguage, string> = {
      en: `I may have understood this incorrectly. You entered ${pending.value} for ${label}, but it conflicts with another figure already provided. Should I save it anyway? Reply Yes or No.`,
      ru: `Возможно, я понял ответ неверно. Для поля «${label}» указано ${pending.value}, но это противоречит другой ранее указанной цифре. Сохранить значение? Ответьте Да или Нет.`,
      ar: `قد أكون فهمت الإجابة بشكل غير صحيح. أدخلت ${pending.value} لـ${label}، لكن هذا يتعارض مع رقم آخر تم تقديمه. هل أحفظه؟ أجب نعم أو لا.`,
    };
    return messages[language];
  }

  private invalidAnswerResponse(
    language: ConversationLanguage,
    field: LeadField,
    attempts: number,
    classification?: SalesMessageClassification
  ): string {
    const question = this.questionForField(language, field, undefined, false);
    const examples: Record<ConversationLanguage, Partial<Record<LeadField, string>>> = {
      en: {
        annual_revenue_aed: 'Please send an approximate amount such as AED 150,000, 1.2m, or “unknown”.',
        monthly_net_profit_aed: 'Please send an approximate monthly amount such as AED 20,000 or “unknown”.',
        monthly_operating_expenses_aed: 'Please send an approximate monthly amount such as AED 50,000 or “unknown”.',
        desired_selling_price_aed: 'Please send a price, choose an option, ask me for an indicative range, or reply “unknown”.',
        buyer_budget_aed: 'Please send a budget such as AED 500,000, choose an option, or reply “unknown”.',
        year_established: 'Please send a four-digit year such as 2018, or reply “unknown”.',
        employee_count: 'Please send the number of employees, such as 12, or reply “unknown”.',
      },
      ru: {
        annual_revenue_aed: 'Укажите примерную сумму, например 150 000 AED, 1,2 млн или «не знаю».',
        monthly_net_profit_aed: 'Укажите примерную месячную сумму, например 20 000 AED, или «не знаю».',
        monthly_operating_expenses_aed: 'Укажите примерную месячную сумму, например 50 000 AED, или «не знаю».',
        desired_selling_price_aed: 'Укажите цену, выберите вариант, попросите ориентировочную оценку или ответьте «не знаю».',
        buyer_budget_aed: 'Укажите бюджет, например 500 000 AED, выберите вариант или ответьте «не знаю».',
        year_established: 'Укажите год из четырёх цифр, например 2018, или ответьте «не знаю».',
        employee_count: 'Укажите количество сотрудников, например 12, или ответьте «не знаю».',
      },
      ar: {
        annual_revenue_aed: 'أرسل مبلغاً تقريبياً مثل 150,000 درهم أو 1.2 مليون أو «غير معروف».',
        monthly_net_profit_aed: 'أرسل مبلغاً شهرياً تقريبياً مثل 20,000 درهم أو «غير معروف».',
        monthly_operating_expenses_aed: 'أرسل مبلغاً شهرياً تقريبياً مثل 50,000 درهم أو «غير معروف».',
        desired_selling_price_aed: 'أرسل سعراً أو اختر خياراً أو اطلب نطاقاً تقديرياً أو أجب «غير معروف».',
        buyer_budget_aed: 'أرسل ميزانية مثل 500,000 درهم أو اختر خياراً أو أجب «غير معروف».',
        year_established: 'أرسل سنة من أربعة أرقام مثل 2018 أو أجب «غير معروف».',
        employee_count: 'أرسل عدد الموظفين مثل 12 أو أجب «غير معروف».',
      },
    };
    const generic: Record<ConversationLanguage, string> = {
      en: attempts >= 2
        ? 'Let’s not get stuck. A short factual answer or “unknown” is enough.'
        : classification === 'off_topic'
          ? 'I can help with the SHARH business sale or purchase process, but I still need this detail.'
          : 'I could not use that as a reliable answer.',
      ru: attempts >= 2
        ? 'Не будем останавливаться на этом. Достаточно короткого фактического ответа или «не знаю».'
        : classification === 'off_topic'
          ? 'Я могу помочь с покупкой или продажей бизнеса через SHARH, но мне всё ещё нужна эта информация.'
          : 'Я не смог надёжно распознать этот ответ.',
      ar: attempts >= 2
        ? 'لن نتوقف عند هذه النقطة. تكفي إجابة واقعية قصيرة أو «غير معروف».'
        : classification === 'off_topic'
          ? 'يمكنني المساعدة في شراء أو بيع الأعمال عبر SHARH، لكنني ما زلت بحاجة إلى هذه المعلومة.'
          : 'لم أتمكن من اعتماد هذه الإجابة بشكل موثوق.',
    };
    return `${generic[language]} ${examples[language][field] || question}`;
  }

  private retryPrefix(language: ConversationLanguage): string {
    const messages: Record<ConversationLanguage, string> = {
      en: 'A short answer, option number, range, or “unknown” is enough.',
      ru: 'Достаточно короткого ответа, номера варианта, диапазона или «не знаю».',
      ar: 'تكفي إجابة قصيرة أو رقم الخيار أو نطاق أو «غير معروف».',
    };
    return messages[language];
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
        ask_name: 'Could I have your name, please?',
        seller_terms:
          `Before we proceed, here are the key terms:
• Information you provide is preliminary and treated as confidential.
• We sign an agreement before formally starting work.
• Approved businesses may be listed on sharh.ae and promoted through SHARH channels to reach suitable buyers.
• We connect sellers with serious buyers from our network.
• ${SHARH_FEE_TERMS.en}

Do you agree and wish to proceed?`,
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
          `Перед началом основные условия:
• Предоставленная информация является предварительной и обрабатывается конфиденциально.
• До официального начала работы мы подписываем договор.
• Одобренный бизнес может быть размещён на sharh.ae и продвигаться через каналы SHARH для поиска подходящих покупателей.
• Мы связываем продавцов с серьёзными покупателями из нашей сети.
• ${SHARH_FEE_TERMS.ru}

Вы согласны и хотите продолжить?`,
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
          `قبل البدء، هذه هي الشروط الأساسية:
• المعلومات المقدمة أولية ويتم التعامل معها بسرية.
• نوقع اتفاقية قبل بدء العمل رسمياً.
• يمكن إدراج المشروع المعتمد على sharh.ae والترويج له عبر قنوات SHARH للوصول إلى مشترين مناسبين.
• نربط البائعين بمشترين جادين من شبكتنا.
• ${SHARH_FEE_TERMS.ar}

هل توافق وترغب في المتابعة؟`,
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
