import {
  AIResponse,
  WhatsAppMessage,
  AIServiceConfig,
  BotRole,
} from '../types';
import { logger } from '../utils/logger';
import { NeonReadService } from './neon-read.service';

// Only import OpenAI if needed (optional dependency loaded lazily).
let OpenAI: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  OpenAI = require('openai').default;
} catch {
  // openai package is optional; ignored when not installed.
}

/** Sharh lead-qualification playbook — primary agent prompt. */
const SALES_ROLE_PROMPT = `
РОЛЬ
Sharh, сфера услуг. Первая линия работы с входящими запросами по вопросам приобретения, продажи бизнеса в ОАЭ.

ЦЕЛЬ ДИАЛОГА
qualify_lead — быстро и качественно собрать данные для квалификации клиента и передать менеджеру.

ПРАВИЛА КОММУНИКАЦИИ
Профессиональный стиль (professional).
Отвечать только на английском языке.
Если клиент задаёт свой вопрос — кратко ответить, затем продолжить свои вопросы.
Если покупатель запрашивает информацию по конкретному объявлению, не задавать дополнительные вопросы для квалификации, а сразу передавать менеджеру.
Не подтверждать заказ или бронь.
Не называть финальную стоимость без данных.
Не брать на себя функции менеджера.
Не повторять вопросы уже заданные или полученные.
Не повторять или не дублировать сообщения и вопросы в рамках одного диалога.
Не дублировать одинаковые сообщения подряд — каждое сообщение должно быть отправлено только один раз.
Не собирать избыточные личные данные.
Если номер телефона уже получен от канала связи, не повторять запрос номера.
После сбора обязательных данных сразу передать менеджеру.
Не продолжать диалог после эскалации или передачи.
Не использовать emoji.
Эскалация живому менеджеру происходит только по явной просьбе клиента, проявлению агрессии, значительной срочности или по сложным вопросам. Не эскалировать без достаточной и чёткой причины.

ДАННЫЕ ДЛЯ СБОРА (CLIENTDATA)
client_name — имя клиента — required
client_phone — номер телефона — required (не спрашивать, если канал его передаёт)
inquiry_purpose — цель обращения — required (например, покупка или продажа бизнеса)

СТРУКТУРА ДИАЛОГА

ТИПЫ ПЕРВОГО СООБЩЕНИЯ (ВХОДЯЩИЕ СЦЕНАРИИ)
A) Брокер SHARH обсуждает лид — пример: "Hi, I'm a SHARH broker interested in discussing a lead: Business · UAE (Score 57/100)".
   Это сценарий, когда нужно обсудить/продать конкретный лид. Не проводить стандартную квалификацию покупателя или продавца.
   Кратко подтвердить получение, упомянуть лид и score (если есть), сразу передать менеджеру.

B) Продавец — пример: "I want to sell my business".
   Клиент уже обозначил цель продажи. Не спрашивать "покупка или продажа".
   После приветствия и имени сразу переходить к условиям продавца и блокам вопросов для продавца.

1. ПРИВЕТСТВИЕ
Добро пожаловать в Sharh. Помогаем покупателям и продавцам по всему ОАЭ с приобретением, продажей бизнеса.

2. ОБЯЗАТЕЛЬНО СПРОСИТЬ ИМЯ клиента до перехода к следующим вопросам. Если имя не получено — задать вопрос об имени и дождаться ответа.

3. СПРОСИТЬ и определить цель обращения клиента (продажа или покупка бизнеса)

4. ЕСЛИ клиент хочет продать бизнес, отправь наши условия:
- Вся переданная информация — предварительная и конфиденциальная.
- Мы гарантируем полную конфиденциальность ваших данных.
- Для дополнительной защиты мы подписываем контракт, чтобы обеспечить безопасность и сохранность всей переданной информации.
- Ваш бизнес будет размещён на нашем сайте sharh.ae.
- Мы продвигаем его через наши социальные сети и каналы, чтобы найти подходящих покупателей.
- Мы подключаем вас к серьёзным покупателям из нашей сети.
- Если клиент подтвердит, что хочет продать бизнес, объяснить условия комиссии: 2% с суммы сделки свыше 500,000 USD, фиксированная сумма 10,000 USD для сделок ниже.
- После согласования условий мы подписываем контракт перед началом работы.
Обязательно получи согласие продавца с нашими условиями.

Если клиент — продавец и согласен с условиями, задать обязательные вопросы двумя блоками:

Первый блок:
1. Чем занимается ваш бизнес? (краткое описание)
2. Эмират и район расположения
3. Годовой доход за последние 12 месяцев
4. Есть ли аренда? Если да, сколько осталось по контракту и размер арендной платы в месяц
5. Желаемая цена продажи или ожидаемый диапазон

После получения ответов на первый блок перейти к второму блоку вопросов.

Второй блок:
6. Год основания бизнеса
7. Число сотрудников
8. Ежемесячные операционные расходы
9. Ежемесячная чистая прибыль
10. Есть ли долги или обязательства?
11. Наличие действующих контрактов, лицензий или договоров с поставщиками
12. Причина продажи и срочность
13. Что входит в продажу и их стоимость? (оборудование, товарные запасы, бренд и т.д.)

5. Если клиент — покупатель задать вопросы:
Ваше имя
Сектор интереса (в какой сфере хотите купить бизнес)
Желательный бюджет или диапазон бюджета
Дополнительные комментарии или пожелания

Если покупатель запрашивает информацию по конкретному объявлению — не задавать дополнительные вопросы, а сразу передавать менеджеру.

После получения всех обязательных данных сразу передать их менеджеру.
Не продолжать диалог после эскалации или передачи.

ПРЕИМУЩЕСТВА КОМПАНИИ
1. Экспертиза по бизнес-операциям в ОАЭ.
2. Конфиденциальность и поддержка на всех этапах сделки.
3. Индивидуальный подход к каждому клиенту.

ПРАВИЛА ВЫЗОВА ФУНКЦИЙ
qualified_lead_handoff: запуск, когда все required clientData и обязательные данные из полного списка собраны. Передавать все clientData, escalation_reason="qualified_lead", optional additional_notes. Одновременно с финальным сообщением клиенту.
early_escalation: запуск при запросе живого менеджера, агрессии, срочности или сложном вопросе. Передавать минимум client_name ("не указано", если неизвестно), актуальные clientData, escalation_reason="early_escalation", additional_notes с точной причиной. Эскалация происходит только при подтверждённом условии. После этого не продолжать квалификацию.

СЛУЖЕБНЫЕ НАСТРОЙКИ
Таймзона: Asia/Dubai
Валюта: UAE Dirham
Максимальный приоритет — качество сбора данных и безопасность данных клиента.
`.trim();

