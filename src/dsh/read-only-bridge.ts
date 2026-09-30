import type { DshBridgeStore, DshMessageLink } from "../state/dsh-bridge-store.ts";
import type { DshWebHostClient } from "./web-host-client.ts";
import type { DshHostHealth, DshModelCatalog, DshProject } from "./types.ts";
import { dshReadOnlyCapabilityBaseline } from "./capabilities.ts";

type ReadOnlyHost = Pick<DshWebHostClient, "health" | "listProjects" | "listModels">;

export interface DshReadOnlyStatus {
  health: DshHostHealth;
  capabilities: ReturnType<typeof dshReadOnlyCapabilityBaseline>;
}

/** Narrow Telegram-facing facade for read-only dsh features. No Host write method is exposed. */
export class DshReadOnlyBridge {
  constructor(
    private readonly host: ReadOnlyHost,
    private readonly store: DshBridgeStore,
  ) {}

  async status(): Promise<DshReadOnlyStatus> {
    return {
      health: await this.host.health(),
      capabilities: dshReadOnlyCapabilityBaseline(),
    };
  }

  async listProjects(): Promise<DshProject[]> {
    await this.host.health();
    return this.host.listProjects();
  }

  async listModels(): Promise<DshModelCatalog> {
    await this.host.health();
    return this.host.listModels();
  }

  findMessageLink(chatId: string, messageId: number): DshMessageLink | null {
    return this.store.findMessageLink(chatId, messageId);
  }
}
