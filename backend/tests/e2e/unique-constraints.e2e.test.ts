import express from "express";
import request from "supertest";
import { getMetadataArgsStorage } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { shouldSynchronize } from "../../src/db/data-source";
import { Dispute } from "../../src/entities/Dispute";
import { MilestoneApproval } from "../../src/entities/MilestoneApproval";
import { buildMilestoneApprovalRouter } from "../../src/routes/milestone-approvals";

const uniquesFor = (target: Function) =>
  getMetadataArgsStorage()
    .uniques.filter((u) => u.target === target)
    .map((u) => u.columns);

describe("schema guards", () => {
  it("never synchronizes the schema in production", () => {
    expect(shouldSynchronize("production")).toBe(false);
    expect(shouldSynchronize("development")).toBe(true);
    expect(shouldSynchronize("test")).toBe(true);
  });

  it("declares one dispute per (grantId, milestoneIdx)", () => {
    expect(uniquesFor(Dispute)).toContainEqual(["grantId", "milestoneIdx"]);
  });

  it("declares one approval per reviewer per milestone", () => {
    expect(uniquesFor(MilestoneApproval)).toContainEqual([
      "grantId",
      "milestoneIdx",
      "reviewerStellarAddress",
    ]);
  });
});

describe("milestone approval resubmission", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "sqljs",
      entities: [MilestoneApproval],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it("updates the existing vote instead of inserting a duplicate", async () => {
    const repo = dataSource.getRepository(MilestoneApproval);
    const app = express();
    app.use(express.json());
    app.use("/milestone-approvals", buildMilestoneApprovalRouter(repo));
    const body = { grantId: 1, milestoneIdx: 0, reviewerStellarAddress: "GREVIEWER", approved: true };

    const first = await request(app).post("/milestone-approvals").send(body);
    const second = await request(app).post("/milestone-approvals").send({ ...body, approved: false });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await repo.find({ where: { grantId: 1, milestoneIdx: 0 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].approved).toBe(false);
  });

  it("rejects a duplicate approval row at the database level", async () => {
    const repo = dataSource.getRepository(MilestoneApproval);
    const row = { grantId: 2, milestoneIdx: 1, reviewerStellarAddress: "GDUP", approved: true };
    await repo.save(repo.create(row));
    await expect(repo.save(repo.create(row))).rejects.toThrow();
  });
});
