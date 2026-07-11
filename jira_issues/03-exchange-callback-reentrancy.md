# Jira Ticket: ExchangeVault Unlock Allows Unsafe Callback Window

**Severity:** Critical

**Exact location:** [contracts/Exchange/ExchangeVault.sol](../contracts/Exchange/ExchangeVault.sol#L286) and [contracts/Exchange/ExchangeVault.sol](../contracts/Exchange/ExchangeVault.sol#L142)

**Issue summary:** `unlock()` performs a raw external call to `msg.sender` while the vault is in its transient unlocked state. During that window, liquidity and swap operations are reachable under relaxed checks.

**Impact:** An attacker can abuse the callback window to manipulate liquidity operations and try to extract value from the pool state while the vault is temporarily unlocked.

**Funds at risk:** Approximately $125M in exchange liquidity.

**Why this matters:** The vault exposes a privileged callback entrypoint without a strict allowlist or an isolated, purpose-built callback interface.

**Recommended fix:** Replace generic callback execution with a whitelisted handler, add explicit reentrancy protection across all value-moving paths, and ensure unlock state cannot be reused to bypass liquidity accounting.
