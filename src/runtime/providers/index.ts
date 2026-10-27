import type { Provider } from '../../core/model';
import { AgentProviderRegistry } from '../agent-provider';
import { CodexProvider } from './codex';
import { ClaudeProvider } from './claude';

// Register each provider once; observation, execution and input handling use this list.
export const agentProviders = new AgentProviderRegistry([new CodexProvider(), new ClaudeProvider()]);
export function runtimeId(provider: Provider): string { return agentProviders.get(provider).runtimeId(); }
