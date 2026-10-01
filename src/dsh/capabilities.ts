import type { DshCapabilityName, DshCapabilityState } from "./types.ts";

const READ_BASELINE: Readonly<Record<Exclude<DshCapabilityName, "reply" | "creation">, DshCapabilityState>> = {
  transport: {
    name: "transport",
    status: "available",
    reason: null,
  },
  observation: {
    name: "observation",
    status: "partial",
    reason: "bounded_recovery_and_terminal_text_contract_verified; production_end_to_end_unverified",
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
};

export function dshCapabilityBaseline(writeEnabled = false): DshCapabilityState[] {
  return [
    ...Object.values(READ_BASELINE).map((state) => ({ ...state })),
    {
      name: "reply",
      status: writeEnabled ? "available" : "unavailable",
      reason: writeEnabled ? null : "write_disabled",
    },
    {
      name: "creation",
      status: writeEnabled ? "available" : "unavailable",
      reason: writeEnabled ? null : "write_disabled",
    },
  ];
}

export function dshCapability(
  name: DshCapabilityName,
  writeEnabled = false,
): DshCapabilityState {
  return dshCapabilityBaseline(writeEnabled).find((state) => state.name === name)!;
}

export function dshReadOnlyCapabilityBaseline(): DshCapabilityState[] {
  return dshCapabilityBaseline(false);
}

export function dshReadOnlyCapability(name: DshCapabilityName): DshCapabilityState {
  return dshCapability(name, false);
}
