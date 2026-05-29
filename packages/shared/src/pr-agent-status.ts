export type PrAgentStrategy = 'local-cli' | 'docker';

export interface PrAgentAvailable {
  available: true;
  strategy: PrAgentStrategy;
  /** 探测命令返回的版本/帮助首行，未必规范 */
  version: string;
  /** 探测耗时（ms） */
  probeMs: number;
}

export interface PrAgentUnavailable {
  available: false;
  attempts: Array<{
    strategy: PrAgentStrategy;
    error: string;
    probeMs: number;
  }>;
}

export type PrAgentStatus = PrAgentAvailable | PrAgentUnavailable;
