import type { LeadField, ConversationLanguage } from './lead-capture.service';

export type SalesMessageClassification =
  | 'valid_answer'
  | 'multiple_answers'
  | 'question'
  | 'objection'
  | 'correction'
  | 'unknown'
  | 'off_topic'
  | 'nonsense'
  | 'abusive';

export type SalesConversationAction =
  | 'capture_answer'
  | 'answer_question'
  | 'clarify_current_question'
  | 'handle_objection'
  | 'correct_answer'
  | 'continue_funnel'
  | 'show_listings'
  | 'price_guidance'
  | 'redirect_scope'
  | 'none';

export type SalesQuestionType =
  | 'none'
  | 'price_guidance'
  | 'valuation'
  | 'commission'
  | 'confidentiality'
  | 'process'
  | 'listing'
  | 'documents'
  | 'other';

export interface SalesMessageInterpretation {
  classification: SalesMessageClassification;
  confidence: number;
  language: ConversationLanguage;
  fields: Partial<Record<LeadField, string>>;
  corrections: LeadField[];
  unknownFields: LeadField[];
  questionType: SalesQuestionType;
  reason: string;
  action?: SalesConversationAction | undefined;
  reply?: string | undefined;
  holdFunnel?: boolean | undefined;
}

export interface SalesMessageInterpretationInput {
  message: string;
  expectedField?: LeadField | undefined;
  language: ConversationLanguage;
  knownFacts: string;
  recentHistory: string[];
}
