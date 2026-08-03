import {
  ObjectionTopic,
  SalesLanguage,
  SalesPlaybook,
  SHARH_SALES_V1,
} from '../playbooks/sharh-sales.v1';

const PLAYBOOKS: Record<string, SalesPlaybook> = {
  'sharh-sales-v1': SHARH_SALES_V1,
  '1.0.0': SHARH_SALES_V1,
};

export class SalesPlaybookService {
  private readonly playbook: SalesPlaybook;

  constructor(version: string = 'sharh-sales-v1') {
    const selected = PLAYBOOKS[version];
    if (!selected) {
      throw new Error(`Unsupported SALES_PLAYBOOK_VERSION: ${version}`);
    }
    this.playbook = selected;
  }

  getVersion(): string {
    return this.playbook.version;
  }

  getId(): string {
    return this.playbook.id;
  }

  getModelInstructions(): string {
    return [
      `SALES PLAYBOOK: ${this.playbook.id}@${this.playbook.version}`,
      ...this.playbook.modelInstructions.map(item => `- ${item}`),
    ].join('\n');
  }

  detectObjection(value: string): ObjectionTopic | undefined {
    for (const [topic, play] of Object.entries(this.playbook.objections) as Array<
      [ObjectionTopic, SalesPlaybook['objections'][ObjectionTopic]]
    >) {
      if (play.patterns.some(pattern => pattern.test(value))) {
        return topic;
      }
    }
    return undefined;
  }

  objectionResponse(language: SalesLanguage, topic: ObjectionTopic): string {
    const play = this.playbook.objections[topic];
    return `${play.acknowledge[language]} ${play.explanation[language]}`;
  }

  getForbiddenClaims(): RegExp[] {
    return [...this.playbook.forbiddenClaims];
  }

  getScoringThresholds(): SalesPlaybook['scoring'] {
    return { ...this.playbook.scoring };
  }
}

export type { ObjectionTopic, SalesLanguage };
