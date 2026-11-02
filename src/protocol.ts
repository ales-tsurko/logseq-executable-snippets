export const PROTOCOL = 2;
export const HEARTBEAT_MS = 3_000;
export const LEASE_TIMEOUT_MS = 15_000;
export const TESTED_LOGSEQ = ['2.0.2'];
export const SUPPORTED_LOGSEQ_MINOR = '2.0';
export interface Connection { helperUrl: string; helperToken: string }
export interface RuntimeConnection extends Connection {
  protocol: number; session: string; instance: string; pid: number;
}
