export interface Approval {
  actor: string;
  conversation: string;
  scope: string;
}
export interface Card {
  id: string;
  projectUri: string;
  title: string;
  scope: string;
  locked?: boolean;
  kind: 'task' | 'report';
  approval?: Approval;
  dependencies: string[];
}
export interface Config {
  root: string;
  repo: string;
  server: string;
  approvers: string[];
  /** Fixture only: delay makes interruption reproducible. */
  stepDelayMs?: number;
}
export interface Owner { server: string; epoch: string }
export interface Assignment {
  id: string;
  card: Card;
  owner: Owner;
  worktree: string;
  port: number;
  token: string;
  nativeHandle: string;
}
export interface Checkpoint {
  phase: 'in-progress' | 'in-validation';
  completed: string[];
  revision: string;
  summary: string;
  attempt: number;
  workerPid: number;
  outcome: 'running' | 'completed' | 'interrupted' | 'fenced';
}
export type Observation = 'active' | 'absent' | 'unknown';
export interface ProjectSource {
  readCard(id: string): Promise<Card>;
  readOwner(projectUri: string): Promise<Owner>;
}
