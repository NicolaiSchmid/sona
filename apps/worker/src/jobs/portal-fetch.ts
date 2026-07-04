import type {
  PortalTask,
  PortalTaskRunner,
  RunPortalTaskInput,
  RunPortalTaskResult,
} from "@sona/agents";
import { requireWorkspaceContext, type WorkspaceContext } from "@sona/core";

export interface PortalFetchConnection {
  connectionId: string;
  workspaceId: string;
  task: PortalTask;
}

export interface PortalFetchConnectionRepository {
  getConnection(input: {
    context: WorkspaceContext;
    connectionId: string;
  }): Promise<PortalFetchConnection>;
}

export interface PortalFetchJobStateStore {
  acquire(input: {
    jobId: string;
    workspaceId: string;
    connectionId: string;
    now: string;
    cooldownUntil: string;
  }): Promise<PortalFetchJobReservation>;
}

export type PortalFetchJobReservation =
  | { status: "acquired"; cooldownUntil: string }
  | { status: "duplicate"; cooldownUntil: undefined }
  | { status: "cooldown"; cooldownUntil: string };

export interface RunPortalFetchJobInput {
  jobId: string;
  context: WorkspaceContext;
  connectionId: string;
  now: string;
  cooldownMs: number;
  runner: PortalTaskRunner;
  connections: PortalFetchConnectionRepository;
  state: PortalFetchJobStateStore;
}

export type PortalFetchJobStatus = "completed" | "duplicate" | "cooldown" | "failed";

export interface RunPortalFetchJobResult {
  status: PortalFetchJobStatus;
  connectionId: string;
  cooldownUntil: string | undefined;
  runResult: RunPortalTaskResult | undefined;
}

export async function runPortalFetchJob(
  input: RunPortalFetchJobInput,
): Promise<RunPortalFetchJobResult> {
  const context = requireWorkspaceContext(input.context);
  const connection = await input.connections.getConnection({
    context,
    connectionId: input.connectionId,
  });
  if (connection.workspaceId !== context.workspaceId) {
    return {
      status: "failed",
      connectionId: input.connectionId,
      cooldownUntil: undefined,
      runResult: undefined,
    };
  }
  const cooldownUntil = new Date(Date.parse(input.now) + input.cooldownMs).toISOString();
  const reservation = await input.state.acquire({
    jobId: input.jobId,
    workspaceId: context.workspaceId,
    connectionId: input.connectionId,
    now: input.now,
    cooldownUntil,
  });
  if (reservation.status !== "acquired") {
    return {
      status: reservation.status,
      connectionId: input.connectionId,
      cooldownUntil: reservation.cooldownUntil,
      runResult: undefined,
    };
  }

  const runInput: RunPortalTaskInput = {
    task: connection.task,
    connectionId: input.connectionId,
    runId: input.jobId,
    workspaceId: context.workspaceId,
    now: input.now,
  };
  let runResult: RunPortalTaskResult | undefined;
  try {
    runResult = await input.runner.runTask(runInput);
  } catch {
    return {
      status: "failed",
      connectionId: input.connectionId,
      cooldownUntil,
      runResult: undefined,
    };
  }

  return {
    status: runResult.status === "completed" ? "completed" : "failed",
    connectionId: input.connectionId,
    cooldownUntil,
    runResult,
  };
}

export class InMemoryPortalFetchConnectionRepository implements PortalFetchConnectionRepository {
  readonly #connections = new Map<string, PortalFetchConnection>();

  constructor(connections: readonly PortalFetchConnection[] = []) {
    for (const connection of connections) {
      this.#connections.set(
        connectionKey(connection.workspaceId, connection.connectionId),
        freezeConnection(connection),
      );
    }
  }

  async getConnection(input: {
    context: WorkspaceContext;
    connectionId: string;
  }): Promise<PortalFetchConnection> {
    const connection = this.#connections.get(
      connectionKey(input.context.workspaceId, input.connectionId),
    );
    if (connection === undefined) {
      throw new Error(`Portal fetch connection not found: ${input.connectionId}`);
    }
    return freezeConnection(connection);
  }
}

export class InMemoryPortalFetchJobStateStore implements PortalFetchJobStateStore {
  readonly #reservedJobIds = new Set<string>();
  readonly #cooldowns = new Map<string, string>();

  async acquire(input: {
    jobId: string;
    workspaceId: string;
    connectionId: string;
    now: string;
    cooldownUntil: string;
  }): Promise<PortalFetchJobReservation> {
    if (this.#reservedJobIds.has(input.jobId)) {
      return { status: "duplicate", cooldownUntil: undefined };
    }
    const key = connectionKey(input.workspaceId, input.connectionId);
    const existingCooldown = this.#cooldowns.get(key);
    if (existingCooldown !== undefined && Date.parse(existingCooldown) > Date.parse(input.now)) {
      return { status: "cooldown", cooldownUntil: existingCooldown };
    }
    this.#reservedJobIds.add(input.jobId);
    this.#cooldowns.set(key, input.cooldownUntil);
    return { status: "acquired", cooldownUntil: input.cooldownUntil };
  }
}

function connectionKey(workspaceId: string, connectionId: string): string {
  return `${workspaceId}:${connectionId}`;
}

function freezeConnection(connection: PortalFetchConnection): PortalFetchConnection {
  return Object.freeze({
    ...connection,
    task: {
      ...connection.task,
      domains: [...connection.task.domains],
      requires: [...connection.task.requires],
      allowedActions: [...connection.task.allowedActions],
      forbiddenActions: [...connection.task.forbiddenActions],
      outputs: [...connection.task.outputs],
      httpMethodExceptions: [...connection.task.httpMethodExceptions],
      steps: [...connection.task.steps],
    },
  });
}
