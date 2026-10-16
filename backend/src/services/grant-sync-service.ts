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
        await this.ensureDisputeRecord(savedGrant);
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
    // Only award the bonus for completed grants (#1232).
    if (grant.status !== "completed") return;

    const address = grant.recipient;
    const reputationGain = 100;

    // Wrap check-then-award in a transaction so concurrent syncs cannot
    // double-award the same (address, grantId, gain) triple (#1233).
    await this.dataSource.transaction(async (manager) => {
      let contributor = await manager.getRepository(Contributor).findOne({ where: { address } });

      if (!contributor) {
        contributor = manager.getRepository(Contributor).create({
          address,
          reputation: 0,
          totalGrantsCompleted: 0,
        });
      }

      // Scope the existence check to (address, grantId, gain) so each
      // completed grant gets its own bonus (#1232).
      const existingLog = await manager.getRepository(ReputationLog).findOne({
        where: { address, grantId: grant.id, gain: reputationGain },
      });

      if (!existingLog) {
        contributor.reputation = (contributor.reputation ?? 0) + reputationGain;
        await manager.getRepository(Contributor).save(contributor);

        await manager.getRepository(ReputationLog).save({
          address,
          gain: reputationGain,
          grantId: grant.id,
          timestamp: new Date(),
        });
      }
    });
  }

  private async ensureDisputeRecord(grant: Grant): Promise<void> {
    const existing = await this.disputeRepo.findOne({
      where: { grantId: grant.id, status: "open" },
    });
    if (!existing) {
      await this.disputeRepo.save(
        this.disputeRepo.create({ grantId: grant.id, milestoneIdx: 0, status: "open" })
      );
    }
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
