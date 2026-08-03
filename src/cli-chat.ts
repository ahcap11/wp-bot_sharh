import readline from 'readline';
import {
  getAIServiceConfig,
  getNeonSearchConfig,
  getAppConfig,
} from './config';
import { WhatsAppService } from './services/whatsapp.service';
import { WebSocketService } from './services/websocket.service';
import { AIService } from './services/ai.service';
import { ChatHistoryService } from './services/chat-history.service';
import { ChatbotService } from './services/chatbot.service';
import { NeonReadService } from './services/neon-read.service';
import { WhatsAppMessage, ConnectionStatus } from './types';
import { logger } from './utils/logger';

const TERMINAL_JID = 'terminal-user@s.whatsapp.net';

/**
 * Stdin-backed fake WhatsApp transport. Lets the real ChatbotService pipeline
 * run end-to-end in the terminal: messages are "received" via emit() and the
 * bot's replies are surfaced through the onReply callback.
 */
class TerminalWhatsAppService extends WhatsAppService {
  private messageHandler: ((message: WhatsAppMessage) => void) | null = null;

  constructor(private readonly onReply: (text: string) => void) {
    super();
  }

  override async initialize(): Promise<void> {
    // No real WhatsApp connection in terminal mode.
  }

  override onMessage(handler: (message: WhatsAppMessage) => void): void {
    this.messageHandler = handler;
  }

  override onConnectionStatusChange(
    _handler: (status: ConnectionStatus) => void
  ): void {
    // Not needed in terminal mode.
  }

  override isConnected(): boolean {
    return true;
  }

  override async sendMessage(
    _chatId: string,
    message: string
  ): Promise<boolean> {
    this.onReply(message);
    return true;
  }

  override async disconnect(): Promise<void> {
    // No-op.
  }

  emit(message: WhatsAppMessage): void {
    this.messageHandler?.(message);
  }
}

/**
 * WebSocket service that does nothing except notify when the pipeline reports
 * an error (so the REPL can unblock the prompt instead of hanging).
 */
class SilentWebSocketService extends WebSocketService {
  constructor(private readonly onError: () => void) {
    super(0);
  }

  override initialize(): void {}
  override close(): void {}
  override sendConnectionStatus(): void {}
  override sendMessageReceived(): void {}
  override sendMessageSent(): void {}
  override sendAIResponseGenerated(): void {}
  override sendError(): void {
    this.onError();
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // Keep the terminal readable: only surface warnings/errors from the app.
  logger.level = 'error';

  const appConfig = getAppConfig();
  const aiConfig = getAIServiceConfig();
  const neonConfig = getNeonSearchConfig();

  let releaseReply: (() => void) | null = null;
  const release = (): void => {
    if (releaseReply) {
      const fn = releaseReply;
      releaseReply = null;
      fn();
    }
  };

  const whatsapp = new TerminalWhatsAppService((text: string) => {
    process.stdout.write(`\n🤖 Bot: ${text}\n\n`);
    release();
  });
  const websocket = new SilentWebSocketService(() => {
    process.stdout.write('\n⚠️  (the bot could not generate a reply)\n\n');
    release();
  });

  const neon = new NeonReadService(neonConfig);
  const ai = new AIService(aiConfig, neon);
  const history = new ChatHistoryService(appConfig.maxHistoryLength);

  // Persistence and Google Sheets are intentionally disabled here so test
  // chatter does not pollute saved state or write rows to the sheet.
  const chatbot = new ChatbotService(
    whatsapp,
    ai,
    history,
    websocket,
    0,
    null,
    null
  );

  void chatbot;

  printBanner(aiConfig.provider, aiConfig.model, neonConfig.enabled);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Line queue so the REPL works identically for interactive TTY input and for
  // piped stdin (which closes on EOF after the last line).
  const lineQueue: string[] = [];
  let lineResolver: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on('line', input => {
    if (lineResolver) {
      const resolve = lineResolver;
      lineResolver = null;
      resolve(input);
    } else {
      lineQueue.push(input);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (lineResolver) {
      const resolve = lineResolver;
      lineResolver = null;
      resolve(null);
    }
  });

  const nextLine = (): Promise<string | null> => {
    const queued = lineQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (closed) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      lineResolver = resolve;
    });
  };

  let counter = 0;
  process.stdout.write('You: ');

  for (;;) {
    const raw = await nextLine();
    if (raw === null) {
      break;
    }

    const line = raw.trim();

    if (!line) {
      process.stdout.write('You: ');
      continue;
    }

    if (line === '/exit' || line === '/quit') {
      break;
    }

    if (line === '/help') {
      printHelp();
      process.stdout.write('You: ');
      continue;
    }

    counter += 1;
    const message: WhatsAppMessage = {
      id: `cli-${Date.now()}-${counter}`,
      from: TERMINAL_JID,
      to: TERMINAL_JID,
      timestamp: Date.now(),
      type: 'text',
      content: line,
      isGroup: false,
    };

    const replyArrived = new Promise<void>(resolve => {
      releaseReply = resolve;
    });

    whatsapp.emit(message);

    // Wait for the reply (or an error), with a safety timeout.
    await Promise.race([replyArrived, delay(30000)]);
    releaseReply = null;

    process.stdout.write('You: ');
  }

  rl.close();
  process.stdout.write('\n👋 Ending terminal chat.\n');

  // Open handles (Neon DB client, OpenAI keep-alive sockets) can keep the event
  // loop alive after the REPL ends, so exit explicitly.
  process.exit(0);
}

function printBanner(
  provider: string,
  model: string,
  neonEnabled: boolean
): void {
  process.stdout.write('\n' + '='.repeat(60) + '\n');
  process.stdout.write('💬 WhatsApp AI Agent — Terminal Test Chat\n');
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write(`AI provider : ${provider} (${model})\n`);
  process.stdout.write(
    `Neon search : ${neonEnabled ? 'enabled (sales role)' : 'disabled'}\n`
  );
  process.stdout.write('Default role: support\n');
  process.stdout.write('-'.repeat(60) + '\n');
  process.stdout.write('Tips: type "switch to sales" to enter sales mode,\n');
  process.stdout.write('      then ask e.g. "show me vegan F&B businesses".\n');
  process.stdout.write('Commands: /help, /exit\n');
  process.stdout.write('='.repeat(60) + '\n\n');
}

function printHelp(): void {
  process.stdout.write('\nCommands:\n');
  process.stdout.write('  /help            Show this help\n');
  process.stdout.write('  /exit, /quit     End the chat\n');
  process.stdout.write('\nRole switching (handled by the bot):\n');
  process.stdout.write(
    '  "switch to sales"    Enter sales mode (Neon listing search)\n'
  );
  process.stdout.write('  "switch to support"  Back to support mode\n\n');
}

main().catch(error => {
  process.stderr.write(
    `\n❌ Failed to start terminal chat: ${
      error instanceof Error ? error.message : 'Unknown error'
    }\n`
  );
  process.stderr.write(
    'Hint: ensure your .env has a valid API key for the selected AI_PROVIDER.\n'
  );
  process.exit(1);
});
