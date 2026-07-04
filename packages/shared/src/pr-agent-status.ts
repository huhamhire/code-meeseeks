export type PrAgentStrategy = 'embedded' | 'local-cli';

export interface PrAgentAvailable {
  available: true;
  strategy: PrAgentStrategy;
  /** Version/help first line returned by the probe command, not necessarily well-formed */
  version: string;
  /** Probe duration (ms) */
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
