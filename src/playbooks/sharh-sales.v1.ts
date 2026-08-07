export type SalesLanguage = 'en' | 'ru' | 'ar';

export const SHARH_FEE_TERMS: Record<SalesLanguage, string> = {
  en: 'Our fee is success-based only and is paid when the sale completes: 5% for deals above USD 200,000 and a flat USD 10,000 for anything below USD 200,000.',
  ru: 'Наша комиссия выплачивается только после успешного завершения сделки: 5% для сделок свыше 200 000 USD и фиксированные 10 000 USD для сделок ниже 200 000 USD.',
  ar: 'تُدفع رسومنا فقط عند إتمام الصفقة: 5% للصفقات التي تتجاوز 200,000 دولار، ومبلغ ثابت قدره 10,000 دولار للصفقات الأقل من 200,000 دولار.',
};

export type ObjectionTopic =
  | 'commission'
  | 'confidentiality'
  | 'registration'
  | 'valuation'
  | 'timeline'
  | 'buyer_quality'
  | 'exclusivity'
  | 'documents';

export interface ObjectionPlay {
  patterns: RegExp[];
  acknowledge: Record<SalesLanguage, string>;
  explanation: Record<SalesLanguage, string>;
  clarification?: Record<SalesLanguage, string>;
}

export interface SalesPlaybook {
  id: string;
  version: string;
  effectiveFrom: string;
  modelInstructions: string[];
  forbiddenClaims: RegExp[];
  objections: Record<ObjectionTopic, ObjectionPlay>;
  scoring: {
    hotThreshold: number;
    warmThreshold: number;
    nurtureThreshold: number;
  };
}

