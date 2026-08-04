import type { ConversationSafetyConfig } from '../types';
import type { ConversationLanguage, LeadField } from './lead-capture.service';
import { PersistenceService } from './persistence.service';

const CHAT_USAGE_NAMESPACE = 'aiChatUsage';
const NUMBER_USAGE_NAMESPACE = 'aiNumberDailyUsage';

interface ChatUsageState {
  calls: number;
  offTopicStrikes: number;
  abuseStrikes: number;
  cooldownUntil: number;
  lastAiAt: number;
  lastActivityAt: number;
}

interface NumberDailyUsageState {
  day: string;
  calls: number;
}

export type SafetyBlockReason =
  | 'oversized'
  | 'prompt_injection'
  | 'off_topic'
  | 'abuse_cooldown'
  | 'ai_conversation_limit'
  | 'ai_daily_limit'
  | 'ai_throttled';

export interface SafetyScreenResult {
  allowed: boolean;
  reason?: SafetyBlockReason | undefined;
  response?: string | undefined;
  language: ConversationLanguage;
}

export interface AiAllowanceResult {
  allowed: boolean;
  reason?: SafetyBlockReason | undefined;
}

/**
 * Keeps the bot inside the SHARH transaction scope and prevents a client from
 * turning the WhatsApp number into an unrestricted or expensive general AI.
 */
export class ConversationSafetyService {
  private readonly config: ConversationSafetyConfig;
  private readonly persistence: PersistenceService | null;
  private readonly chats = new Map<string, ChatUsageState>();
  private readonly numbers = new Map<string, NumberDailyUsageState>();

  constructor(
    config: ConversationSafetyConfig,
    persistence: PersistenceService | null = null
  ) {
    this.config = config;
    this.persistence = persistence;
    this.hydrate();
  }

  screenMessage(
    chatId: string,
    content: string,
    fallbackLanguage: ConversationLanguage = 'en'
  ): SafetyScreenResult {
    const language = this.detectLanguage(content, fallbackLanguage);
    const now = Date.now();
    const state = this.getChatState(chatId, now);
    state.lastActivityAt = now;

    if (content.length > this.config.maxInputChars) {
      this.persistChat(chatId, state);
      return {
        allowed: false,
        reason: 'oversized',
        response: this.message(language, 'oversized'),
        language,
      };
    }

    if (state.cooldownUntil > now) {
      this.persistChat(chatId, state);
      return {
        allowed: false,
        reason: 'abuse_cooldown',
        response: this.message(language, 'cooldown'),
        language,
      };
    }

    if (
      this.looksLikePromptInjection(content) ||
      this.looksLikeAutomatedAbusePayload(content)
    ) {
      state.abuseStrikes += 1;
      if (state.abuseStrikes >= 2) {
        state.cooldownUntil = now + this.config.abuseCooldownMs;
      }
      this.persistChat(chatId, state);
      return {
        allowed: false,
        reason: 'prompt_injection',
        response:
          state.cooldownUntil > now
            ? this.message(language, 'cooldown')
            : this.message(language, 'scope'),
        language,
      };
    }

    if (this.isClearlyOffTopic(content)) {
      state.offTopicStrikes += 1;
      if (
        state.offTopicStrikes >= this.config.offTopicStrikesBeforeCooldown
      ) {
        state.cooldownUntil = now + this.config.abuseCooldownMs;
      }
      this.persistChat(chatId, state);
      return {
        allowed: false,
        reason: 'off_topic',
        response:
          state.cooldownUntil > now
            ? this.message(language, 'cooldown')
            : this.message(language, 'scope'),
        language,
      };
    }

    if (state.offTopicStrikes > 0) {
      state.offTopicStrikes = Math.max(0, state.offTopicStrikes - 1);
    }
    this.persistChat(chatId, state);
    return { allowed: true, language };
  }

