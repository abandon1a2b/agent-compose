/** Execution contracts contain no business resource identifiers or transport details. */
export type ExecutionResult = { message: string; [key: string]: unknown };
export type ExecutionTarget = { label: string; simulated?: boolean };
export interface TaskExecutor {
  target?: ExecutionTarget;
  /** Code-registered capability; configuration cannot lower this requirement. */
  requiresConfirmation?: (taskType: string) => boolean;
  execute(
    taskType: string,
    input: import("./presets.ts").Draft,
    actor: { id: string; name: string },
    idempotencyKey: string,
  ): Promise<ExecutionResult>;
}
