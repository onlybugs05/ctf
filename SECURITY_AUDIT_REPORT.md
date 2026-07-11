# CaptureTheFunds - Smart Contract Security Audit Report

## Executive Summary
This audit identified **9 significant vulnerabilities** including **2 CRITICAL**, **4 HIGH**, and **3 MEDIUM** severity issues that could lead to loss of funds, protocol manipulation, and unauthorized access.

⚠️ **DO NOT DEPLOY TO MAINNET** without fixing the CRITICAL and HIGH issues.

---

## CRITICAL VULNERABILITIES

### 1. **Centralized Price Oracle - Price Manipulation Attack** 🔴
**File:** `contracts/PriceOracle.sol`
**Severity:** CRITICAL
**Impact:** Complete protocol compromise

#### Issue:
The price oracle is fully centralized with no safeguards:
```solidity
function setPrice(IERC20 asset, uint256 price) external onlyOwner {
    require(address(asset) != address(0), "PriceOracle: invalid asset");
    require(price > 0, "PriceOracle: invalid price");
    prices[asset] = price;
    emit PriceSet(asset, price);
}
```

**Risks:**
- Owner can arbitrarily set any price
- Entire lending system depends on this oracle
- No price bounds/reasonableness checks
- No timelock protection
- All collateral liquidations use this oracle
- Lending Manager will liquidate positions based on fake prices

#### Exploit Scenario:
```
1. Owner sets ETH price to 0.0001 USDC (massive undervaluation)
2. All ETH collateral becomes "bad debt"
3. CommunityInsurance liquidates all positions
4. Owner sets ETH price back to normal, profiting from arbitrage
5. All users' collateral is stolen
```

#### Recommendations:
- [ ] Integrate Chainlink price feeds or Uniswap TWAP
- [ ] Add price bounds: reject prices > 2x or < 0.5x last price
- [ ] Implement 24-hour timelock for oracle updates
- [ ] Add circuit breaker: halt lending if prices move > 20% in 1 hour
- [ ] Use multiple oracle sources with median pricing

---

### 2. **Missing Liquidation Function in LendingManager** 🔴
**File:** `contracts/Lending/LendingManager.sol`
**Severity:** CRITICAL
**Impact:** Bad debt cannot be liquidated, system insolvency

#### Issue:
`CommunityInsurance.liquidateBadDebt()` calls `lm.liquidate()` which is not implemented:
```solidity
// In CommunityInsurance.sol
collateralShares = lm.liquidate(assetType, user);
```

But in `LendingManager.sol`, there's no `liquidate()` function defined!

#### Missing Code:
```solidity
function liquidate(AssetType assetType, address user) external returns (uint256) {
    Position storage pos = positions[user];
    // Should transfer collateral to liquidator
    // Should clear debt
    // But this function doesn't exist!
}
```

#### Recommendations:
- [ ] Implement complete `liquidate()` function with:
  - Health factor check (position must be underwater)
  - Proper collateral transfer
  - Debt clearing
  - Liquidation incentive (5-10% bonus)
  - Event emission

---

## HIGH SEVERITY VULNERABILITIES

### 3. **FlashLoan Reentrancy in Callback** 🟠
**File:** `contracts/Lending/FlashLoaner.sol` (lines 77-89)
**Severity:** HIGH
**Impact:** Potential reentrancy leading to fund theft

#### Issue:
The flashloan doesn't prevent reentrancy during the callback:
```solidity
// Transfer the requested amount to the receiver
token.safeTransfer(receiver, amount);

// Execute the callback on the receiver
try IFlashLoanReceiver(receiver).onCallback(data){
    // Callback executes - NO GUARD HERE!
} catch { ... }
```

The receiver can call `flashloan()` again during the callback, causing:
- Double-lending from the same pool
- Cross-pool drains
- Debt manipulation

#### Exploit:
```solidity
contract Exploit is IFlashLoanReceiver {
    function onCallback(bytes calldata) external {
        // Re-enter flashloan() with different amounts
        flashloaner.flashloan(asset, amount2, address(this), "");
        // Now we have 2x the funds we should have
    }
}
```

#### Recommendations:
- [ ] Use reentrancy guard: add `nonReentrant` modifier
- [ ] Track flashloan nesting depth, max 1 level
- [ ] Use pull-based callback: receiver initiates withdrawal after callback

---

### 4. **AuctionManager - Incorrect Withdrawal Amount Tracking** 🟠
**File:** `contracts/Auction/AuctionManager.sol` (lines 73-99)
**Severity:** HIGH
**Impact:** Users may lose funds, or protocol over-pays

#### Issue:
In `withdrawERC20()`, the divest function returns actual amount, but logic error:
```solidity
function withdrawERC20(IERC20 underlying, uint256 amount) external nonReentrant {
    // ... validation ...
    
    uint256 vaultCash = underlying.balanceOf(address(vault));
    
    if (vaultCash < amount) {
        uint256 deficit = amount - vaultCash;
        uint256 actualDivested = vault.divest(underlying, deficit);
        amount = vaultCash + actualDivested;  // ⚠️ BUG: amount is reassigned
    }
    
    underlying.safeTransferFrom(address(vault), msg.sender, amount);
    emit WithdrawERC20(msg.sender, underlying, amount);
}
```

