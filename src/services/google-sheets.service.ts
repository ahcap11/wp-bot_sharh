import fs from 'fs/promises';
import {
  sheets as createSheetsClient,
  sheets_v4,
  auth as googleAuth,
} from '@googleapis/sheets';
import { GoogleSheetsConfig } from '../types';
import { logger } from '../utils/logger';
import { LeadCaptureRecord } from './lead-capture.service';

const GOOGLE_SHEETS_SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];

const SHEET_HEADERS = [
  'timestamp',
  'chat_id',
  'source_jid',
  'is_group',
  'status',
  'funnel_stage',
  'owner',
  'escalation_reason',
  'language',
  'client_name',
  'client_phone',
  'inquiry_purpose',
  'specific_listing_code',
  'terms_accepted',
  'business_type',
  'business_location',
  'annual_revenue_aed',
  'lease_details',
  'desired_selling_price_aed',
  'year_established',
  'employee_count',
  'monthly_operating_expenses_aed',
  'monthly_net_profit_aed',
  'liabilities',
  'contracts_licenses',
  'sale_reason_urgency',
  'included_assets',
  'buyer_budget_aed',
  'buyer_location',
  'buyer_timeline',
  'buyer_involvement',
  'buyer_funding_status',
  'buyer_additional_comments',
  'completion_percent',
  'next_field',
  'fields_updated',
  'latest_message',
  'notes',
  'playbook_version',
  'lead_score',
  'lead_grade',
  'lead_temperature',
  'score_reasons',
  'risk_flags',
  'next_best_action',
  'next_best_action_code',
  'objections_detected',
  'conversation_summary',
  'manager_brief',
];

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/**
 * Google Sheets writer for structured lead snapshots.
 */
export class GoogleSheetsService {
  private sheetsClient: sheets_v4.Sheets | null = null;
  private initialized: boolean = false;
  private initializationAttempted: boolean = false;

  constructor(private readonly config: GoogleSheetsConfig) {}

