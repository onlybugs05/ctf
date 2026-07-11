# Jira Ticket: Auction Withdrawal Returns Less Than Requested After Strategy Loss

**Severity:** High

**Exact location:** [contracts/Auction/AuctionManager.sol](../contracts/Auction/AuctionManager.sol#L78)

**Issue summary:** `withdrawERC20()` reassigns `amount` after divesting from the strategy when vault cash is insufficient. This means the final transfer amount can differ from the user’s expected withdrawal amount.

**Impact:** Users can receive less than the nominal withdrawal request, especially after a strategy loss or partial divestment, causing value leakage and inconsistent accounting.

**Funds at risk:** Approximately $5M-$20M over time depending on loss frequency and withdrawal volume.

**Why this matters:** Withdrawal logic should be value-preserving and deterministic. Reassigning the requested amount after a divestment introduces silent loss behavior.

**Recommended fix:** Preserve the originally requested amount semantics, return actual withdrawn value explicitly, and fail rather than partially fulfill unless the interface is designed for partial withdrawals.
