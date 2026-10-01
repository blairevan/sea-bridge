import type { DshBridgeStore, DshMessageLink } from "../state/dsh-bridge-store.ts";
import type { DshWebHostClient } from "./web-host-client.ts";
import type {
  DshCapabilityName,
  DshCapabilityState,
  DshHostHealth,
  DshModelCatalog,
  DshProject,
} from "./types.ts";
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
    const health = await this.host.health();
    const capabilities = dshReadOnlyCapabilityBaseline();
    const probes = await Promise.allSettled([
      this.host.listProjects(),
      this.host.listModels(),
    ]);
    const runtimeUnavailable = new Map<DshCapabilityName, boolean>([
      ["projects", probes[0]?.status === "rejected"],
      ["models", probes[1]?.status === "rejected"],
    ]);
    return {
      health,
      capabilities: capabilities.map((capability): DshCapabilityState =>
        runtimeUnavailable.get(capability.name)
          ? { ...capability, status: "unavailable", reason: "runtime_probe_failed" }
          : capability),
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
