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
  'escalation_reason',
  'client_name',
  'client_phone',
  'inquiry_purpose',
  'annual_revenue_aed',
  'business_type',
  'desired_selling_price_aed',
  'fields_updated',
  'latest_message',
  'notes',
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
      case 'escalation_reason':
        return this.normalizeCell(record.escalationReason);
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
      case 'what_is_your_approximate_annual_revenue_aed':
      case 'annual_revenue':
      case 'annual_revenue_aed':
        return this.normalizeCell(record.annualRevenueAed);
      case 'what_type_of_business_do_you_own':
      case 'business_type':
      case 'sector':
        return this.normalizeCell(record.businessType);
      case 'what_is_your_desired_selling_price_aed':
      case 'desired_selling_price':
      case 'desired_selling_price_aed':
      case 'expected_price':
      case 'budget':
        return this.normalizeCell(record.desiredSellingPriceAed);
      case 'fields_updated':
        return this.normalizeCell(record.fieldsUpdated);
      case 'latest_message':
      case 'message':
        return this.normalizeCell(record.latestMessage);
      case 'notes':
      case 'comment':
        return this.normalizeCell(record.notes || record.latestMessage);
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
      record.escalationReason,
      record.clientName,
      record.clientPhone,
      record.inquiryPurpose,
      record.annualRevenueAed,
      record.businessType,
      record.desiredSellingPriceAed,
      record.fieldsUpdated,
      record.latestMessage,
      record.notes,
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
