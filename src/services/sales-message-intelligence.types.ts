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
}

export interface SalesMessageInterpretationInput {
  message: string;
  expectedField?: LeadField | undefined;
  language: ConversationLanguage;
  knownFacts: string;
  recentHistory: string[];
}
