# Jira Ticket: InvestmentVault Market Array Corruption

**Severity:** High

**Exact location:** [contracts/Investment/InvestmentVault.sol](../contracts/Investment/InvestmentVault.sol#L136)

**Issue summary:** `acceptMarketAddition()` mutates the `markets` array using a broken push/swap pattern. The logic can overwrite the IdleMarket slot or otherwise corrupt the intended ordering.

**Impact:** Corrupted market ordering can break cap enforcement, misroute deposits, and compromise allocation logic.

**Funds at risk:** Approximately $50M in vault-managed assets.

**Why this matters:** The vault depends on the array ordering for correctness. Any off-by-one or slot overwrite here can invalidate the market routing model.

**Recommended fix:** Rebuild the insertion logic so the array is updated atomically and IdleMarket remains the last entry under all conditions. Add invariant tests for market ordering.
