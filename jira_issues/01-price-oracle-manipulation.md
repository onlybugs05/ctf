# Jira Ticket: Price Oracle Can Be Set to Unsafe Values

**Severity:** Critical

**Exact location:** [contracts/PriceOracle.sol](../contracts/PriceOracle.sol#L23)

**Issue summary:** `setPrice()` is owner-controlled and accepts arbitrary values with no timelock, bounds, or external price source. If the owner key is compromised or misused, prices can be pushed to unsafe levels and invalidate collateral assumptions.

**Impact:** An attacker controlling the oracle can force mass liquidations, freeze healthy positions, and cascade losses across lending and insurance systems.

**Funds at risk:** Approximately $210M-$350M in chained scenarios, with direct lending exposure around $120M and protocol-wide exposure around $357M.

**Why this matters:** This is a single-point-of-failure price control that can be used to destabilize every system that depends on asset valuation.

**Recommended fix:** Use an external oracle feed, add time-delayed updates, enforce sanity bounds, and add a circuit breaker for large deviations.
