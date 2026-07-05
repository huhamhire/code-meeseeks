/**
 * Agent orchestration domain: main-process wiring for the conversational Agent (manual review / free planning /
 * AutoPilot). Orchestrator is the outward capability entry; review / planning (the main-process runners for the
 * micro-flow and planning) + labels (i18n text injection) are in-domain collaborators, not exposed externally.
 */
export { Orchestrator } from './orchestrator.js';
