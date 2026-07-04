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
  hasCompleted(jobId: string): Promise<boolean>;
  markCompleted(jobId: string): Promise<void>;
  getCooldownUntil(input: {
    workspaceId: string;
    connectionId: string;
  }): Promise<string | undefined>;
  setCooldownUntil(input: {
    workspaceId: string;
    connectionId: string;
    cooldownUntil: string;
  }): Promise<void>;
}

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
  if (await input.state.hasCompleted(input.jobId)) {
    return {
      status: "duplicate",
      connectionId: input.connectionId,
      cooldownUntil: undefined,
      runResult: undefined,
    };
  }

  const existingCooldown = await input.state.getCooldownUntil({
    workspaceId: context.workspaceId,
    connectionId: input.connectionId,
  });
  if (existingCooldown !== undefined && Date.parse(existingCooldown) > Date.parse(input.now)) {
    return {
      status: "cooldown",
      connectionId: input.connectionId,
      cooldownUntil: existingCooldown,
      runResult: undefined,
    };
  }

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

  const runInput: RunPortalTaskInput = {
    task: connection.task,
    connectionId: input.connectionId,
    runId: input.jobId,
    workspaceId: context.workspaceId,
    now: input.now,
  };
  const runResult = await input.runner.runTask(runInput);
  await input.state.markCompleted(input.jobId);
  const cooldownUntil = new Date(Date.parse(input.now) + input.cooldownMs).toISOString();
  await input.state.setCooldownUntil({
    workspaceId: context.workspaceId,
    connectionId: input.connectionId,
    cooldownUntil,
  });

  return {
    status: runResult.status === "failed" ? "failed" : "completed",
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
  readonly #completedJobIds = new Set<string>();
  readonly #cooldowns = new Map<string, string>();

  async hasCompleted(jobId: string): Promise<boolean> {
    return this.#completedJobIds.has(jobId);
  }

  async markCompleted(jobId: string): Promise<void> {
    this.#completedJobIds.add(jobId);
  }

  async getCooldownUntil(input: {
    workspaceId: string;
    connectionId: string;
  }): Promise<string | undefined> {
    return this.#cooldowns.get(connectionKey(input.workspaceId, input.connectionId));
  }

  async setCooldownUntil(input: {
    workspaceId: string;
    connectionId: string;
    cooldownUntil: string;
  }): Promise<void> {
    this.#cooldowns.set(connectionKey(input.workspaceId, input.connectionId), input.cooldownUntil);
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
