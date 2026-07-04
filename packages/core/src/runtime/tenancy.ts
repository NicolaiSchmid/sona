import { z } from "zod";

const workspaceContextSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    userId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
  })
  .strict();

export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

export interface WorkspaceScopedServiceOptions {
  context: WorkspaceContext;
}

export function createWorkspaceContext(input: unknown): WorkspaceContext {
  return Object.freeze(workspaceContextSchema.parse(input));
}

export function requireWorkspaceContext(context: unknown): WorkspaceContext {
  try {
    return createWorkspaceContext(context);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid workspace context: ${error.message}`);
    }
    throw error;
  }
}
