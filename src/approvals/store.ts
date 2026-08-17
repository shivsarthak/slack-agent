import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ThreadGrant } from "./policy.ts";

const grantSchema = z.object({
  threadKey: z.string(), key: z.string(), approvedBy: z.string(), createdAt: z.number(), sourceRequest: z.string(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), grants: z.array(grantSchema), inactive: z.array(z.string()) }).strict();
type State = z.infer<typeof stateSchema>;

export interface ApprovalStore {
  grantsFor(threadKey: string): Promise<readonly ThreadGrant[]>;
  addGrant(grant: ThreadGrant): Promise<void>;
  markInactive(requestId: string): Promise<void>;
  isInactive(requestId: string): Promise<boolean>;
}

export async function openApprovalStore(options: { filePath: string }): Promise<ApprovalStore> {
  const filePath = options.filePath;
  let state: State;
  try {
    state = stateSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Approval state ${filePath} is invalid: ${String(error)}`);
    state = { version: 1, grants: [], inactive: [] };
  }
  let writes = Promise.resolve();
  const persist = (): Promise<void> => {
    writes = writes.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filePath);
    });
    return writes;
  };
  return {
    async grantsFor(threadKey) { return state.grants.filter((grant) => grant.threadKey === threadKey); },
    async addGrant(grant) {
      if (!state.grants.some((existing) => existing.threadKey === grant.threadKey && existing.key === grant.key)) state.grants.push(grant);
      await persist();
    },
    async markInactive(requestId) {
      if (!state.inactive.includes(requestId)) state.inactive.push(requestId);
      await persist();
    },
    async isInactive(requestId) { return state.inactive.includes(requestId); },
  };
}

export function approvalStoreFile(stateDir: string): string { return path.join(stateDir, "approvals.json"); }
