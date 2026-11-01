// 기본 Claude·Codex 제공자를 등록하고 실행 환경 식별자를 조회한다.
import type { Provider } from '../core/model';
import { AgentProviderRegistry } from './agent-provider';
import { CodexProvider } from './codex/provider';
import { ClaudeProvider } from './claude/provider';

// Register each provider once; observation, execution and input handling use this list.
export const agentProviders = new AgentProviderRegistry([new CodexProvider(), new ClaudeProvider()]);
export function runtimeId(provider: Provider): string { return agentProviders.get(provider).runtimeId(); }
