# Mechanic attribution causal guard

This regression exists to preserve a safety invariant while the causal mechanics v3 rollout is completed: receiving mechanic damage is not sufficient evidence of ownership. The authoritative implementation remains the causal schema/responsibility graph and execution ledger; PR #17's Attribution Safety v1 is used only as a conservative acceptance baseline.
