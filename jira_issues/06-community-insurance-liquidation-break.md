# Jira Ticket: CommunityInsurance Liquidation Path Is Broken

**Severity:** Medium to High

**Exact location:** [contracts/Community Insurance/CommunityInsurance.sol](../contracts/Community%20Insurance/CommunityInsurance.sol#L139) and [contracts/Community Insurance/CommunityInsurance.sol](../contracts/Community%20Insurance/CommunityInsurance.sol#L183)

**Issue summary:** The liquidation flow depends on `lm.liquidate(...)`, but the referenced lending manager path does not expose a matching implementation. That means the bad-debt workflow is incomplete and standing approval handling is not reliably cleaned up.

**Impact:** Bad debt cannot be cleared correctly, which leaves insolvency risk in place and can block recovery of undercollateralized positions.

**Funds at risk:** Approximately $50M in the insurance/bad-debt surface.

**Why this matters:** Insurance is supposed to absorb and resolve debt events. If the liquidation path is broken, the entire safety mechanism is weakened.

**Recommended fix:** Implement and test the liquidation path end-to-end, ensure approvals are reset after use, and add integration tests for bad-debt resolution.