**Problem:** If strategy only returns 50% of requested (loss scenario):
- User requested: 1000 tokens
- Vault cash: 200 tokens  
- Requested divest: 800 tokens
- Actually received: 400 tokens (50% loss)
- **Code reassigns amount to 600 tokens** ← WRONG!
- User gets 600, but their shares burned for 1000

#### Recommendations:
- [ ] Use separate variable for actual amount:
```solidity
uint256 requestedAmount = amount;
uint256 actualAmount = vaultCash;
if (vaultCash < requestedAmount) {
    uint256 deficit = requestedAmount - vaultCash;
    actualAmount += vault.divest(underlying, deficit);
}
underlying.safeTransferFrom(address(vault), msg.sender, actualAmount);
```

---

### 5. **LendingPool - Integer Underflow Risk** 🟠
**File:** `contracts/Lending/LendingPool.sol` (line 261)
**Severity:** HIGH
**Impact:** Flashloan accounting corruption

#### Issue:
```solidity
function flashloanReturn(uint256 amount) external onlyFlashloanContract nonReentrant {
    _poolCash += amount;
    flashloanAmount -= amount;  // ⚠️ Unchecked underflow!
}
```

If `amount > flashloanAmount`, this underflows (in Solidity 0.8+, reverts, but with poor UX).

More dangerous: someone could call `flashloanReturn()` without calling `flashloanWithdraw()`:
```solidity
// Attacker sends tokens directly
token.transfer(pool, maliciousAmount);
// Then calls:
pool.flashloanReturn(maliciousAmount + 1);  // Fails with generic revert
```

#### Recommendations:
- [ ] Add check: `require(flashloanAmount >= amount, "Underflow")`
- [ ] Better: track flashloans per transaction ID
- [ ] Add recovery mechanism for stuck flashloan state

---

### 6. **ExchangeVault - Unsafe External Call Pattern** 🟠
**File:** `contracts/Exchange/ExchangeVault.sol` (line ~370)
**Severity:** HIGH (Potential, depends on implementation)
**Impact:** Reentrancy in unlock callback

#### Issue:
```solidity
function unlock(bytes calldata data) external transient returns (bytes memory result) {
    (bool success, bytes memory returnData) = msg.sender.call(data);  // ⚠️ Arbitrary call!
    // ...
}
```

The `msg.sender.call(data)` allows the caller to execute ANY code. Combined with `onlyWhenUnlocked`:
- Caller can recursively call ExchangeVault functions
- Can manipulate pool states during callbacks
- Delta tracking may be corrupted

#### Recommendations:
- [ ] Whitelist allowed callback functions
- [ ] Validate callback contract is trusted
- [ ] Add additional reentrancy guard beyond `_locked`

---

## MEDIUM SEVERITY VULNERABILITIES

### 7. **Auction - Race Condition on Time-Based Triggers** 🟡
**File:** `contracts/Auction/AuctionManager.sol` (lines 127-130, 247-260)
**Severity:** MEDIUM
**Impact:** Unfair auction settlement, MEV exploitation

#### Issue:
Dutch auction prices are determined by current block.timestamp:
```solidity
function getCurrentPrice(uint256 auctionId) public view returns (uint256) {
    if (block.timestamp >= auction.endTime) {
        return auction.minPrice;
    } else {
        uint256 elapsed = block.timestamp - auction.startTime;
        uint256 duration = auction.endTime - auction.startTime;
        uint256 priceDiff = auction.askingPrice - auction.minPrice;
        return auction.askingPrice - ((priceDiff * elapsed) / duration);
    }
}
```

**Problems:**
1. Miners/validators can manipulate block.timestamp within ~15 seconds
2. Two identical bids in same block - unpredictable ordering
3. Users can't guarantee exact price they're paying
4. MEV bots can front-run with lower prices

#### Recommendations:
- [ ] Use block.number instead for fixed discrete price points
- [ ] Implement commit-reveal scheme for Dutch auctions
- [ ] Add maximum slippage parameter: `require(price >= minAcceptablePrice)`
- [ ] Use Chainlink VRF for fair randomization

---

### 8. **InvestmentVault - Market Array Reordering Bug** 🟡
**File:** `contracts/Investment/InvestmentVault.sol` (lines 146-154, 187-202)
**Severity:** MEDIUM
**Impact:** Market removal causes index corruption

#### Issue:
Adding and removing markets uses complex array swapping logic:
```solidity
function acceptMarketAddition(IERC4626 market) external onlyOwner nonReentrant {
    // ...
    uint256 len = markets.length;
    markets.push(market);
    // Swap with IdleMarket
    markets[len - 1] = market;        // ⚠️ Index len-1 is IdleMarket
    markets[len] = IERC4626(address(idleMarket));  // ⚠️ But len is now out of bounds!
}
```

This is actually using array length changes - should be:
```solidity
markets[len] = market;  // Append
```

But checking `removeMarketRemoval()` - more complex swaps with potential off-by-one errors.