  shouldUseAi(content: string, expectedField?: LeadField): boolean {
    if (!this.config.smartRoutingEnabled) return true;
    const text = content.trim();
    const lower = text.toLowerCase();

    if (!text) return false;
    if (this.isSimpleNavigationCommand(lower)) return false;
    if (this.isClearlyOffTopic(text) || this.looksLikePromptInjection(text)) {
      return false;
    }

    if (
      /\?|\b(?:why|what do you mean|can you explain|how does|how do|what is|what are|could you clarify|tell me more)\b/i.test(
        text
      ) ||
      /\b(?:почему|что вы имеете в виду|объясните|как это|что такое|уточните)\b/iu.test(
        text
      ) ||
      /(?:لماذا|ماذا تقصد|اشرح|كيف|ما هو|وضح)/u.test(text)
    ) {
      return true;
    }

    if (
      /\b(?:actually|correction|change|instead|I meant|not that|rather)\b/i.test(
        text
      ) ||
      /\b(?:на самом деле|исправ|измен|я имел|не это|вместо)\b/iu.test(text) ||
      /(?:في الواقع|تصحيح|غيّر|بدلاً من|أقصد)/u.test(text)
    ) {
      return true;
    }

    if (
      /\b(?:do not agree|don't agree|not comfortable|too high|too much|concern|problem|refuse|no because)\b/i.test(
        text
      ) ||
      /\b(?:не соглас|не устраива|слишком|беспокоит|проблема|отказываюсь)\b/iu.test(
        text
      ) ||
      /(?:لا أوافق|غير مرتاح|مرتفع جداً|مشكلة|أرفض)/u.test(text)
    ) {
      return true;
    }

    if (this.looksLikeMultiAnswer(text)) return true;

    return !this.isStraightforwardAnswer(text, expectedField);
  }

  reserveAiCall(chatId: string, sender: string): AiAllowanceResult {
    const now = Date.now();
    const chat = this.getChatState(chatId, now);
    const numberKey = this.normalizeSender(sender);
    const day = this.dayKey(now);
    const daily = this.numbers.get(numberKey) || { day, calls: 0 };
    if (daily.day !== day) {
      daily.day = day;
      daily.calls = 0;
    }

    if (chat.cooldownUntil > now) {
      return { allowed: false, reason: 'abuse_cooldown' };
    }
    if (chat.calls >= this.config.maxAiCallsPerConversation) {
      return { allowed: false, reason: 'ai_conversation_limit' };
    }
    if (daily.calls >= this.config.maxAiCallsPerNumberPerDay) {
      return { allowed: false, reason: 'ai_daily_limit' };
    }
    if (
      this.config.minAiIntervalMs > 0 &&
      chat.lastAiAt > 0 &&
      now - chat.lastAiAt < this.config.minAiIntervalMs
    ) {
      return { allowed: false, reason: 'ai_throttled' };
    }

    chat.calls += 1;
    chat.lastAiAt = now;
    chat.lastActivityAt = now;
    daily.calls += 1;
    this.numbers.set(numberKey, daily);
    this.persistChat(chatId, chat);
    this.persistence?.setItem(NUMBER_USAGE_NAMESPACE, numberKey, daily);
    return { allowed: true };
  }

  resetConversation(chatId: string): void {
    this.chats.delete(chatId);
    this.persistence?.removeItem(CHAT_USAGE_NAMESPACE, chatId);
  }

  aiLimitResponse(
    language: ConversationLanguage,
    reason?: SafetyBlockReason
  ): string {
    if (reason === 'abuse_cooldown') return this.message(language, 'cooldown');
    return this.message(language, 'ai_limit');
  }

  private hydrate(): void {
    if (!this.persistence) return;
    const chatRows = this.persistence.getNamespace<ChatUsageState>(
      CHAT_USAGE_NAMESPACE
    );
    for (const [key, value] of Object.entries(chatRows)) {
      if (value && typeof value.calls === 'number') this.chats.set(key, value);
    }
    const numberRows = this.persistence.getNamespace<NumberDailyUsageState>(
      NUMBER_USAGE_NAMESPACE
    );
    for (const [key, value] of Object.entries(numberRows)) {
      if (value && typeof value.calls === 'number') this.numbers.set(key, value);
    }
  }

  private getChatState(chatId: string, now: number): ChatUsageState {
    const existing = this.chats.get(chatId);
    if (
      existing &&
      now - existing.lastActivityAt <= this.config.conversationIdleResetMs
    ) {
      return existing;
    }
    const fresh: ChatUsageState = {
      calls: 0,
      offTopicStrikes: 0,
      abuseStrikes: 0,
      cooldownUntil: 0,
      lastAiAt: 0,
      lastActivityAt: now,
    };
    this.chats.set(chatId, fresh);
    return fresh;
  }