export const SHARH_SALES_V1: SalesPlaybook = {
  id: 'sharh-sales',
  version: '1.0.0',
  effectiveFrom: '2026-08-03',
  modelInstructions: [
    'The application owns the funnel, scoring, next action, and SHARH record updates. Never override them.',
    'Acknowledge a concern, give only approved factual information, and use one low-friction next step.',
    'Do not claim that a buyer exists, that a sale is guaranteed, or that a valuation is final.',
    'Do not pressure the client, create false urgency, or require registration before value is provided.',
    'Never expose confidential seller data or infer fields not present in server-approved context.',
    'Keep WhatsApp replies concise and ask at most one question.',
  ],
  forbiddenClaims: [
    /\bguarantee(?:d)?\s+(?:a\s+)?(?:sale|buyer|valuation|price|closing)\b/i,
    /\b(?:we\s+)?(?:already\s+)?have\s+(?:a\s+)?buyer\b/i,
    /\bwill\s+(?:definitely|certainly)\s+(?:sell|close|find)\b/i,
    /\bfinal\s+valuation\b/i,
    /\bno\s+risk\b/i,
    /\bact\s+now\b/i,
    /\blimited\s+time\b/i,
    /гарантирован(?:ная|ный|о)\s+(?:продажа|покупатель|оценка)/iu,
    /у\s+нас\s+уже\s+есть\s+покупатель/iu,
    /مضمون(?:ة)?\s+(?:البيع|المشتري|التقييم)/iu,
  ],
  objections: {
    commission: {
      patterns: [
        /\b(?:commission|broker(?:age)? fee|success fee|service fee|your fee|sharh fee|fees?|charges?)\b/i,
        /комисси|вознагражден/iu,
        /عمولة|رسوم/u,
      ],
      acknowledge: {
        en: 'That is a reasonable point to clarify.',
        ru: 'Это разумный вопрос, который стоит уточнить.',
        ar: 'هذه نقطة منطقية وتستحق التوضيح.',
      },
      explanation: {
        en: SHARH_FEE_TERMS.en,
        ru: SHARH_FEE_TERMS.ru,
        ar: SHARH_FEE_TERMS.ar,
      },
    },
    confidentiality: {
      patterns: [
        /confidential|privacy|employee.*know|staff.*know/i,
        /конфиденц|сотрудник.*узна|персонал.*узна/iu,
        /سرية|خصوصية|الموظف.*يعرف/u,
      ],
      acknowledge: {
        en: 'Protecting the business and staff is a valid concern.',
        ru: 'Защита бизнеса и сотрудников — обоснованная забота.',
        ar: 'حماية المشروع والموظفين مصدر قلق مشروع.',
      },
      explanation: {
        en: 'Sensitive information is not intended for public disclosure, and detailed access is handled through the agreed confidentiality and access process.',
        ru: 'Чувствительные данные не предназначены для публичного раскрытия, а детальный доступ предоставляется по согласованной процедуре конфиденциальности.',
        ar: 'لا تُعرض المعلومات الحساسة للعامة، ويتم الوصول التفصيلي وفق إجراءات السرية والوصول المتفق عليها.',
      },
    },
    registration: {
      patterns: [
        /register|sign up|account/i,
        /регистрац|аккаунт/iu,
        /حساب|تسجيل/u,
      ],
      acknowledge: {
        en: 'You can start without creating an account.',
        ru: 'Начать можно без создания аккаунта.',
        ar: 'يمكنك البدء دون إنشاء حساب.',
      },
      explanation: {
        en: 'Registration is optional later and is used to track enquiries, documents, and deal progress.',
        ru: 'Регистрация предлагается позже и нужна для отслеживания запросов, документов и прогресса сделки.',
        ar: 'التسجيل اختياري لاحقاً ويُستخدم لمتابعة الاستفسارات والمستندات وتقدم الصفقة.',
      },
    },
    valuation: {
      patterns: [
        /valuation|worth|how much.*worth/i,
        /оценк|сколько стоит/iu,
        /تقييم|قيمة/u,
      ],
      acknowledge: {
        en: 'Price expectations are important to establish early.',
        ru: 'Ценовые ожидания важно определить заранее.',
        ar: 'من المهم تحديد توقعات السعر في وقت مبكر.',
      },
      explanation: {
        en: 'A reliable valuation requires verified financial and operating information. The bot cannot confirm a final value.',
        ru: 'Надёжная оценка требует подтверждённых финансовых и операционных данных. Бот не подтверждает итоговую стоимость.',
        ar: 'يتطلب التقييم الموثوق معلومات مالية وتشغيلية موثقة، ولا يؤكد البوت قيمة نهائية.',
      },
    },
    timeline: {
      patterns: [
        /how long|timeline|when.*sell|fast.*sell/i,
        /срок|как долго|когда.*прод/iu,
        /المدة|كم يستغرق|متى.*بيع/u,
      ],
      acknowledge: {
        en: 'Timing is usually one of the key transaction constraints.',
        ru: 'Срок обычно является одним из ключевых условий сделки.',
        ar: 'المدة عادةً من أهم قيود الصفقة.',
      },
      explanation: {
        en: 'Timing depends on readiness, buyer fit, documentation, and due diligence, so a fixed completion date should not be promised.',
        ru: 'Срок зависит от готовности бизнеса, соответствия покупателя, документов и проверки, поэтому фиксированную дату обещать нельзя.',
        ar: 'تعتمد المدة على جاهزية المشروع وملاءمة المشتري والمستندات والعناية الواجبة، لذلك لا يمكن وعد العميل بتاريخ ثابت.',
      },
    },
    buyer_quality: {
      patterns: [
        /serious buyer|qualified buyer|time waster/i,
        /серьезн.*покупател|реальн.*покупател|пуст.*интерес/iu,
        /مشتري.*جاد|مشتري.*مؤهل/u,
      ],
      acknowledge: {
        en: 'Avoiding unqualified enquiries is a legitimate concern.',
        ru: 'Отсев неквалифицированных запросов — обоснованное требование.',
        ar: 'تجنب الاستفسارات غير المؤهلة مطلب مشروع.',
      },
      explanation: {
        en: 'Buyer identity, intent, budget, funding position, and access purpose should be recorded before confidential information is considered.',
        ru: 'До рассмотрения доступа к конфиденциальным данным необходимо зафиксировать личность покупателя, цель, бюджет, финансирование и назначение доступа.',
        ar: 'يجب تسجيل هوية المشتري وهدفه وميزانيته ووضع التمويل وغرض الوصول قبل النظر في مشاركة المعلومات السرية.',
      },
    },
    exclusivity: {
      patterns: [
        /exclusive|exclusivity|sole agent/i,
        /эксклюзив|исключительн/iu,
        /حصري|حصرية/u,
      ],
      acknowledge: {
        en: 'Exclusivity should be clear before any engagement begins.',
        ru: 'Условия эксклюзивности должны быть понятны до начала работы.',
        ar: 'يجب توضيح شروط الحصرية قبل بدء العمل.',
      },
      explanation: {
        en: 'The applicable agreement must confirm the exact scope, duration, and termination terms; the bot should not invent them.',
        ru: 'Точные рамки, срок и условия прекращения должны быть подтверждены договором и менеджером; бот их не придумывает.',
        ar: 'يجب أن يؤكد العقد والمدير النطاق والمدة وشروط الإنهاء بدقة، ولا يخمنها البوت.',
      },
    },
    documents: {
      patterns: [
        /what documents|documents required|paperwork/i,
        /какие документ|нужн.*документ/iu,
        /ما.*المستندات|المستندات المطلوبة/u,
      ],
      acknowledge: {
        en: 'Document readiness has a direct effect on the process.',
        ru: 'Готовность документов напрямую влияет на процесс.',
        ar: 'جاهزية المستندات تؤثر مباشرةً في سير العملية.',
      },
      explanation: {
        en: 'The exact checklist depends on the business and transaction stage. The SHARH team will confirm the required financial, licence, lease, ownership, and operational evidence.',
        ru: 'Точный перечень зависит от бизнеса и этапа сделки. Менеджер подтвердит необходимые финансовые, лицензионные, арендные, корпоративные и операционные документы.',
        ar: 'تعتمد القائمة الدقيقة على المشروع ومرحلة الصفقة، وسيؤكد المدير المستندات المالية والتراخيص والإيجار والملكية والأدلة التشغيلية المطلوبة.',
      },
    },
  },
  scoring: {
    hotThreshold: 80,
    warmThreshold: 65,
    nurtureThreshold: 45,
  },
};