#### Recommendations:
- [ ] Use simple append/remove pattern
- [ ] Unit test with different market counts
- [ ] Fuzz test market array reordering

---

### 9. **CommunityInsurance - Missing Approval Reset** 🟡
**File:** `contracts/Community Insurance/CommunityInsurance.sol` (line 133)
**Severity:** MEDIUM
**Impact:** Leftover approvals, potential fund theft

#### Issue:
```solidity
function liquidateBadDebt(ILendingManager manager, address user, ILendingManager.AssetType assetType) 
    public 
    returns (uint256 collateralShares, uint256 receivedAmount) 
{
    // ...
    debtToken.forceApprove(address(manager), debtAmount);  // ⚠️ No reset!
    collateralShares = lm.liquidate(assetType, user);
    // Approval remains for debtAmount forever!
}
```

If `liquidate()` uses less than the approved amount, remaining approval stays active. Dangerous if:
1. Manager is later compromised
2. Multiple calls approved in sequence
3. External code can call manager with this approval

#### Recommendations:
- [ ] Reset approval to 0 after liquidation:
```solidity
debtToken.forceApprove(address(manager), debtAmount);
collateralShares = lm.liquidate(assetType, user);
debtToken.forceApprove(address(manager), 0);  // CRITICAL!
```
- [ ] Use `safeIncreaseAllowance()` pattern instead

---

## MEDIUM SEVERITY - LOGIC ISSUES

### 10. **LendingManager - Missing Flash Loan Guard Check** 🟡
**File:** `contracts/Lending/LendingManager.sol` (line ~65)
**Severity:** MEDIUM
**Impact:** Flash loan attack on lending positions

#### Issue:
```solidity
function _getPoolAndAsset(AssetType assetType) internal view returns (...) {
    // ...
    require(!pool.isFlashloanActive(), "LendingManager: Pool is in an active flashloan state");
}
```

This check exists but:
1. Not all functions call it
2. `getCollateral()` and `getDebtInfo()` are view functions that bypass checks
3. Price oracle could be manipulated during flashloan

#### Recommendations:
- [ ] Ensure ALL view functions that depend on pool state check flashloan status
- [ ] Add oracle price staleness check (prevents stale prices from flashloans)

---

## INFORMATIONAL / BEST PRACTICES

### 11. **Potential Gas Optimization Issues**
- `Lottery.pendingMaxWinnings()` loops through ALL tickets - O(n) complexity (Line ~58)
- Recommendation: Track count in storage

### 12. **Missing Events**
- `LendingManager.borrow()` - emits event
- `LendingManager.repay()` - check if event exists
- Ensure all state changes emit events for off-chain monitoring

### 13. **Hardcoded Parameters**
- `Lottery.ticketPrice = 200_000 * 10 ** 6` - should be changeable by governance
- `TIMELOCK_DURATION = 1 days` - consider shorter for critical operations

---

## SUMMARY BY SEVERITY

| Severity | Count | Issues |
|----------|-------|--------|
| 🔴 CRITICAL | 2 | Centralized oracle, Missing liquidate() |
| 🟠 HIGH | 4 | Reentrancy, Withdrawal bug, Underflow, Unsafe calls |
| 🟡 MEDIUM | 4 | Race conditions, Array bugs, Approvals, Flash loan guard |

---

## DEPLOYMENT CHECKLIST

### BEFORE TESTNET:
- [ ] Fix CRITICAL #1 - Integrate proper price oracle
- [ ] Fix CRITICAL #2 - Implement liquidate() function
- [ ] Fix HIGH #1 - Add nonReentrant to flashloan callback
- [ ] Fix HIGH #2 - Fix withdrawal amount tracking
- [ ] Fix HIGH #3 - Add underflow check

### BEFORE MAINNET:
- [ ] Complete all fixes above
- [ ] External security audit from reputable firm (OpenZeppelin, Trail of Bits, etc.)
- [ ] 100% test coverage including fuzzing
- [ ] Staging deployment with time-delayed launch
- [ ] Insurance/coverage for smart contract
- [ ] Proof-of-Reserve audits

---

## RECOMMENDATIONS

1. **Immediate (Before Any Deployment):**
   - Implement proper oracle solution
   - Complete missing liquidation logic
   - Add reentrancy guards

2. **Before Testnet:**
   - Fix all HIGH severity bugs
   - Comprehensive unit tests
   - Internal review with experienced solidity auditors

3. **Before Mainnet:**
   - External security audit
   - Formal verification for critical paths
   - gradual launch with limited TVL caps
   - 48-hour pause mechanism

---

## SEVERITY SCALE

- 🔴 **CRITICAL**: Can cause immediate loss of funds, protocol collapse
- 🟠 **HIGH**: Can cause fund loss under certain conditions, major logic flaws
- 🟡 **MEDIUM**: May cause issues in edge cases, suboptimal patterns
- 🟢 **LOW**: Code quality, gas optimization, best practices

---

**Report Generated:** 2024
**Scope:** All smart contracts in `contracts/` directory
**Not Covered:** Frontend, backend server, deployment infrastructure
