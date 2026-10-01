import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc,
  }),
}));

import { createSyncJobRepository } from "@/lib/sync/jobs-repository";

const progress = {
  total: 0,
  processed: 0,
  uploaded: 0,
  skipped: 0,
  review: 0,
  failed: 0,
  synced: 0,
  warnings: 0,
  errors: 0,
};

describe("sync job repository nullable RPC arguments", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: {}, error: null });
  });

  it("sends explicit null error arguments when completing a successful job", async () => {
    const repo = createSyncJobRepository();

    await repo.finish({
      workspaceId: "workspace-id",
      jobId: "job-id",
      workerId: "worker-id",
      status: "completed",
      errorCode: null,
      errorMessage: null,
      progress,
      result: {},
    });

    expect(rpc).toHaveBeenCalledWith(
      "sync_job_finish",
      expect.objectContaining({
        p_error_code: null,
        p_error_message: null,
      }),
    );
  });

  it("sends an explicit null error message when updating a successful item", async () => {
    const repo = createSyncJobRepository();

    await repo.updateItem({
      workspaceId: "workspace-id",
      jobId: "job-id",
      workerId: "worker-id",
      itemId: "item-id",
      status: "synced",
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errorMessage: null,
    });

    expect(rpc).toHaveBeenCalledWith(
      "sync_item_update",
      expect.objectContaining({
        p_error_message: null,
      }),
    );
  });
});
