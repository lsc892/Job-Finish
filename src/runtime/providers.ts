import type { Provider } from '../core/model';
import type { AgentProvider } from './agent-provider';
import { CodexEvents } from './codex/events';
import { ClaudeEvents } from './claude/events';

/** 기존 Codex·Claude 확장의 스트림만 관찰한다. */
export const agentProviders: Record<Provider, AgentProvider> = {
  codex: {
    id: 'codex',
    extensionId: 'openai.chatgpt',
    matchesProcess: args => args.includes('app-server'),
    createEvents: context => new CodexEvents(context),
  },
  claude: {
    id: 'claude',
    extensionId: 'anthropic.claude-code',
    matchesProcess: args => args.some((arg, i) => arg === '--output-format=stream-json'
      || arg === '--output-format' && args[i + 1] === 'stream-json'),
    createEvents: context => new ClaudeEvents(context),
  },
};
