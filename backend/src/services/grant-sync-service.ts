import { DataSource, Repository } from "typeorm";
import { Grant } from "../entities/Grant";
import { Milestone } from "../entities/Milestone";
import { Contributor } from "../entities/Contributor";
import { ReputationLog } from "../entities/ReputationLog";
import { Dispute } from "../entities/Dispute";
import { SorobanContractClient, SorobanGrant } from "../soroban/types";

export class GrantSyncService {
  private readonly grantRepo: Repository<Grant>;
  private readonly milestoneRepo: Repository<Milestone>;
  private readonly contributorRepo: Repository<Contributor>;
  private readonly reputationLogRepo: Repository<ReputationLog>;
  private readonly disputeRepo: Repository<Dispute>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly sorobanClient: SorobanContractClient,
  ) {
    this.grantRepo = this.dataSource.getRepository(Grant);
    this.milestoneRepo = this.dataSource.getRepository(Milestone);
    this.contributorRepo = this.dataSource.getRepository(Contributor);
    this.reputationLogRepo = this.dataSource.getRepository(ReputationLog);
    this.disputeRepo = this.dataSource.getRepository(Dispute);
  }

  async syncAllGrants(): Promise<void> {
    const grants = await this.sorobanClient.fetchGrants();
    for (const grant of grants) {
      const savedGrant = await this.syncGrantInternal(grant);
      await this.upsertMilestones(grant, savedGrant);
      await this.updateContributorReputation(savedGrant);
      if (savedGrant.status === "disputed") {
        await this.ensureDisputeRecord(savedGrant, grant);
      }
    }
  }

  async syncGrant(id: number): Promise<void> {
    const grant = await this.sorobanClient.fetchGrantById(id);
    if (!grant) return;
    const savedGrant = await this.syncGrantInternal(grant);
    await this.upsertMilestones(grant, savedGrant);
    await this.updateContributorReputation(savedGrant);
  }

  private async syncGrantInternal(grant: SorobanGrant): Promise<Grant> {
    return this.grantRepo.save(this.normalizeGrant(grant));
  }

  private async upsertMilestones(grant: SorobanGrant, savedGrant: Grant): Promise<void> {
    if (!grant.milestones?.length) {
      return;
    }

    await Promise.all(
      grant.milestones.map((milestone) =>
        this.milestoneRepo.upsert(
          {
            grantId: savedGrant.id,
            idx: milestone.idx,
            title: milestone.title,
            description: milestone.description ?? null,
            deadline: milestone.deadline,
          },
          ["grantId", "idx"],
        ),
      ),
    );
  }

  private async updateContributorReputation(grant: Grant): Promise<void> {
    const address = grant.recipient;
    let contributor = await this.contributorRepo.findOne({ where: { address } });

    if (!contributor) {
      contributor = this.contributorRepo.create({
        address,
        reputation: 0,
        totalGrantsCompleted: 0,
      });
    }

    // Check if we already logged reputation for this grant
    const existingLog = await this.reputationLogRepo.findOne({
      where: { address, gain: 100 },
      order: { timestamp: "DESC" },
    });

    // Only award reputation if it hasn't been logged yet
    if (!existingLog) {
      const reputationGain = 100;
      contributor.reputation = (contributor.reputation ?? 0) + reputationGain;
      await this.contributorRepo.save(contributor);

      // Log the reputation gain
      await this.reputationLogRepo.save({
        address,
        gain: reputationGain,
        timestamp: new Date(),
      });
    }
  }

  private async ensureDisputeRecord(grant: Grant, source?: SorobanGrant): Promise<void> {
    const milestoneIdx = await this.resolveDisputedMilestoneIdx(grant, source);
    const existing = await this.disputeRepo.findOne({
      where: { grantId: grant.id, milestoneIdx },
    });
    if (existing) return;
    try {
      await this.disputeRepo.save(
        this.disputeRepo.create({ grantId: grant.id, milestoneIdx, status: "open" })
      );
    } catch (err) {
      // Lost a race with another writer; the unique constraint keeps one row.
      const again = await this.disputeRepo.findOne({
        where: { grantId: grant.id, milestoneIdx },
      });
      if (!again) throw err;
    }
  }

  /** First milestone of the grant that does not already have a dispute, else the first milestone. */
  private async resolveDisputedMilestoneIdx(grant: Grant, source?: SorobanGrant): Promise<number> {
    const indices = (source?.milestones ?? []).map((m) => m.idx).sort((a, b) => a - b);
    if (indices.length === 0) {
      const stored = await this.milestoneRepo.find({
        where: { grantId: grant.id },
        order: { idx: "ASC" },
      });
      indices.push(...stored.map((m) => m.idx));
    }
    if (indices.length === 0) return 0;
    for (const idx of indices) {
      const taken = await this.disputeRepo.findOne({ where: { grantId: grant.id, milestoneIdx: idx } });
      if (!taken) return idx;
    }
    return indices[0];
  }

  private normalizeGrant(grant: SorobanGrant): Partial<Grant> {
    const { milestones, ...grantData } = grant;
    return {
      ...grantData,
      owner: grant.owner ?? grant.recipient,
      token: grant.token ?? "native",
    };
  }
}
