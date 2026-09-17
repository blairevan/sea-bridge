# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260916-001] correction

**Logged**: 2026-09-16T13:35:00+08:00
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Do not attribute a missing Sea-Bridge Hook event to a non-Desktop execution path without first proving the active Desktop runtime loaded and invoked the Hook.

### Details
A Desktop-initiated test command completed, while Sea-Bridge received no Hook event. The initial explanation overreached. The supported conclusion is only that the expected Hook was not delivered; configuration loading, Hook trust, event matching, and permission mode remain to be verified.

### Suggested Action
Record and validate the actual active Desktop Hook runtime configuration and run a controlled Hook invocation before drawing conclusions about Desktop support.

### Metadata
- Source: user_feedback
- Related Files: /Users/<username>/.codex/hooks.json
- Tags: codex-desktop, hooks, evidence

---
