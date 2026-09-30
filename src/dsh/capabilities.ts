import type { DshCapabilityName, DshCapabilityState } from "./types.ts";

const BASELINE: Readonly<Record<DshCapabilityName, DshCapabilityState>> = {
  transport: {
    name: "transport",
    status: "available",
    reason: null,
  },
  observation: {
    name: "observation",
    status: "partial",
    reason: "opening_snapshot_and_history_page_verified; live_follow_and_gap_recovery_unverified",
  },
  projects: {
    name: "projects",
    status: "available",
    reason: null,
  },
  models: {
    name: "models",
    status: "available",
    reason: null,
  },
  reply: {
    name: "reply",
    status: "unavailable",
    reason: "write_poc_not_authorized_or_verified",
  },
  creation: {
    name: "creation",
    status: "unavailable",
    reason: "write_poc_not_authorized_or_verified",
  },
};

export function dshReadOnlyCapabilityBaseline(): DshCapabilityState[] {
  return Object.values(BASELINE).map((state) => ({ ...state }));
}

export function dshReadOnlyCapability(name: DshCapabilityName): DshCapabilityState {
  return { ...BASELINE[name] };
}