  private persistChat(chatId: string, state: ChatUsageState): void {
    this.chats.set(chatId, state);
    this.persistence?.setItem(CHAT_USAGE_NAMESPACE, chatId, state);
  }

  private isStraightforwardAnswer(
    content: string,
    expectedField?: LeadField
  ): boolean {
    const text = content.trim();
    const lower = text.toLowerCase();

    if (/^(?:yes|no|y|n|ok|okay|1|2|да|нет|نعم|لا)$/iu.test(lower)) {
      return true;
    }
    if (/^(?:unknown|not sure|skip|don't know|do not know|не знаю|пропустить|غير معروف|لا أعرف)$/iu.test(lower)) {
      return true;
    }
    if (/^\d{1,2}$/.test(lower)) return true;
    if (/\b(?:aed|usd|dirham|dhs|k|m|million|thousand|тыс|млн|درهم|مليون)\b/i.test(lower) && /\d/.test(lower)) {
      return true;
    }

    switch (expectedField) {
      case 'inquiry_purpose':
        return /\b(?:buy|buyer|purchase|sell|seller|продать|купить|покупка|продажа|شراء|بيع)\b/iu.test(
          lower
        );
      case 'client_name':
        return /^[\p{L}][\p{L}\s.'-]{0,79}$/u.test(text) && text.split(/\s+/).length <= 5;
      case 'seller_terms':
        return /^(?:yes|no|agree|accept|decline|1|2|да|нет|согласен|не согласен|نعم|لا|أوافق)$/iu.test(
          lower
        );
      case 'annual_revenue_aed':
      case 'monthly_operating_expenses_aed':
      case 'monthly_net_profit_aed':
      case 'desired_selling_price_aed':
      case 'buyer_budget_aed':
        return /\d/.test(lower) || /unknown|don't know|не знаю|غير معروف/iu.test(lower);
      case 'year_established':
        return /^(?:19|20)\d{2}$/.test(lower) || /unknown|не знаю|غير معروف/iu.test(lower);
      case 'employee_count':
        return /^\d{1,5}$/.test(lower) || /unknown|не знаю|غير معروف/iu.test(lower);
      default:
        return text.length <= 240 && !/[?!]/.test(text);
    }
  }

  private looksLikeMultiAnswer(content: string): boolean {
    const hits = [
      /revenue|выруч|إيراد/iu,
      /profit|прибыл|ربح/iu,
      /employee|сотруд|موظف/iu,
      /rent|lease|аренд|إيجار/iu,
      /budget|бюджет|ميزانية/iu,
      /location|dubai|abu dhabi|дубай|абу-даби|دبي|أبوظبي/iu,
    ].filter(pattern => pattern.test(content)).length;
    return hits >= 2;
  }

  private isSimpleNavigationCommand(content: string): boolean {
    return /^(?:back|go back|review|review answers|start over|restart|reset|stop|pause|resume|continue|switch to buy(?:ing)?|switch to sell(?:ing)?|назад|проверить ответы|начать заново|стоп|пауза|продолжить|الرجوع|مراجعة|ابدأ من جديد|توقف|تابع)$/iu.test(
      content.trim()
    );
  }

  private looksLikePromptInjection(content: string): boolean {
    return /(?:ignore (?:all |the )?(?:previous|above|system) instructions|reveal (?:the )?(?:system prompt|api key|secret)|show (?:me )?(?:your )?(?:prompt|instructions)|act as (?:an? )?(?:unrestricted|different) (?:assistant|model)|developer mode|jailbreak|do anything now|DAN\b|prompt injection|bypass (?:the )?(?:rules|safety)|игнорируй (?:все )?(?:предыдущие|системные) инструкции|покажи (?:системный промпт|ключ api|секрет)|تجاهل (?:كل )?التعليمات|أظهر (?:مفتاح|الأسرار|تعليمات النظام))/iu.test(
      content
    );
  }

  private looksLikeAutomatedAbusePayload(content: string): boolean {
    const urlCount = (content.match(/https?:\/\/|www\./gi) || []).length;
    if (urlCount >= 4) return true;
    if (/```[\s\S]{500,}```/u.test(content)) return true;
    if (/(?:[A-Za-z0-9+/]{400,}={0,2})/u.test(content.replace(/\s+/g, ''))) {
      return true;
    }
    if (/(.)\1{119,}/su.test(content)) return true;
    return false;
  }

  private isClearlyOffTopic(content: string): boolean {
    return /(?:\b(?:give|send|write|tell|show|teach) me (?:a |an |the )?(?:pancake|cake|pizza|food)?\s*recipe\b|\bhow (?:do|can) i (?:cook|make|bake)\b|\bwrite (?:me )?(?:code|a poem|an essay|homework)\b|\b(?:weather forecast|football score|sports score|horoscope)\b|\b(?:рецепт|как приготовить|напиши код|напиши стих|домашнее задание|прогноз погоды|счёт матча)\b|(?:وصفة|كيف أطبخ|اكتب كود|اكتب قصيدة|واجب منزلي|حالة الطقس|نتيجة المباراة))/iu.test(
      content
    );
  }

  private detectLanguage(
    content: string,
    fallback: ConversationLanguage
  ): ConversationLanguage {
    if (/\p{Script=Arabic}/u.test(content)) return 'ar';
    if (/\p{Script=Cyrillic}/u.test(content)) return 'ru';
    return fallback || 'en';
  }

  private normalizeSender(sender: string): string {
    return sender.replace(/@.+$/, '').replace(/\D/g, '') || sender;
  }

  private dayKey(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private message(
    language: ConversationLanguage,
    key: 'oversized' | 'scope' | 'cooldown' | 'ai_limit'
  ): string {
    const messages: Record<
      ConversationLanguage,
      Record<'oversized' | 'scope' | 'cooldown' | 'ai_limit', string>
    > = {
      en: {
        oversized:
          'That message is too long to process safely. Please send the relevant business details in a shorter message.',
        scope:
          'I can help only with buying or selling a business through SHARH in the UAE. You can continue your current request, review your answers, or start over.',
        cooldown:
          'This chat is temporarily paused because of repeated unrelated or unsafe requests. Please try again later with a SHARH business-buying or selling question.',
        ai_limit:
          'I can continue the SHARH process, but advanced AI assistance is temporarily limited. Straightforward answers, corrections, navigation, and listing searches still work.',
      },
      ru: {
        oversized:
          'Сообщение слишком длинное для безопасной обработки. Отправьте относящиеся к бизнесу данные более коротким сообщением.',
        scope:
          'Я могу помогать только с покупкой или продажей бизнеса через SHARH в ОАЭ. Вы можете продолжить текущий запрос, проверить ответы или начать заново.',
        cooldown:
          'Чат временно приостановлен из-за повторных посторонних или небезопасных запросов. Позже отправьте вопрос о покупке или продаже бизнеса через SHARH.',
        ai_limit:
          'Я могу продолжить процесс SHARH, но расширенная AI-помощь временно ограничена. Обычные ответы, исправления, навигация и поиск листингов продолжают работать.',
      },
      ar: {
        oversized:
          'الرسالة طويلة جداً للمعالجة الآمنة. أرسل تفاصيل المشروع ذات الصلة في رسالة أقصر.',
        scope:
          'يمكنني المساعدة فقط في شراء أو بيع مشروع عبر SHARH داخل الإمارات. يمكنك متابعة الطلب الحالي أو مراجعة الإجابات أو البدء من جديد.',
        cooldown:
          'تم إيقاف المحادثة مؤقتاً بسبب تكرار طلبات غير مرتبطة أو غير آمنة. حاول لاحقاً بسؤال يتعلق بشراء أو بيع مشروع عبر SHARH.',
        ai_limit:
          'يمكنني متابعة إجراءات SHARH، لكن المساعدة المتقدمة بالذكاء الاصطناعي محدودة مؤقتاً. ما زالت الإجابات المباشرة والتصحيحات والتنقل والبحث عن الإعلانات تعمل.',
      },
    };
    return messages[language][key];
  }
}