const ROLE_PROMPTS: Record<BotRole, string> = {
  support: [
    'Role mode: Support specialist.',
    'Focus on troubleshooting, clear steps, and practical guidance.',
    'Ask clarifying questions before assumptions when details are missing.',
    'Keep answers calm, structured, and easy to follow.',
  ].join('\n'),
  sales: SALES_ROLE_PROMPT,
};

const COMMON_WORDS = new Set([
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'mine',
  'yours',
  'hers',
  'ours',
  'theirs',
  'a',
  'an',
  'if',
  'then',
  'else',
  'when',
  'from',
  'up',
  'about',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'among',
  'under',
  'over',
  'inside',
  'outside',
  'within',
  'without',
  'against',
  'toward',
  'towards',
  'upon',
  'across',
  'behind',
  'beneath',
  'beside',
  'beyond',
  'near',
  'off',
  'out',
  'past',
  'since',
  'throughout',
  'underneath',
  'until',
]);

/**
 * AI Service for generating intelligent responses (OpenAI or Gemini)
 */
export class AIService {
  private openai: any;
  private config: AIServiceConfig;
  private neonReadService: NeonReadService | null;

  constructor(
    config: AIServiceConfig,
    neonReadService: NeonReadService | null = null
  ) {
    this.config = config;
    this.neonReadService = neonReadService;
    if (config.provider === 'openai') {
      this.openai = new OpenAI({ apiKey: config.apiKey });
      logger.info('AI Service initialized with OpenAI');
    } else {
      logger.info('AI Service initialized with Gemini');
    }
  }

  /**
   * Generate AI response based on chat history
   */
  async generateResponse(
    message: string,
    chatHistory: WhatsAppMessage[],
    role: BotRole = 'support',
    leadContext?: string
  ): Promise<AIResponse> {
    if (this.config.provider === 'openai') {
      return this.generateOpenAIResponse(
        message,
        chatHistory,
        role,
        leadContext
      );
    } else {
      return this.generateGeminiResponse(
        message,
        chatHistory,
        role,
        leadContext
      );
    }
  }

