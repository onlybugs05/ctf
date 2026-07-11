# Jira Ticket: FlashLoaner Lacks Reentrancy Protection Around Callback

**Severity:** Critical

**Exact location:** [contracts/Lending/FlashLoaner.sol](../contracts/Lending/FlashLoaner.sol#L51)

**Issue summary:** `flashloan()` transfers funds, then calls `receiver.onCallback(data)` without a reentrancy guard or callback whitelist. A malicious receiver can re-enter flashloan flows before repayment accounting fully settles.

**Impact:** A borrower can repeatedly re-enter the flashloan path and amplify borrowed liquidity from the same pool session, which can drain lending reserves if combined with other trust assumptions.

**Funds at risk:** Approximately $65M-$120M depending on pool liquidity and callback path.

**Why this matters:** The callback is an untrusted external call inside a money-moving function, which is a high-risk pattern unless tightly bounded.

**Recommended fix:** Add a reentrancy guard, track active loan state per asset, and enforce a strict callback interface with repayment checks before any state changes that can be reused.