  /**
   * Initialize Google Sheets client.
   */
  async initialize(): Promise<void> {
    if (this.initializationAttempted) {
      return;
    }

    this.initializationAttempted = true;

    if (!this.config.enabled) {
      logger.info('Google Sheets integration is disabled');
      return;
    }

    if (!this.config.spreadsheetId) {
      logger.warn(
        'Google Sheets integration enabled but spreadsheet id is missing'
      );
      return;
    }

    const credentials = await this.loadCredentials();
    if (!credentials) {
      logger.warn(
        'Google Sheets integration enabled but valid credentials were not found'
      );
      return;
    }

    const authClient = new googleAuth.GoogleAuth({
      credentials,
      scopes: GOOGLE_SHEETS_SCOPE,
    });

    this.sheetsClient = createSheetsClient({ version: 'v4', auth: authClient });

    try {
      await this.ensureSheetAndHeaders();
      this.initialized = true;
      logger.info('Google Sheets integration initialized', {
        sheetName: this.config.sheetName,
      });
    } catch (error) {
      this.initialized = false;
      this.sheetsClient = null;
      logger.error('Failed to initialize Google Sheets integration', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Append lead data row to the sheet.
   */
  async appendLeadRecord(record: LeadCaptureRecord): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.sheetsClient || !this.initialized) {
      return false;
    }

    try {
      const header = await this.getHeaderRow();
      const row = this.buildRowForHeader(record, header);

      await this.sheetsClient.spreadsheets.values.append({
        spreadsheetId: this.config.spreadsheetId,
        range: this.sheetRange('A1'),
        valueInputOption: 'RAW',
        requestBody: {
          values: [row],
        },
      });

      return true;
    } catch (error) {
      logger.error('Failed to append lead record to Google Sheets', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  private async ensureSheetAndHeaders(): Promise<void> {
    if (!this.sheetsClient) {
      return;
    }

    const spreadsheet = await this.sheetsClient.spreadsheets.get({
      spreadsheetId: this.config.spreadsheetId,
      fields: 'sheets(properties(title))',
    });

    const sheets = spreadsheet.data.sheets || [];
    const sheetExists = sheets.some(
      sheet => sheet.properties?.title === this.config.sheetName
    );

    if (!sheetExists) {
      await this.sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: this.config.sheetName,
                },
              },
            },
          ],
        },
      });
    }

    const headerResponse = await this.sheetsClient.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: this.sheetRange('1:1'),
    });

    const existingHeader = headerResponse.data.values?.[0] || [];
    if (existingHeader.length > 0) {
      return;
    }

    await this.sheetsClient.spreadsheets.values.update({
      spreadsheetId: this.config.spreadsheetId,
      range: this.sheetRange('A1'),
      valueInputOption: 'RAW',
      requestBody: {
        values: [SHEET_HEADERS],
      },
    });
  }

  private async getHeaderRow(): Promise<string[]> {
    if (!this.sheetsClient) {
      return [];
    }

    try {
      const response = await this.sheetsClient.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: this.sheetRange('1:1'),
      });

      const row = response.data.values?.[0] || [];
      return row.map(cell => this.normalizeCell(String(cell)));
    } catch (error) {
      logger.warn(
        'Failed to read Google Sheets header row; using default schema',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );
      return [];
    }
  }

  private buildRowForHeader(
    record: LeadCaptureRecord,
    header: string[]
  ): string[] {
    if (header.length === 0) {
      return this.defaultRow(record);
    }

    return header.map(headerCell =>
      this.resolveHeaderValue(headerCell, record)
    );
  }

  private resolveHeaderValue(
    headerCell: string,
    record: LeadCaptureRecord
  ): string {
    const key = this.normalizeHeaderKey(headerCell);

    switch (key) {
      case 'timestamp':
      case 'created_time':
        return this.normalizeCell(record.timestamp);
      case 'id':
        return this.normalizeCell(this.buildLeadId(record));
      case 'chat_id':
        return this.normalizeCell(record.chatId);
      case 'source_jid':
        return this.normalizeCell(record.sourceJid);
      case 'is_group':
        return this.normalizeCell(String(record.isGroup));
      case 'is_organic':
        return 'true';
      case 'platform':
        return 'whatsapp';
      case 'ad_id':
        return this.buildSourceTag(record, 'ad');
      case 'ad_name':
        return this.buildSourceTag(record, 'whatsapp_inbound');
      case 'adset_id':
        return this.buildSourceTag(record, 'adset');
      case 'adset_name':
        return this.buildSourceTag(record, 'whatsapp_adset');
      case 'campaign_id':
        return this.buildSourceTag(record, 'campaign');
      case 'campaign_name':
        return 'WhatsApp Inbound Leads';
      case 'form_id':
        return this.buildSourceTag(record, 'form');
      case 'form_name':
        return 'whatsapp_qualification_form';
      case 'status':
      case 'lead_status':
        return this.normalizeCell(record.status);
      case 'funnel_stage':
      case 'stage':
        return this.normalizeCell(record.funnelStage);
      case 'owner':
      case 'conversation_owner':
        return this.normalizeCell(record.owner);
      case 'escalation_reason':
        return this.normalizeCell(record.escalationReason);
      case 'language':
        return this.normalizeCell(record.language);
      case 'client_name':
      case 'full_name':
      case 'name':
        return this.normalizeCell(record.clientName);
      case 'client_phone':
      case 'phone_number':
      case 'phone':
      case 'whatsapp_number':
        return this.normalizeCell(record.clientPhone);
      case 'inquiry_purpose':
      case 'purpose':
        return this.normalizeCell(record.inquiryPurpose);
      case 'specific_listing_code':
      case 'listing_code':
        return this.normalizeCell(record.specificListingCode);
      case 'terms_accepted':
        return this.normalizeCell(record.termsAccepted);
      case 'what_is_your_approximate_annual_revenue_aed':
      case 'annual_revenue':
      case 'annual_revenue_aed':
        return this.normalizeCell(record.annualRevenueAed);
      case 'what_type_of_business_do_you_own':
      case 'business_type':
      case 'sector':
        return this.normalizeCell(record.businessType);
      case 'business_location':
        return this.normalizeCell(record.businessLocation);
      case 'lease_details':
        return this.normalizeCell(record.leaseDetails);
      case 'year_established':
        return this.normalizeCell(record.yearEstablished);
      case 'employee_count':
        return this.normalizeCell(record.employeeCount);
      case 'monthly_operating_expenses_aed':
      case 'monthly_opex_aed':
        return this.normalizeCell(record.monthlyOperatingExpensesAed);
      case 'monthly_net_profit_aed':
        return this.normalizeCell(record.monthlyNetProfitAed);
      case 'liabilities':
        return this.normalizeCell(record.liabilities);
      case 'contracts_licenses':
        return this.normalizeCell(record.contractsLicenses);
      case 'sale_reason_urgency':
        return this.normalizeCell(record.saleReasonUrgency);
      case 'included_assets':
        return this.normalizeCell(record.includedAssets);
      case 'what_is_your_desired_selling_price_aed':
      case 'desired_selling_price':
      case 'desired_selling_price_aed':
      case 'expected_price':
        return this.normalizeCell(record.desiredSellingPriceAed);
      case 'budget':
      case 'buyer_budget_aed':
        return this.normalizeCell(record.buyerBudgetAed);
      case 'buyer_location':
        return this.normalizeCell(record.buyerLocation);
      case 'buyer_timeline':
        return this.normalizeCell(record.buyerTimeline);
      case 'buyer_involvement':
        return this.normalizeCell(record.buyerInvolvement);
      case 'buyer_funding_status':
        return this.normalizeCell(record.buyerFundingStatus);
      case 'buyer_additional_comments':
        return this.normalizeCell(record.buyerAdditionalComments);
      case 'completion_percent':
        return this.normalizeCell(String(record.completionPercent));
      case 'next_field':
        return this.normalizeCell(record.nextField);
      case 'fields_updated':
        return this.normalizeCell(record.fieldsUpdated);
      case 'latest_message':
      case 'message':
        return this.normalizeCell(record.latestMessage);
      case 'notes':
      case 'comment':
        return this.normalizeCell(record.notes || record.latestMessage);
      case 'playbook_version':
        return this.normalizeCell(record.playbookVersion);
      case 'lead_score':
        return this.normalizeCell(String(record.leadScore));
      case 'lead_grade':
        return this.normalizeCell(record.leadGrade);
      case 'lead_temperature':
      case 'lead_priority':
        return this.normalizeCell(record.leadTemperature);
      case 'score_reasons':
        return this.normalizeCell(record.scoreReasons);
      case 'risk_flags':
        return this.normalizeCell(record.riskFlags);
      case 'next_best_action':
        return this.normalizeCell(record.nextBestAction);
      case 'next_best_action_code':
        return this.normalizeCell(record.nextBestActionCode);
      case 'objections_detected':
        return this.normalizeCell(record.objectionsDetected);
      case 'conversation_summary':
        return this.normalizeCell(record.conversationSummary);
      case 'manager_brief':
        return this.normalizeCell(record.managerBrief);
      default:
        return '';
    }
  }

  private normalizeHeaderKey(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
  }

  private buildLeadId(record: LeadCaptureRecord): string {
    const timestampPart = record.timestamp.replace(/[^0-9]/g, '').slice(0, 14);
    const chatPart = record.chatId.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
    return `wa-${timestampPart}-${chatPart}`.toLowerCase();
  }

  private buildSourceTag(record: LeadCaptureRecord, prefix: string): string {
    const chatPart = record.chatId
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-8)
      .toLowerCase();
    return `${prefix}_${chatPart || 'unknown'}`;
  }

  private defaultRow(record: LeadCaptureRecord): string[] {
    return [
      record.timestamp,
      record.chatId,
      record.sourceJid,
      String(record.isGroup),
      record.status,
      record.funnelStage,
      record.owner,
      record.escalationReason,
      record.language,
      record.clientName,
      record.clientPhone,
      record.inquiryPurpose,
      record.specificListingCode,
      record.termsAccepted,
      record.businessType,
      record.businessLocation,
      record.annualRevenueAed,
      record.leaseDetails,
      record.desiredSellingPriceAed,
      record.yearEstablished,
      record.employeeCount,
      record.monthlyOperatingExpensesAed,
      record.monthlyNetProfitAed,
      record.liabilities,
      record.contractsLicenses,
      record.saleReasonUrgency,
      record.includedAssets,
      record.buyerBudgetAed,
      record.buyerLocation,
      record.buyerTimeline,
      record.buyerInvolvement,
      record.buyerFundingStatus,
      record.buyerAdditionalComments,
      String(record.completionPercent),
      record.nextField,
      record.fieldsUpdated,
      record.latestMessage,
      record.notes,
      record.playbookVersion,
      String(record.leadScore),
      record.leadGrade,
      record.leadTemperature,
      record.scoreReasons,
      record.riskFlags,
      record.nextBestAction,
      record.nextBestActionCode,
      record.objectionsDetected,
      record.conversationSummary,
      record.managerBrief,
    ].map(cell => this.normalizeCell(cell));
  }

  private async loadCredentials(): Promise<ServiceAccountCredentials | null> {
    if (this.config.credentialsJson) {
      return this.parseCredentials(this.config.credentialsJson);
    }

    if (this.config.credentialsPath) {
      try {
        const content = await fs.readFile(this.config.credentialsPath, 'utf8');
        return this.parseCredentials(content);
      } catch (error) {
        logger.error('Failed to read Google Sheets credentials file', {
          error: error instanceof Error ? error.message : 'Unknown error',
          credentialsPath: this.config.credentialsPath,
        });
        return null;
      }
    }

    return null;
  }

  private parseCredentials(raw: string): ServiceAccountCredentials | null {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const clientEmail = parsed['client_email'];
      const privateKey = parsed['private_key'];

      if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
        return null;
      }

      return {
        client_email: clientEmail,
        private_key: privateKey.replace(/\\n/g, '\n'),
      };
    } catch {
      return null;
    }
  }

  private sheetRange(range: string): string {
    const escapedSheetName = this.config.sheetName.replace(/'/g, "''");
    return `'${escapedSheetName}'!${range}`;
  }

  private normalizeCell(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }
}