  /**
   * Generate response using OpenAI
   */
  private async generateOpenAIResponse(
    message: string,
    chatHistory: WhatsAppMessage[],
    role: BotRole,
    leadContext?: string
  ): Promise<AIResponse> {
    const startTime = Date.now();
    logger.debug('Generating OpenAI response', {
      message,
      historyLength: chatHistory.length,
      role,
    });
    try {
      const salesKnowledgeContext = await this.buildSalesKnowledgeContext(
        role,
        message
      );
      const conversationContext = this.buildConversationContext(chatHistory);
      const userContent = this.buildUserMessageContent(
        message,
        salesKnowledgeContext,
        leadContext
      );
      const messages = [
        { role: 'system' as const, content: this.buildSystemPrompt(role) },
        ...conversationContext,
        {
          role: 'user' as const,
          content: userContent,
        },
      ];
      const completion = await this.createChatCompletion(messages);
      const aiMessage =
        completion.choices[0]?.message?.content ||
        'I apologize, but I cannot generate a response at the moment.';
      const response: AIResponse = {
        message: aiMessage,
        confidence: this.calculateConfidence(completion),
        context: this.extractContext(chatHistory),
        timestamp: Date.now(),
        role,
      };
      logger.info('OpenAI response generated', {
        processingTime: Date.now() - startTime,
      });
      return response;
    } catch (error) {
      logger.error('Error generating OpenAI response', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error(
        `Failed to generate OpenAI response: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Calls OpenAI chat completions while staying compatible with both legacy and
   * newer models. Newer models (e.g. gpt-5.x) reject `max_tokens` in favor of
   * `max_completion_tokens`, and some reject a custom `temperature`. We try the
   * most modern shape first and fall back only on HTTP 400 errors.
   */
  private async createChatCompletion(
    messages: Array<{ role: string; content: string }>
  ): Promise<any> {
    const base = { model: this.config.model, messages };
    const attempts: Array<Record<string, unknown>> = [
      {
        ...base,
        max_completion_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
      },
      { ...base, max_completion_tokens: this.config.maxTokens },
      {
        ...base,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
      },
      { ...base, max_tokens: this.config.maxTokens },
    ];

    let lastError: unknown;
    for (const params of attempts) {
      try {
        return await this.openai.chat.completions.create(params);
      } catch (error) {
        lastError = error;
        if (!this.isBadRequestError(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  /**
   * Detects HTTP 400 responses so we only retry on parameter-shape mismatches
   * (not on auth, rate-limit, or network failures).
   */
  private isBadRequestError(error: unknown): boolean {
    const status = (error as { status?: number; statusCode?: number })?.status;
    if (status === 400) {
      return true;
    }
    const statusCode = (error as { statusCode?: number })?.statusCode;
    if (statusCode === 400) {
      return true;
    }
    const message = error instanceof Error ? error.message : '';
    return message.includes('400') || message.includes('Unsupported parameter');
  }

  /**
   * Generate response using Gemini
   */
  private async generateGeminiResponse(
    message: string,
    chatHistory: WhatsAppMessage[],
    role: BotRole,
    leadContext?: string
  ): Promise<AIResponse> {
    const startTime = Date.now();
    logger.debug('Generating Gemini response', {
      message,
      historyLength: chatHistory.length,
      role,
    });
    try {
      const salesKnowledgeContext = await this.buildSalesKnowledgeContext(
        role,
        message
      );
      const context = this.buildConversationContext(chatHistory)
        .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`)
        .join('\n');
      const userContent = this.buildUserMessageContent(
        message,
        salesKnowledgeContext,
        leadContext
      );
      const prompt = `${this.buildSystemPrompt(role)}\n${context}\nUser: ${userContent}\nBot:`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;
      const body = {
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: this.config.temperature,
          maxOutputTokens: this.config.maxTokens,
        },
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Gemini API error', {
          status: response.status,
          errorText,
        });
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }
      const data: any = await response.json();
      const aiMessage =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        'I apologize, but I cannot generate a response at the moment.';
      const aiResponse: AIResponse = {
        message: aiMessage,
        confidence: 0.9, // Gemini does not provide a confidence score
        context: this.extractContext(chatHistory),
        timestamp: Date.now(),
        role,
      };
      logger.info('Gemini response generated', {
        processingTime: Date.now() - startTime,
      });
      return aiResponse;
    } catch (error) {
      logger.error('Error generating Gemini response', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error(
        `Failed to generate Gemini response: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private buildUserMessageContent(
    message: string,
    salesKnowledgeContext: string,
    leadContext?: string
  ): string {
    const parts = [message];

    if (leadContext) {
      parts.push(`Conversation scenario:\n${leadContext}`);
    }

    if (salesKnowledgeContext) {
      parts.push(
        `Use this read-only Neon lookup context if relevant:\n${salesKnowledgeContext}`
      );
    }

    return parts.join('\n\n');
  }

  /**
   * Build conversation context from chat history
   */
  private buildConversationContext(
    chatHistory: WhatsAppMessage[]
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const context: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Take last 10 messages for context (to avoid token limits)
    const recentHistory = chatHistory.slice(-10);

    for (const msg of recentHistory) {
      const role = this.getMessageRole(msg);
      const content = msg.content;

      if (content.trim()) {
        context.push({ role, content });
      }
    }

    return context;
  }

  /**
   * Calculate confidence score based on OpenAI response
   */
  private calculateConfidence(completion: any): number {
    // Simple confidence calculation based on finish_reason
    const finishReason = completion.choices[0]?.finish_reason;

    switch (finishReason) {
      case 'stop':
        return 0.9; // High confidence for complete responses
      case 'length':
        return 0.7; // Medium confidence for truncated responses
      case 'content_filter':
        return 0.5; // Lower confidence for filtered content
      default:
        return 0.6; // Default confidence
    }
  }

  /**
   * Extract relevant context from chat history
   */
  private extractContext(chatHistory: WhatsAppMessage[]): string[] {
    const topics = new Set<string>();

    // Extract key topics from recent messages
    const recentMessages = chatHistory.slice(-5);

    for (const msg of recentMessages) {
      const words = msg.content.toLowerCase().split(/\s+/);
      words.forEach(word => {
        if (word.length > 3 && !this.isCommonWord(word)) {
          topics.add(word);
        }
      });
    }

    return Array.from(topics).slice(0, 5); // Limit to 5 topics
  }

  /**
   * Check if word is a common word
   */
  private isCommonWord(word: string): boolean {
    return COMMON_WORDS.has(word);
  }

  /**
   * Build final system prompt by combining base and role prompts
   */
  private buildSystemPrompt(role: BotRole): string {
    // Sharh qualification playbook is the primary agent prompt (sales role).
    if (role === 'sales') {
      return ROLE_PROMPTS.sales;
    }

    // Support is an optional fallback mode for general assistance.
    return `${this.config.systemPrompt}\n\n${ROLE_PROMPTS.support}`;
  }

  /**
   * Resolve message role for conversation history
   */
  private getMessageRole(message: WhatsAppMessage): 'user' | 'assistant' {
    if (message.isFromBot === true) {
      return 'assistant';
    }

    if (message.isFromBot === false) {
      return 'user';
    }

    if (message.senderName?.toLowerCase() === 'ai assistant') {
      return 'assistant';
    }

    return 'user';
  }

  /**
   * Validate AI service configuration
   */
  validateConfig(): boolean {
    if (!this.config.apiKey) {
      logger.error(`${this.config.provider} API key is required`);
      return false;
    }

    if (!this.config.model) {
      logger.error(`${this.config.provider} model is required`);
      return false;
    }

    return true;
  }

  private async buildSalesKnowledgeContext(
    role: BotRole,
    message: string
  ): Promise<string> {
    if (role !== 'sales' || !this.neonReadService?.isEnabled()) {
      return '';
    }

    const rows = await this.neonReadService.searchListings(message);
    if (rows.length === 0) {
      return '';
    }

    const limitedRows = rows.slice(0, 3);
    const serializedRows = limitedRows
      .map((row, index) => `Result ${index + 1}: ${JSON.stringify(row)}`)
      .join('\n');

    logger.info('Attached Neon sales lookup context', {
      resultCount: rows.length,
    });
    return serializedRows;
  }

  /**
   * Test AI service connectivity
   */
  async testConnection(): Promise<boolean> {
    if (this.config.provider === 'openai') {
      try {
        await this.openai.models.list();
        logger.info('OpenAI service connection test successful');
        return true;
      } catch (error) {
        logger.error('OpenAI service connection test failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        return false;
      }
    } else {
      // For Gemini, just check if API key is set
      if (this.config.apiKey) {
        logger.info('Gemini service connection test (API key present)');
        return true;
      } else {
        logger.error('Gemini service connection test failed: API key missing');
        return false;
      }
    }
  }
}
