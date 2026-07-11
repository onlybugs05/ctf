// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('hardhat'); // Use Hardhat's ethers provider
const { Mutex } = require('async-mutex');
const { spawn } = require('child_process');

const app = express();
app.use(bodyParser.json({ limit: '5mb' }));

// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, "..", "public")));

// These will be loaded after setup script runs
let deployedConfig;
let eventsInterface;
let knownEventHashes;

// Connect to the local Hardhat node
const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");

let snapshotId;
// Timestamp captured after setup for deterministic execution
let baselineTimestamp;
let hardhatProcess = null;
let consoleLogsBuffer = []; // Buffer to collect console.log outputs
let currentTxHash = null; // Track current transaction

// In-memory storage for user's history
let userHistory = [];
let isNormalMode = true; // Track current mode: true = Normal Mode (history recording), false = Exploration Mode (faucet available)

const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';
const spawnOptions = (extra = {}) => ({
  cwd: path.join(__dirname, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: isWindows,
  ...extra
});

// Spawn Hardhat node and capture console output
function startHardhatNode() {
  return new Promise((resolve, reject) => {
    console.log('Starting Hardhat node...');
    
    hardhatProcess = spawn(npxCmd, ['hardhat', 'node', '--hostname', '127.0.0.1', '--port', '8545'], spawnOptions());

    let nodeReady = false;
    let outputBuffer = ''; // Buffer to accumulate output across batches
    let lastLogLineCount = 0; // Track how many log lines we've seen in the current console.log block

    hardhatProcess.stdout.on('data', (data) => {
      const output = data.toString();

      // Check if node is ready
      if (!nodeReady && output.includes('Started HTTP and WebSocket JSON-RPC server')) {
        nodeReady = true;
        console.log('✓ Hardhat node ready');
        resolve();
      }
      
      // Accumulate output in buffer
      outputBuffer += output;
      
      // Reset counter if we see a new console.log block starting
      if (output.includes('console.log:')) {
        lastLogLineCount = 0;
      }
      
      // Find the LAST console.log block in the buffer (most recent)
      const consoleLogRegex = /console\.log[^:]*:\n((?:[ \t]+.+\n?)*)/g;
      let matches = [];
      let match;
      
      while ((match = consoleLogRegex.exec(outputBuffer)) !== null) {
        matches.push(match);
      }
      
      // Process only the last (most recent) console.log block
      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        const logContent = lastMatch[1];
        
        if (logContent && logContent.trim()) {
          // Split into individual lines
          const lines = logContent
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
          
          // Only add NEW lines (beyond what we've seen before)
          if (lines.length > lastLogLineCount) {
            for (let i = lastLogLineCount; i < lines.length; i++) {
              consoleLogsBuffer.push({
                timestamp: Date.now(),
                message: lines[i],
                txHash: currentTxHash
              });
            }
            lastLogLineCount = lines.length;
          }
        }
      }
      
      // Clean buffer periodically (keep last 20KB)
      if (outputBuffer.length > 100000) {
        outputBuffer = outputBuffer.substring(outputBuffer.length - 20000);
        lastLogLineCount = 0; // Reset since we truncated
      }
    });

    hardhatProcess.stderr.on('data', (data) => {
      // Print to server's stderr so you can see errors
      process.stderr.write(data.toString());
    });

    hardhatProcess.on('close', (code) => {
      console.log(`Hardhat node exited with code ${code}`);
      hardhatProcess = null;
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!nodeReady) {
        reject(new Error('Hardhat node failed to start within 30 seconds'));
      }
    }, 30000);
  });
}

// Ensure contracts are compiled before starting
function CompileContracts() {
  return new Promise((resolve, reject) => {
    console.log('Compiling contracts...');
    
    const compileProcess = spawn(npxCmd, ['hardhat', 'compile'], spawnOptions());

    let output = '';
    compileProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    compileProcess.stderr.on('data', (data) => {
      output += data.toString();
    });

    // Timeout after 120 seconds
    const timeoutId = setTimeout(() => {
      compileProcess.kill();
      console.log('⚠ Compilation timed out, continuing anyway');
      resolve();
    }, 120000);

    compileProcess.on('close', (code) => {
      // Clear the timeout since compilation completed
      clearTimeout(timeoutId);
      
      if (code === 0) {
        console.log('✓ Contracts compiled successfully');
        resolve();
      } else {
        // Compilation might fail if contracts have errors, but we still want to continue
        // The setup script will handle compilation errors
        console.log('⚠ Compilation completed with warnings or errors (this is OK if setup script will compile)');
        resolve();
      }
    });
  });
}

// Run setup script
function runSetupScript() {
  return new Promise((resolve, reject) => {
    console.log('Running setup script...');
    
    const setupProcess = spawn(npxCmd, ['hardhat', 'run', 'scripts/setupInitialState.js', '--network', 'localhost'], spawnOptions());

    setupProcess.stdout.on('data', (data) => {
      process.stdout.write(data);
    });

    setupProcess.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    setupProcess.on('close', (code) => {
      if (code === 0) {
        console.log('✓ Setup script completed successfully');
        resolve();
      } else {
        reject(new Error(`Setup script exited with code ${code}`));
      }
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      setupProcess.kill();
      reject(new Error('Setup script timed out after 60 seconds'));
    }, 60000);
  });
}

// Load configuration files after setup script completes
function loadConfigurationFiles() {
  console.log('Loading configuration files...');
  
  // Load deployed configuration
  const deployedConfigPath = path.join(__dirname, "..", "deployed.json");
  if (!fs.existsSync(deployedConfigPath)) {
    throw new Error("Error: deployed.json not found at " + deployedConfigPath);
  }
  deployedConfig = JSON.parse(fs.readFileSync(deployedConfigPath, "utf8"));
  console.log('✓ Loaded deployed.json');
  
  // Load events ABI
  const abiFilePath = path.join(__dirname, "..", "public", 'eventsABI.json');
  if (!fs.existsSync(abiFilePath)) {
    throw new Error("Error: eventsABI.json not found at " + abiFilePath);
  }
  const abiJson = fs.readFileSync(abiFilePath, 'utf8');
  const eventsAbi = JSON.parse(abiJson);
  eventsInterface = new ethers.utils.Interface(eventsAbi);
  knownEventHashes = new Set(
    eventsInterface.fragments
      .filter(fragment => fragment.type === 'event')
      .map(frag => eventsInterface.getEventTopic(frag))
  );
  console.log('✓ Loaded eventsABI.json');
}

// Cleanup on exit
process.on('exit', () => {
  if (hardhatProcess) {
    hardhatProcess.kill();
  }
});

process.on('SIGINT', () => {
  if (hardhatProcess) {
    hardhatProcess.kill();
  }
  process.exit();
});


async function waitForConsoleLogs(txHash, maxWaitMs = 5000, stabilityMs = 1000) {
  const startTime = Date.now();
  let lastLogCount = 0;
  let lastChangeTime = null; // Don't start stability timer until we see at least one log
  
  while (Date.now() - startTime < maxWaitMs) {
    const currentLogCount = consoleLogsBuffer.filter(log => 
      !log.txHash || log.txHash === txHash
    ).length;
    
    if (currentLogCount > lastLogCount) {
      // New logs appeared, reset timer
      lastLogCount = currentLogCount;
      lastChangeTime = Date.now();
    } else if (lastChangeTime !== null && Date.now() - lastChangeTime >= stabilityMs) {
      // No changes for stabilityMs AND we've seen at least one log - we're stable
      return;
    }
    
    // Check every 100ms
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
 
}

async function revertState() {
  const ok = await provider.send("evm_revert", [snapshotId]);
  if (!ok) throw new Error("Failed to revert to init snapshot");
  
  // Set the timestamp for the next block to our baseline value
  await provider.send("evm_setNextBlockTimestamp", [baselineTimestamp]);
  
  // Take new snapshot 
  snapshotId = await provider.send("evm_snapshot", []);
  
  console.log(`Blockchain state reverted; new snapshot taken: ${snapshotId}, next block timestamp set to: ${baselineTimestamp}`);
}

;(async function bootstrap() {

    // Compile contracts first to ensure ABIs are available for error decoding
    await CompileContracts();

    // Start Hardhat node first
    await startHardhatNode();
    
    // Wait a bit for node to be fully ready
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Run setup script to initialize blockchain state
    await runSetupScript();
    
    // Load configuration files generated by the setup script
    loadConfigurationFiles();
    
    // Disable interval mining for deterministic timestamps
    await provider.send("evm_setIntervalMining", [0]);
    
    // Get the current timestamp after setup
    const setupBlock = await provider.getBlock('latest');
    const setupTimestamp = setupBlock.timestamp;
    
    // Force a consistent baseline timestamp by rounding up to next round value
    // This ensures determinism across restarts while being >= current timestamp
    // Round up to the next multiple of 10000 seconds (~2.7 hours)
    const BASELINE_TIMESTAMP = Math.ceil(setupTimestamp / 10000) * 10000;
    baselineTimestamp = BASELINE_TIMESTAMP;
    
    console.log(`Setup completed at timestamp: ${setupTimestamp}, rounding up to: ${baselineTimestamp}`);
    
    // Set this timestamp for the next block
    await provider.send("evm_setNextBlockTimestamp", [baselineTimestamp]);
    
    // Mine a block to lock in this timestamp
    await provider.send("evm_mine", []);
    
    // Verify the timestamp
    const verifyBlock = await provider.getBlock('latest');
    console.log(`Timestamp locked at: ${verifyBlock.timestamp} (expected: ${baselineTimestamp})`);
    
    // Take initial snapshot
    snapshotId = await provider.send("evm_snapshot", []);
    
    // Immediately set next block timestamp to baseline again to prevent drift before first attack
    await provider.send("evm_setNextBlockTimestamp", [baselineTimestamp]);
    
    const mutex = new Mutex();

app.post('/revert', async (req, res) => {
  const release = await mutex.acquire();
  try {
    await revertState();
    // Clear user's history when reverting state
    userHistory.length = 0;
    // Keep the current mode state (don't force enable)
    console.log("History cleared due to state revert. Normal mode:", isNormalMode);
    res.json({ success: true });
  } catch (err) {
    console.error("Error reverting blockchain state:", err);
    res.status(500).json({ error: err.message });
  } finally {
    release();
  }
});

app.post('/submit-attack', async (req, res) => {
  const release = await mutex.acquire();
  try {
    const { code, replayMode, replayFile } = req.body;
    
    if (!code && !replayMode) {
      release();
      return res.status(400).json({ error: "Missing code" });
    }
    
    const attacker = await getAttacker();
    
    // Handle replay mode
    if (replayMode && replayFile) {
      try {
        const replayData = JSON.parse(replayFile);
        return await executeReplay(replayData, attacker, res);
      } catch (err) {
        release();
        return res.status(400).json({ error: "Invalid replay file format" });
      }
    }

    let abi, bytecode;
    try {
      ({ abi, bytecode } = compileSolidity(code));
      console.log("Compilation successful");
    } catch (compilationError) {
      console.error("Compilation error:", compilationError);
      release();
      return res.status(400).json({ error: sanitizeErrorMessage(compilationError.message) });
    }
    
    const factory = new ethers.ContractFactory(abi, bytecode, attacker);
    
    let attackContract;

    try {
      // Get current timestamp - we'll use this for deploy and approval blocks
      const initialBlock = await provider.getBlock('latest');
      const initialTimestamp = initialBlock.timestamp;
      
      // ===== TRANSACTION 1: Deploy attack contract =====
      await provider.send("evm_setNextBlockTimestamp", [initialTimestamp]);
      attackContract = await factory.deploy();
      await attackContract.deployed();
      console.log(`Attack contract deployed at: ${attackContract.address}`);
      
      // ===== TRANSACTION 2: Batch all approvals in one block =====
      await provider.send("evm_setAutomine", [false]);
      
      // Capture the deployment transaction with source code
      const deploymentTx = {code: code};
       
      // Approve WETH, USDC, and NISC for the attack contract
      const erc20ABI = ["function approve(address spender, uint256 amount) returns (bool)"];
      const maxApproval = ethers.constants.MaxUint256;
      
      // Queue all approval transactions (won't mine yet)
      const wethContract = new ethers.Contract(deployedConfig.weth, erc20ABI, attacker);
      const wethApproveTx = await wethContract.approve(attackContract.address, maxApproval);
      
      const usdcContract = new ethers.Contract(deployedConfig.usdc, erc20ABI, attacker);
      const usdcApproveTx = await usdcContract.approve(attackContract.address, maxApproval);
      
      const niscContract = new ethers.Contract(deployedConfig.nisc, erc20ABI, attacker);
      const niscApproveTx = await niscContract.approve(attackContract.address, maxApproval);
      
      // Mine approvals at same timestamp
      await provider.send("evm_setNextBlockTimestamp", [initialTimestamp]);
      await provider.send("evm_mine", []);
      console.log(`All approvals mined in block at timestamp ${initialTimestamp}`);
      
      // ===== TRANSACTION 3: Execute Attack() with timestamp +1 =====
      // Clear console logs buffer and prepare to capture
      consoleLogsBuffer = [];
      
      // Send Attack() transaction (won't mine yet)
      const tx = await attackContract.connect(attacker).Attack();
      currentTxHash = tx.hash;
      console.log(`Attack() transaction sent with hash: ${currentTxHash}`);
      
      // Mine attack with timestamp +1 second
      await provider.send("evm_setNextBlockTimestamp", [initialTimestamp ]);
      await provider.send("evm_mine", []);
      console.log(`Attack() mined in block at timestamp ${initialTimestamp}`);
      
      // Wait for the Attack() transaction receipt
      const receipt = await tx.wait();
      console.log("Attack() function executed");
      
      // Re-enable automine for subsequent operations
      await provider.send("evm_setAutomine", [true]);
      console.log("Automine re-enabled");
      
      // Wait for console logs to be captured from stdout
      await waitForConsoleLogs(currentTxHash);
      
      // Collect console logs for this transaction
      const consoleLogs = consoleLogsBuffer.filter(log => 
        !log.txHash || log.txHash === currentTxHash
      ).map(log => log.message);
      currentTxHash = null;
      
      // Get attacker address for event resolution
      const attackerAddress = await attacker.getAddress();
      
      const parsedEvents = receipt.logs.map(log => {
        const isUserGenerated = !knownEventHashes.has(log.topics[0]);
        try {
          // Special handling for Transfer and Approval events
          if (log.topics[0] === ethers.utils.id("Transfer(address,address,uint256)") ||
              log.topics[0] === ethers.utils.id("Approval(address,address,uint256)")) {
            // ERC721 has 4 topics (event signature + 3 indexed params)
            // ERC20 has 3 topics (event signature + 2 indexed params)
            const isERC721 = log.topics.length === 4;
            
            // First two parameters are always indexed and in topics
            const from = ethers.utils.getAddress(ethers.utils.hexDataSlice(log.topics[1], 12));
            const to = ethers.utils.getAddress(ethers.utils.hexDataSlice(log.topics[2], 12));
            
            // Third parameter is either in topics (ERC721) or data (ERC20)
            let thirdParam;
            if (isERC721) {
              thirdParam = ethers.BigNumber.from(log.topics[3]).toString();
            } else {
              thirdParam = ethers.BigNumber.from(log.data).toString();
            }

            const argsDict = {
              from,
              to,
              [isERC721 ? 'tokenId' : 'value']: thirdParam
            };

            // Resolve addresses to contract names
            const resolvedArgs = resolveEventArguments(argsDict, attackContract.address, attackerAddress);

            return {
              event: log.topics[0] === ethers.utils.id("Transfer(address,address,uint256)") ? "Transfer" : "Approval",
              arguments: resolvedArgs,
              eventSignature: isERC721 ? 
                (log.topics[0] === ethers.utils.id("Transfer(address,address,uint256)") ? 
                  "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)" :
                  "Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)") :
                (log.topics[0] === ethers.utils.id("Transfer(address,address,uint256)") ? 
                  "Transfer(address indexed from, address indexed to, uint256 value)" :
                  "Approval(address indexed owner, address indexed spender, uint256 value)"),
              isUserGenerated
            };
          }

          // Handle other events normally
          const parsedLog = eventsInterface.parseLog(log);
          const argsDict = {};
          Object.keys(parsedLog.args)
            .filter(key => isNaN(key))
            .forEach(key => {
              const argVal = parsedLog.args[key];
              argsDict[key] = (argVal && typeof argVal.toString === "function") ? argVal.toString() : argVal;
            });
          
          // Resolve addresses to contract names
          const resolvedArgs = resolveEventArguments(argsDict, attackContract.address, attackerAddress);
          
          return {
            event: parsedLog.name,
            arguments: resolvedArgs,
            eventSignature: parsedLog.eventFragment.format(ethers.utils.FormatTypes.full),
            isUserGenerated
          };
        } catch (e) {
          try {
            const argsDict = {};
            Object.keys(log.args)
              .filter(key => isNaN(key))
              .forEach(key => {
                const argVal = log.args[key];
                argsDict[key] = (argVal && typeof argVal.toString === "function") ? argVal.toString() : argVal;
              });
            
            // Resolve addresses to contract names
            const resolvedArgs = resolveEventArguments(argsDict, attackContract.address, attackerAddress);
            
            return {
              event: log.event,
              arguments: resolvedArgs,
              eventSignature: log.eventSignature,
              isUserGenerated
            };
          }
          catch {
            console.log("Log could not be parsed with provided interface:");
            return {
              event: "Unknown",
              arguments: {},
              isUserGenerated
            };
          }
        }
      });

      const balance = await calculateTotalWorthInETH(attackerAddress);
      console.log(`Attacker final total worth (in ETH): ${balance}`);
      
      if (isNormalMode) {
        userHistory.push(deploymentTx);
        console.log("History data recorded");
      } else {
        console.log("History recording disabled - in Exploration Mode");
      }
      
      res.json({ 
        success: true, 
        score: balance, 
        events: parsedEvents,
        consoleLogs: consoleLogs.length > 0 ? consoleLogs : undefined
      });
    } catch (runtimeError) {
      // Re-enable automine in case of error
      await provider.send("evm_setAutomine", [true]);
      console.log("Automine re-enabled after error");
      
      // Wait for console logs to be captured from stdout (even on error)
      await waitForConsoleLogs(currentTxHash);
      
      // Collect console logs even on error
      const consoleLogs = consoleLogsBuffer.filter(log => 
        !log.txHash || log.txHash === currentTxHash
      ).map(log => log.message);
      currentTxHash = null;
      
      // console.error("Runtime error during Attack execution:", runtimeError);
      const fullError = JSON.stringify(runtimeError, Object.getOwnPropertyNames(runtimeError), 2);
      // console.error("Full error details:", fullError);
      let reason = "";
      try {
        reason = JSON.parse(runtimeError?.error?.body).error?.data?.message;
        if (!reason || reason.trim() === "") {
          reason = "Transaction reverted without a reason.";
        }
      } catch (jsonError) {
        reason = "Transaction reverted (failed to parse error message).";
      }
      res.status(400).json({ 
        error: sanitizeErrorMessage(reason),
        consoleLogs: consoleLogs.length > 0 ? consoleLogs : undefined
      });
    }

   
  } catch (err) {
    // Re-enable automine in case of outer error
    try {
      await provider.send("evm_setAutomine", [true]);
      console.log("Automine re-enabled after outer error");
    } catch (automineError) {
      console.error("Failed to re-enable automine:", automineError);
    }
    console.error("Error processing attack submission:", err);
    res.status(500).json({ error: err.message });
  } finally {
    release();
  }
});

// Start the server only after everything is initialized
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server is listening on port ${PORT}`);
  console.log('✓ All systems ready - you can now submit attacks!');
});
})();


// Fixed signer for fairness: all attack contracts deploy using this signer.
async function getAttacker() {
  const accounts = await provider.listAccounts();
  return provider.getSigner(accounts[0]); // the attacker is now the eighth signer (index 7)
}
async function getUsdcSigner() {
  const accounts = await provider.listAccounts();
  return provider.getSigner(accounts[2]); // the USDC owner is the second signer
}

// Helper function to calculate total worth of attacker's assets in ETH
async function calculateTotalWorthInETH(attackerAddress) {
  try {
    // Load contract interfaces
    const ERC20 = await ethers.getContractFactory("USDC");
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    
    // Get PriceOracle instance
    const priceOracle = new ethers.Contract(deployedConfig.priceOracle, PriceOracle.interface, provider);
    
    // Get token contract instances
    const wethContract = new ethers.Contract(deployedConfig.weth, ERC20.interface, provider);
    const usdcContract = new ethers.Contract(deployedConfig.usdc, ERC20.interface, provider);
    const niscContract = new ethers.Contract(deployedConfig.nisc, ERC20.interface, provider);
    
    // Get balances
    const ethBalance = await provider.getBalance(attackerAddress);
    const wethBalance = await wethContract.balanceOf(attackerAddress);
    const usdcBalance = await usdcContract.balanceOf(attackerAddress);
    const niscBalance = await niscContract.balanceOf(attackerAddress);
    
    // Get prices from oracle (prices are in 1e18 precision, denominated in USDC)
    const wethPrice = await priceOracle.getPrice(deployedConfig.weth); // WETH price in USDC (1e18)
    const usdcPrice = await priceOracle.getPrice(deployedConfig.usdc); // USDC price in USDC (should be 1e18)
    const niscPrice = await priceOracle.getPrice(deployedConfig.nisc); // NISC price in USDC (1e18)
    
    // Calculate total value in USDC (with 1e18 precision)
    // ETH/WETH: ethBalance (1e18) * wethPrice (USDC per ETH in 1e18) / 1e18 = USDC value in 1e18
    const ethValueInUSDC = ethBalance.mul(wethPrice).div(ethers.constants.WeiPerEther);
    const wethValueInUSDC = wethBalance.mul(wethPrice).div(ethers.constants.WeiPerEther);
    
    // USDC: usdcBalance (1e6) * usdcPrice (1e18) / 1e18 = USDC value in 1e6, need to scale to 1e18
    const usdcValueInUSDC = usdcBalance.mul(usdcPrice).mul(ethers.BigNumber.from(10).pow(12)).div(ethers.constants.WeiPerEther);
    
    // NISC: niscBalance (1e18) * niscPrice (USDC per NISC in 1e18) / 1e18 = USDC value in 1e18
    const niscValueInUSDC = niscBalance.mul(niscPrice).div(ethers.constants.WeiPerEther);
    
    // Sum all values in USDC (all are now in 1e18 precision)
    const totalValueInUSDC = ethValueInUSDC.add(wethValueInUSDC).add(usdcValueInUSDC).add(niscValueInUSDC);
    
    // Convert total USDC value to ETH: totalUSDC / (WETH price in USDC)
    // totalValueInUSDC (1e18) * 1e18 / wethPrice (1e18) = ETH value in 1e18
    const totalValueInETH = totalValueInUSDC.mul(ethers.constants.WeiPerEther).div(wethPrice);
    
    // Convert to float for display
    return parseFloat(ethers.utils.formatEther(totalValueInETH));
  } catch (err) {
    console.error("Error calculating total worth:", err);
    // Fallback to just ETH balance if calculation fails
    const ethBalance = await provider.getBalance(attackerAddress);
    return parseFloat(ethers.utils.formatEther(ethBalance));
  }
}

// Simple sanitizer to remove potential HTML injection vectors.
function sanitizeErrorMessage(message) {
  return message.replace(/[<>]/g, '');
}

// Helper function to resolve address to contract name
function resolveAddressToName(address, attackContractAddress, attackerAddress) {
  if (!address || typeof address !== 'string') {
    return address;
  }
  
  // Normalize address to lowercase for comparison
  const normalizedAddress = address.toLowerCase();
  
  // Check if it's the attack contract
  if (attackContractAddress && normalizedAddress === attackContractAddress.toLowerCase()) {
    return "AttackContract";
  }
  
  // Check if it's the attacker (msg.sender)
  if (attackerAddress && normalizedAddress === attackerAddress.toLowerCase()) {
    return "Attacker";
  }
  
  // Check if it's a known contract from deployed.json
  for (const [key, value] of Object.entries(deployedConfig)) {
    // Skip non-address fields
    if (key === 'attackTime') continue;
    
    // Handle single addresses
    if (typeof value === 'string' && value.toLowerCase() === normalizedAddress) {
      // Convert camelCase to readable format (e.g., "auctionManager" -> "AuctionManager")
      return key.charAt(0).toUpperCase() + key.slice(1);
    }
    
    // Handle arrays of addresses
    if (Array.isArray(value)) {
      const index = value.findIndex(addr => 
        typeof addr === 'string' && addr.toLowerCase() === normalizedAddress
      );
      if (index !== -1) {
        // Return name with index (e.g., "LendingManagers[0]")
        return `${key.charAt(0).toUpperCase() + key.slice(1)}[${index}]`;
      }
    }
  }
  
  // Return original address if not found
  return address;
}

// Helper function to recursively resolve addresses in event arguments
function resolveEventArguments(args, attackContractAddress, attackerAddress) {
  if (!args || typeof args !== 'object') {
    return args;
  }
  
  const resolved = Array.isArray(args) ? [] : {};
  
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.match(/^0x[a-fA-F0-9]{40}$/)) {
      // It's an Ethereum address, try to resolve it
      resolved[key] = resolveAddressToName(value, attackContractAddress, attackerAddress);
    } else if (typeof value === 'object' && value !== null) {
      // Recursively resolve nested objects/arrays
      resolved[key] = resolveEventArguments(value, attackContractAddress, attackerAddress);
    } else {
      // Keep other values as-is
      resolved[key] = value;
    }
  }
  
  return resolved;
}

let compilerLock = false;

// Modify the compilation function
function compileSolidity(sourceCode) {
  if (compilerLock) {
    throw new Error("Compiler is busy. Please try again in a moment.");
  }
  
  try {
    compilerLock = true;
    
    // Load a fresh instance of solc
    delete require.cache[require.resolve('solc')];
    const freshSolc = require('solc');
    
    const pragmaRegex = /pragma solidity\s+([^;]+);/;
    const pragmaMatch = sourceCode.match(pragmaRegex);
    if (!pragmaMatch) {
      throw new Error("Compilation failed: Solidity version pragma not found. Please include a valid 'pragma solidity ^0.8.0;' statement.");
    }
    const version = pragmaMatch[1].trim();
    if (!version.includes("0.8")) {
      throw new Error(`Compilation failed: Unsupported Solidity version '${version}'. Please use a version compatible with '^0.8.0'.`);
    }
    if (!/function\s+Attack\s*\(/.test(sourceCode)) {
      throw new Error("Compilation failed: Expected function 'Attack()' not found. Please ensure your contract includes a function called 'Attack()' with a capital 'A'.");
    }

    // Validate imports before compilation
    const importRegex = /import\s+["']([^"']+)["']/g;
    let match;
    while ((match = importRegex.exec(sourceCode)) !== null) {
      const importPath = match[1];
      if (importPath.includes("..")) {
        throw new Error("Compilation failed: Directory traversal in import paths is not allowed.");
      }
    }

    const input = {
      language: 'Solidity',
      sources: {
        'AttackContract.sol': { content: sourceCode }
      },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } }
      }
    };

    const output = JSON.parse(freshSolc.compile(JSON.stringify(input), { import: findImports }));
    
    if (output.errors) {
      const errors = output.errors.filter(err => err.severity === 'error');
      if (errors.length > 0) {
        throw new Error("Compilation error:\n" + errors.map(err => err.formattedMessage).join("\n"));
      }
    }
    
    const contractNames = Object.keys(output.contracts['AttackContract.sol']);
    if (contractNames.length === 0) {
      throw new Error("Compilation failed: No contracts compiled.");
    }
    
    const contractName = contractNames[0];
    const contract = output.contracts['AttackContract.sol'][contractName];
    
    return { abi: contract.abi, bytecode: contract.evm.bytecode.object };
  } finally {
    // Always release the lock
    compilerLock = false;
  }
}

// Modify the findImports function to be more secure
function findImports(importPath) {
  // Prevent directory traversal
  if (importPath.includes("..")) {
    return { error: "Directory traversal in import paths is not allowed" };
  }

  // Handle @openzeppelin imports from node_modules
  if (importPath.startsWith("@openzeppelin/")) {
    const fullPath = path.join(__dirname, "..", "node_modules", importPath);
    try {
      if (!fs.existsSync(fullPath)) {
        return { error: `File not found: ${importPath}` };
      }
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        return { error: `Not a file: ${importPath}` };
      }
      return { contents: fs.readFileSync(fullPath, "utf8") };
    } catch (err) {
      return { error: `Error reading file: ${importPath}` };
    }
  }

  // Handle hardhat imports from node_modules
  if (importPath.startsWith("hardhat/")) {
    const fullPath = path.join(__dirname, "..", "node_modules", importPath);
    try {
      if (!fs.existsSync(fullPath)) {
        return { error: `File not found: ${importPath}` };
      }
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        return { error: `Not a file: ${importPath}` };
      }
      return { contents: fs.readFileSync(fullPath, "utf8") };
    } catch (err) {
      return { error: `Error reading file: ${importPath}` };
    }
  }

  // Handle local contract imports
  const localPath = path.join(__dirname, "..", "contracts", importPath);
  try {
    if (!fs.existsSync(localPath)) {
      return { error: `File not found: ${importPath}` };
    }
    const stats = fs.statSync(localPath);
    if (!stats.isFile()) {
      return { error: `Not a file: ${importPath}` };
    }
    return { contents: fs.readFileSync(localPath, "utf8") };
  } catch (err) {
    return { error: `Error reading file: ${importPath}` };
  }
}

app.get('/tickets', async (req, res) => {
  try {
    const Lottery = await ethers.getContractFactory("Lottery");

    const lottery = new ethers.Contract(deployedConfig.lottery, Lottery.interface, provider);

    const nextTicketId = await lottery.nextTicketId();
    let tickets = [];
    for (let i = 0; i < nextTicketId; i++) {
      const ticket = await lottery.tickets(i);
      tickets.push({
        id: ticket.id.toString(),
        purchaseTime: ticket.purchaseTime.toNumber(),
        expirationTime: ticket.expirationTime.toNumber(),
        redeemed: ticket.redeemed,
        revealed: ticket.revealed,
        revealDeadline: ticket.revealDeadline.toNumber(),
        userRandom: ticket.userRandom,
        commitment: ticket.commitment
      });
    }
    
    // Get the number of available commitments
    const availableTickets = (await lottery.getAvailableTickets()).toNumber();
    
    res.json({ tickets, availableTickets });
  } catch (err) {
    console.error("Error fetching tickets:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/auctions', async (req, res) => {
  try {
    const AuctionManager = await ethers.getContractFactory("AuctionManager");
    const auctionManager = new ethers.Contract(deployedConfig.auctionManager, AuctionManager.interface, provider);
    const auctionCountBN = await auctionManager.auctionCount();
    const auctionCount = auctionCountBN.toNumber();

    const auctions = [];
    for (let i = 0; i < auctionCount; i++) {
      const auction = await auctionManager.auctions(i);
      auctions.push({
        auctionId: i,
        seller: auction.seller,
        nftContract: auction.nftContract,
        tokenId: auction.tokenId.toString(),
        minPrice: auction.minPrice.toString(),
        askingPrice: auction.askingPrice.toString(),
        paymentToken: auction.paymentToken,
        startTime: auction.startTime.toNumber(),
        endTime: auction.endTime.toNumber(),
        highestBidder: auction.highestBidder,
        highestBid: auction.highestBid.toString(),
        settled: auction.settled,
        isDutch: auction.isDutch
      });
    }
    for (let i = 0; i < auctionCount; i++) {
      let auction = auctions[i];
      if (auction.isDutch) {
        try {
          const currentPriceBN = await auctionManager.getCurrentPrice(i);
          auction.currentPrice = currentPriceBN.toString();
        } catch (e) {
          console.error("Error getting current price for auction", i, e);
          auction.currentPrice = "0";
        }
      }
    }
    res.json({ auctions });
  } catch (err) {
    console.error("Error fetching auctions:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/contracts', (req, res) => {
  res.json({
    usdc: deployedConfig.usdc,
    nisc: deployedConfig.nisc,
    weth: deployedConfig.weth,
    lottery: deployedConfig.lottery,
    lotteryExtension: deployedConfig.lotteryExtension,
    auctionVault: deployedConfig.auctionVault,
    auctionManager: deployedConfig.auctionManager,
    dummyStrategy: deployedConfig.dummyStrategy,
    exchangeVault: deployedConfig.exchangeVault,
    productPool: deployedConfig.productPool,
    priceOracle: deployedConfig.priceOracle,
    lendingFactory: deployedConfig.lendingFactory,
    lendingManagers: deployedConfig.lendingManagers,
    lendingPoolsA: deployedConfig.lendingPoolsA,
    lendingPoolsB: deployedConfig.lendingPoolsB,
    investmentFactory: deployedConfig.investmentFactory,
    investmentVaults: deployedConfig.investmentVaults,
    attackTime: deployedConfig.attackTime,
    communityInsurance: deployedConfig.communityInsurance,
    rewardDistributor: deployedConfig.rewardDistributor
  });
});


// Endpoint to return the current Lottery liquidity and ticket price
app.get('/lottery-liquidity', async (req, res) => {
  try {
    const lotteryAddress = deployedConfig.lottery;
    const Lottery = await ethers.getContractFactory("Lottery");
    const lotteryContract = new ethers.Contract(lotteryAddress, Lottery.interface, provider);
    const liquidityBN = await lotteryContract.liquidity();
    const ticketPriceBN = await lotteryContract.ticketPrice();
    res.json({ 
      liquidity: liquidityBN.toString(),
      ticketPrice: ticketPriceBN.toString()
    });
  } catch (err) {
    console.error("Error fetching lottery liquidity:", err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to return popular auction tokens info.
app.get('/popular-auction-tokens', async (req, res) => {
  try {
    // Get underlying token addresses from deployed configuration.
    const { usdc, weth, nisc, auctionManager } = deployedConfig;
    
    // Load the compiled interface ABIs
    const AuctionManager = await ethers.getContractFactory("AuctionManager");
    const ERC20 = await ethers.getContractFactory("USDC");
    
    const auctionMgr = new ethers.Contract(auctionManager, AuctionManager.interface, provider);

    // Fetch the vault address from AuctionManager.
    const vaultAddress = await auctionMgr.vault();

    // Define the three popular tokens.
    const popularTokens = [usdc, weth, nisc];
    const results = [];

    for (const underlying of popularTokens) {
      // Get the auction token address for the underlying.
      const auctionTokenAddr = await auctionMgr.auctionTokens(underlying);
      
      // Instantiate the auction token contract.
      const auctionToken = new ethers.Contract(auctionTokenAddr, ERC20.interface, provider);
      const totalSharesBN = await auctionToken.totalSupply();
      
      // Instantiate the underlying token contract.
      const underlyingToken = new ethers.Contract(underlying, ERC20.interface, provider);
      const underlyingBalanceBN = await underlyingToken.balanceOf(vaultAddress);
      const symbol = await underlyingToken.symbol();
      
      // Format values (assume auction tokens use 18 decimals, underlying may vary)
      const totalShares = ethers.utils.formatUnits(totalSharesBN, 0);
      const underlyingDecimals = await underlyingToken.decimals();
      const underlyingBalance = ethers.utils.formatUnits(underlyingBalanceBN, underlyingDecimals);
      
      results.push({
        underlying, // underlying token address
        auctionToken: auctionTokenAddr,
        symbol,
        totalShares,
        underlyingBalance
      });
    }
    res.json({ popularTokens: results });
  } catch (err) {
    console.error("Error fetching popular auction tokens:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/auction-vault-info', async (req, res) => {
  try {
    const { auctionVault, usdc } = deployedConfig;

    // Load the compiled interface ABIs
    const AuctionVault = await ethers.getContractFactory("AuctionVault");
    const LendingPoolStrategy = await ethers.getContractFactory("LendingPoolStrategy");
    const ERC20 = await ethers.getContractFactory("USDC");

    const auctionVaultContract = new ethers.Contract(auctionVault, AuctionVault.interface, provider);
    
    const strategyAddress = await auctionVaultContract.currentStrategy();
    
    if (strategyAddress === ethers.constants.AddressZero) {
        return res.json({
            strategyAddress: ethers.constants.AddressZero,
            investedAmount: '0',
            investedToken: usdc,
            investedTokenSymbol: 'USDC',
            investedTokenDecimals: 6
        });
    }

    const strategyContract = new ethers.Contract(strategyAddress, LendingPoolStrategy.interface, provider);

    const investedAmount = await strategyContract.getBalance(usdc);

    const usdcContract = new ethers.Contract(usdc, ERC20.interface, provider);
    const usdcDecimals = await usdcContract.decimals();

    res.json({
      strategyAddress,
      investedAmount: investedAmount.toString(),
      investedToken: usdc,
      investedTokenSymbol: "USDC",
      investedTokenDecimals: usdcDecimals
    });
  } catch (err) {
    console.error("Error fetching auction vault info:", err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to return the current ExchangeVault fee
app.get('/exchange-fee', async (req, res) => {
  try {
    // The exchangeVault address is stored in deployedConfig.
    const { exchangeVault } = deployedConfig;
    // Minimal ABI to read fee
    const exchangeVaultABI = [
      "function fee() view returns (uint256)"
    ];
    const evContract = new ethers.Contract(exchangeVault, exchangeVaultABI, provider);
    const feeBN = await evContract.fee(); // fee in basis points (e.g., 2 = 0.02%)
    res.json({ fee: feeBN.toString() });
  } catch (err) {
    console.error("Error fetching exchange fee:", err);
    res.status(500).json({ error: err.message });
  }
});

// Modified /pools endpoint: Get liquidity for each registered pool using the array of product pool addresses.
app.get('/pools', async (req, res) => {
  try {
    // Get the array of product pool addresses from deployed config.
    const poolAddresses = deployedConfig.productPools; 
    const pools = [];

    // Load the compiled interface ABIs
    const ProductPool = await ethers.getContractFactory("ProductPool");
    const ERC20 = await ethers.getContractFactory("USDC");
    const ExchangeVault = await ethers.getContractFactory("ExchangeVault");
    
    // Get the ExchangeVault instance to read pool balances.
    const exchangeVaultAddress = deployedConfig.exchangeVault;
    const exchangeVault = new ethers.Contract(exchangeVaultAddress, ExchangeVault.interface, provider);

    // Loop over each pool address.
    for (const productPoolAddress of poolAddresses) {
      const productPool = new ethers.Contract(productPoolAddress, ProductPool.interface, provider);
      const token0Address = await productPool.token0();
      const token1Address = await productPool.token1();
      const poolName = await productPool.poolName();

      // Get pool balances
      const balance0 = await exchangeVault.poolBalances(productPoolAddress, token0Address);
      const balance1 = await exchangeVault.poolBalances(productPoolAddress, token1Address);

      // Get token details.
      const token0 = new ethers.Contract(token0Address, ERC20.interface, provider);
      const token1 = new ethers.Contract(token1Address, ERC20.interface, provider);
      const symbol0 = await token0.symbol();
      const symbol1 = await token1.symbol();
      const decimals0 = await token0.decimals();
      const decimals1 = await token1.decimals();

      const formattedReserve0 = parseFloat(ethers.utils.formatUnits(balance0, decimals0));
      const formattedReserve1 = parseFloat(ethers.utils.formatUnits(balance1, decimals1));

      pools.push({
        poolName: poolName,
        poolAddress: productPoolAddress,
        tokens: [
          { symbol: symbol0, address: token0Address, reserve: formattedReserve0 },
          { symbol: symbol1, address: token1Address, reserve: formattedReserve1 }
        ]
      });
    }

    res.json({ pools });
  } catch (err) {
    console.error("Error fetching pools:", err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to return live prices from the PriceOracle contract.
app.get('/price-oracle', async (req, res) => {
  try {
    // Extract the priceOracle address and also the underlying token addresses from the deployed config.
    const { priceOracle, usdc, nisc, weth } = deployedConfig;
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const poContract = new ethers.Contract(priceOracle, PriceOracle.interface, provider);
    
    // Query the price for each token. Prices are returned in 1e18 precision.
    const usdcPriceBN = await poContract.getPrice(usdc);
    const niscPriceBN = await poContract.getPrice(nisc);
    const wethPriceBN = await poContract.getPrice(weth);
    
    res.json({
       usdcPrice: usdcPriceBN.toString(),
       niscPrice: niscPriceBN.toString(),
       wethPrice: wethPriceBN.toString()
    });
  } catch (err) {
    console.error("Error in /price-oracle endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/flashloan-fee', async (req, res) => {
  try {
    const { flashLoaner } = deployedConfig;
    const FlashLoaner = await ethers.getContractFactory("FlashLoaner");
    const flashLoanerContract = new ethers.Contract(flashLoaner, FlashLoaner.interface, provider);
    const feeBN = await flashLoanerContract.flashloanFee();
    res.json({ fee: feeBN.toString() });
  } catch (err) {
    console.error("Error fetching flashloan fee:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/flashloan-max-amounts', async (req, res) => {
  try {
    const { flashLoaner, usdc, nisc, weth } = deployedConfig;
    const FlashLoaner = await ethers.getContractFactory("FlashLoaner");
    const flashLoanerContract = new ethers.Contract(flashLoaner, FlashLoaner.interface, provider);
    
    // Get max flashloan amounts for each token
    const usdcMax = await flashLoanerContract.getMaxFlashLoanAmount(usdc);
    const niscMax = await flashLoanerContract.getMaxFlashLoanAmount(nisc);
    const wethMax = await flashLoanerContract.getMaxFlashLoanAmount(weth);
    
    res.json({
      tokens: [
        { symbol: 'USDC', amount: usdcMax.toString(), decimals: 6 },
        { symbol: 'NISC', amount: niscMax.toString(), decimals: 18 },
        { symbol: 'WETH', amount: wethMax.toString(), decimals: 18 }
      ]
    });
  } catch (err) {
    console.error("Error fetching flashloan max amounts:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/lending', async (req, res) => {
  try {
    // Load the compiled interface ABIs
    const LendingFactory = await ethers.getContractFactory("LendingFactory");
    const LendingPool = await ethers.getContractFactory("LendingPool");
    
    const lendingFactory = new ethers.Contract(deployedConfig.lendingFactory, LendingFactory.interface, provider);
    const trioCountBN = await lendingFactory.getTrioCount();
    const trioCount = trioCountBN.toNumber();
    let trios = [];
    
    for (let i = 0; i < trioCount; i++) {
      const trio = await lendingFactory.trios(i);
      // Create LendingPool contract instances for poolA and poolB
      const poolA = new ethers.Contract(trio.poolA, LendingPool.interface, provider);
      const poolB = new ethers.Contract(trio.poolB, LendingPool.interface, provider);
      
      // Call the needed functions on poolA
      const totalAssetsPoolA = await poolA.totalAssets();
      const cashPoolA = await poolA.getCash();
      const rateA = await poolA.getAnnualRate();
      const feeA = await poolA.feePercentage();
      const assetA = await poolA.asset(); 
      const sharesA = await poolA.totalSupply();
      
      // And poolB
      const totalAssetsPoolB = await poolB.totalAssets();
      const cashPoolB = await poolB.getCash();
      const rateB = await poolB.getAnnualRate();
      const feeB = await poolB.feePercentage();
      const assetB = await poolB.asset();
      const sharesB = await poolB.totalSupply();

      trios.push({
        manager: trio.lendingManager,
        poolA: trio.poolA,
        poolB: trio.poolB,
        tokenA: {
          totalAssets: totalAssetsPoolA.toString(),
          cash: cashPoolA.toString(),
          annualRate: rateA.toString(),
          feePercentage: feeA.toString(),
          asset: assetA,
          shares: sharesA.toString()
        },
        tokenB: {
          totalAssets: totalAssetsPoolB.toString(),
          cash: cashPoolB.toString(),
          annualRate: rateB.toString(),
          feePercentage: feeB.toString(),
          asset: assetB,
          shares: sharesB.toString()
        }
      });
    }
    res.json({ trios });
  } catch (err) {
    console.error("Error fetching lending state:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/lending-liquidatable', async (req, res) => {
  try {
    // Load the compiled interface ABIs
    const LendingManager = await ethers.getContractFactory("LendingManager");
    const LendingPool = await ethers.getContractFactory("LendingPool");
    
    const results = [];
    // deployedConfig.lendingManagers is your array of manager addresses
    for (const managerAddr of deployedConfig.lendingManagers) {
      const mgr = new ethers.Contract(managerAddr, LendingManager.interface, provider);
      
      // Get the pools for this manager
      const poolAAddress = await mgr.poolA();
      const poolBAddress = await mgr.poolB();
      const poolA = new ethers.Contract(poolAAddress, LendingPool.interface, provider);
      const poolB = new ethers.Contract(poolBAddress, LendingPool.interface, provider);
      
      // fetch the two lists - 0 for AssetType.A, 1 for AssetType.B
      const [usersA, sharesA, debtsA] = await mgr.getLiquidatable(0);
      const [usersB, sharesB, debtsB] = await mgr.getLiquidatable(1);

      // For liquidatableA: debt in A, collateral in B
      // Convert collateral shares (B) to amounts
      const liquidatableA = await Promise.all(usersA.map(async (u, i) => {
        const collateralAmount = await poolB.convertToAssets(sharesA[i]);
        return {
          user: u,
          collateralAmount: collateralAmount.toString(),
          debtAmount: debtsA[i].toString()
        };
      }));

      // For liquidatableB: debt in B, collateral in A
      // Convert collateral shares (A) to amounts
      const liquidatableB = await Promise.all(usersB.map(async (u, i) => {
        const collateralAmount = await poolA.convertToAssets(sharesB[i]);
        return {
          user: u,
          collateralAmount: collateralAmount.toString(),
          debtAmount: debtsB[i].toString()
        };
      }));

      results.push({
        manager: managerAddr,
        liquidatableA,
        liquidatableB
      });
    }

    res.json({ managers: results });
  } catch (err) {
    console.error("Error fetching liquidatable positions:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/investment', async (req, res) => {
  try {
    const { usdc, nisc, weth, investmentFactory } = deployedConfig;
    
    // Load the compiled interface ABIs
    const ERC20 = await ethers.getContractFactory("USDC");
    const InvestmentVaultFactory = await ethers.getContractFactory("InvestmentVaultFactory");
    const InvestmentVault = await ethers.getContractFactory("InvestmentVault");
    
    const usdcSigner = await getUsdcSigner();
    const usdcContract = new ethers.Contract(deployedConfig.usdc,ERC20.interface,usdcSigner);
    const usdcDecimals = await usdcContract.decimals();

    const factory = new ethers.Contract(investmentFactory, InvestmentVaultFactory.interface, provider);

    const assets = [
      { symbol: "USDC", addr: usdc },
      { symbol: "NISC", addr: nisc },
      { symbol: "WETH", addr: weth }
    ];

    const result = [];

    for (let { symbol, addr } of assets) {
      const vaults = await factory.getVaultsByAsset(addr);
      for (let i = 0; i < vaults.length; i++) {
        const vAddr = vaults[i];
        const vault = new ethers.Contract(vAddr, InvestmentVault.interface, provider);

        // Fetch all enabled markets and their on‑chain data
        const mkts = await vault.getMarkets();
        const markets = await Promise.all(mkts.map(async (mktAddr) => {
          // on‑vault bookkeeping
          const balanceResult = await vault.marketBalance(mktAddr);
          const underlyingBalance = ethers.utils.formatUnits(balanceResult.assets, usdcDecimals);
          const marketInfoResult = await vault.marketInfo(mktAddr);
          const underlyingCap = ethers.utils.formatUnits(marketInfoResult.cap, usdcDecimals);
          const enabled = marketInfoResult.enabled;
          const pendingRemovalTimestamp = marketInfoResult.pendingRemovalTimestamp;
          // Fetch the market's own ERC‑4626 name()
          const marketCtr = new ethers.Contract(
            mktAddr,
            ERC20.interface,
            provider
          );
          const marketName = await marketCtr.name();

          return {
            address: mktAddr,
            balance: underlyingBalance.toString(),
            cap: underlyingCap.toString(),
            enabled,
            pendingRemovalTimestamp: pendingRemovalTimestamp.toString(),
            name: marketName
          };
        }));


        // Vault totals
        const totalAssets = (await vault.totalAssets()).toString();
        const totalShares = (await vault.totalSupply()).toString();

        result.push({
          strategy: `${symbol} strategy ${i + 1}`,
          vaultAddress: vAddr,
          markets,
          totalAssets,
          totalShares
        });
      }
    }

    res.json({ vaults: result });
  } catch (err) {
    console.error("Error fetching investment state:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/community-insurance', async (req, res) => {
  try {
    const { communityInsurance, rewardDistributor, usdc, nisc, weth } = deployedConfig;
    
    // Load the compiled interface ABIs
    const CommunityInsurance = await ethers.getContractFactory("CommunityInsurance");
    const RewardDistributor = await ethers.getContractFactory("RewardDistributor");
    const ERC20 = await ethers.getContractFactory("USDC"); // Load ERC20 interface from any ERC20 token
    
    // Create contract instances using the full interface
    const ciContract = new ethers.Contract(communityInsurance, CommunityInsurance.interface, provider);
    const rdContract = new ethers.Contract(rewardDistributor, RewardDistributor.interface, provider);
    
    // Get community insurance data
    const totalAssetsArray = await ciContract.totalAssets();
    const withdrawDelay = await ciContract.withdrawDelay();
    const minimalWithdraw = await ciContract.minimalWithdraw();
    const totalSupply = await ciContract.totalSupply();
    const freeSupply = await ciContract.freeSupply();
    
    // Get reward distributor data
    const rewardTokenAddress = await rdContract.rewardToken();
    const rewardRate = await rdContract.rewardRate();
    const optimalSupply = await rdContract.optimalSupply();
    
    // Get reward token data
    const rewardTokenContract = new ethers.Contract(rewardTokenAddress, ERC20.interface, provider);
    const rewardTokenSymbol = await rewardTokenContract.symbol();
    const rewardTokenDecimals = await rewardTokenContract.decimals();
    const rewardTokenBalance = await rewardTokenContract.balanceOf(rewardDistributor);
    
    // Get supported assets
    const supportedAssets = [];
    const tokenContracts = {
      [usdc.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      [nisc.toLowerCase()]: { symbol: "NISC", decimals: 18 },
      [weth.toLowerCase()]: { symbol: "WETH", decimals: 18 }
    };
    
    for (let i = 0; i < totalAssetsArray.length; i++) {
      const assetAddress = await ciContract.supportedAssets(i);
      const assetContract = new ethers.Contract(assetAddress, ERC20.interface, provider);
      
      let symbol, decimals;
      if (tokenContracts[assetAddress.toLowerCase()]) {
        symbol = tokenContracts[assetAddress.toLowerCase()].symbol;
        decimals = tokenContracts[assetAddress.toLowerCase()].decimals;
      } else {
        symbol = await assetContract.symbol();
        decimals = await assetContract.decimals();
      }
      
      supportedAssets.push({
        address: assetAddress,
        symbol,
        decimals,
        balance: totalAssetsArray[i].toString()
      });
    }
    
    res.json({
      communityInsurance: {
        address: communityInsurance,
        supportedAssets,
        withdrawDelay: withdrawDelay.toString(),
        minimalWithdraw: minimalWithdraw.toString(),
        totalSupply: totalSupply.toString(),
        freeSupply: freeSupply.toString()
      },
      rewardDistributor: {
        address: rewardDistributor,
        rewardToken: {
          address: rewardTokenAddress,
          symbol: rewardTokenSymbol,
          decimals: rewardTokenDecimals,
          balance: rewardTokenBalance.toString()
        },
        rewardRate: rewardRate.toString(),
        optimalSupply: optimalSupply.toString()
      }
    });
  } catch (err) {
    console.error("Error fetching community insurance state:", err);
    res.status(500).json({ error: err.message });
  }
});


app.get('/balance', async (req, res) => {
  try {
    const attacker = await getAttacker();
    const attackerAddress = await attacker.getAddress();
    
    // Load the compiled interface ABI
    const ERC20 = await ethers.getContractFactory("USDC");
    
    // Get ETH balance
    const ethBalanceBN = await provider.getBalance(attackerAddress);
    const ethBalance = parseFloat(ethers.utils.formatEther(ethBalanceBN));
    
    // Get WETH balance
    const wethContract = new ethers.Contract(
      deployedConfig.weth,
      ERC20.interface,
      provider
    );
    const wethBalanceBN = await wethContract.balanceOf(attackerAddress);
    const wethBalance = parseFloat(ethers.utils.formatUnits(wethBalanceBN, 18));
    
    // Get USDC balance
    const usdcContract = new ethers.Contract(
      deployedConfig.usdc,
      ERC20.interface,
      provider
    );
    const usdcBalanceBN = await usdcContract.balanceOf(attackerAddress);
    const usdcBalance = parseFloat(ethers.utils.formatUnits(usdcBalanceBN, 6));
    
    // Get NISC balance
    const niscContract = new ethers.Contract(
      deployedConfig.nisc,
      ERC20.interface,
      provider
    );
    const niscBalanceBN = await niscContract.balanceOf(attackerAddress);
    const niscBalance = parseFloat(ethers.utils.formatUnits(niscBalanceBN, 18));
    
    // Calculate total score (worth in ETH)
    const score = await calculateTotalWorthInETH(attackerAddress);
    
    res.json({ 
      success: true, 
      eth: ethBalance,
      weth: wethBalance,
      usdc: usdcBalance,
      nisc: niscBalance,
      score: score
    });
  } catch (err) {
    console.error("Error fetching balance:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/disable-history', async (req, res) => {
  try {
    // Clear history and switch to Exploration Mode
    userHistory = [];
    isNormalMode = false;
    console.log("History cleared and switched to Exploration Mode");
    
    res.json({ 
      success: true, 
      message: "History recording disabled."
    });
  } catch (err) {
    console.error("Error disabling history:", err);
    res.status(500).json({ error: "Failed to disable history: " + err.message });
  }
});

app.post('/enable-history', async (req, res) => {
  try {
    // Switch to Normal Mode (re-enable history recording)
    isNormalMode = true;
    console.log("Switched to Normal Mode - history recording enabled");
    
    res.json({ 
      success: true, 
      message: "History recording enabled."
    });
  } catch (err) {
    console.error("Error enabling history:", err);
    res.status(500).json({ error: "Failed to enable history: " + err.message });
  }
});

app.post('/faucet', async (req, res) => {
  try {
    const attacker = await getAttacker();
    const attackerAddress = await attacker.getAddress();
    
    // Load the compiled interface ABI
    const USDC = await ethers.getContractFactory("USDC");
    
    // Get USDC contract with full interface including mint function
    const usdcContract = new ethers.Contract(
      deployedConfig.usdc,
      USDC.interface,
      await getUsdcSigner() // Use the USDC owner signer that has minting rights
    );
    
    // Mint 100k USDC to attacker (with 6 decimals)
    const usdcAmount = ethers.utils.parseUnits("100000", 6);
    const mintTx = await usdcContract.mint(attackerAddress, usdcAmount);
    await mintTx.wait();
    
    console.log(`Faucet: Minted 100,000 USDC to ${attackerAddress}`);
    
    res.json({ 
      success: true, 
      message: "Faucet successful! 100,000 USDC added to your account."
    });
  } catch (err) {
    console.error("Error processing faucet request:", err);
    res.status(500).json({ error: "Faucet failed: " + err.message });
  }
});

app.get('/lottery-challenges', async (req, res) => {
  try {
    const lotteryAddress = deployedConfig.lottery;
    
    // Load the compiled interface ABI
    const Lottery = await ethers.getContractFactory("Lottery");
    
    const lotteryContract = new ethers.Contract(lotteryAddress, Lottery.interface, provider);
    
    // Define the challenges based on the Lottery and LotteryExtension contracts
    const challenges = [
      { id: 15053, name: "solveMulmod15053", prize: "15,053 USDC" },
      { id: 18015, name: "solveMulmod18015", prize: "18,015 USDC" },
      { id: 19248, name: "solveMulmod19248", prize: "19,248 USDC" },
      { id: 25536, name: "solveMulmod25536", prize: "25,536 USDC" },
      { id: 28111, name: "solveMulmod28111", prize: "28,111 USDC" },
      { id: 30726, name: "solveMulmod30726", prize: "30,726 USDC" },
      { id: 34651, name: "solveMulmod34651", prize: "34,651 USDC" },
      { id: 38257, name: "solveMulmod38257", prize: "38,257 USDC" },
      { id: 44864, name: "solveMulmod44864", prize: "44,864 USDC" },
      { id: 48351, name: "solveMulmod48351", prize: "48,351 USDC" },
      { id: 53568, name: "solveMulmod53568", prize: "53,568 USDC" },
      { id: 53604, name: "solveMulmod53604", prize: "53,604 USDC" },
      { id: 61073, name: "solveMulmod61073", prize: "61,073 USDC" },
      { id: 63592, name: "solveMulmod63592", prize: "63,592 USDC" },
      { id: 68324, name: "solveMulmod68324", prize: "68,324 USDC" },
      { id: 69175, name: "solveMulmod69175", prize: "69,175 USDC" },
      { id: 72570, name: "solveMulmod72570", prize: "72,570 USDC" },
      { id: 74676, name: "solveMulmod74676", prize: "74,676 USDC" },
      { id: 77566, name: "solveMulmod77566", prize: "77,566 USDC" },
      { id: 79137, name: "solveMulmod79137", prize: "79,137 USDC" },
      { id: 79579, name: "solveMulmod79579", prize: "79,579 USDC" },
      { id: 81474, name: "solveMulmod81474", prize: "81,474 USDC" },
      { id: 82984, name: "solveMulmod82984", prize: "82,984 USDC" },
      { id: 85887, name: "solveMulmod85887", prize: "85,887 USDC" },
      { id: 89443, name: "solveMulmod89443", prize: "89,443 USDC" },
      { id: 90174, name: "solveMulmod90174", prize: "90,174 USDC" },
      { id: 93740, name: "solveMulmod93740", prize: "93,740 USDC" },
      { id: 98186, name: "solveMulmod98186", prize: "98,186 USDC" },
      { id: 98752, name: "solveMulmod98752", prize: "98,752 USDC" },
      { id: 99437, name: "solveMulmod99437", prize: "99,437 USDC" },
      { id: 99715, name: "solveMulmod99715", prize: "99,715 USDC" },
      { id: 99781, name: "solveMulmod99781", prize: "99,781 USDC" }
    ];
    
    // Check which challenges are solved
    const challengeStatuses = await Promise.all(
      challenges.map(async (challenge) => {
        const isSolved = await lotteryContract.solvedChallenges(challenge.id);
        return {
          ...challenge,
          solved: isSolved
        };
      })
    );
    
    res.json({ challenges: challengeStatuses });
  } catch (err) {
    console.error("Error fetching lottery challenges:", err);
    res.status(500).json({ error: err.message });
  }
});

// Execute replay from uploaded file
async function executeReplay(replayData, attacker, res) {
  try {
    
    // Handle both single attack and multiple attacks in replay file
    let transactions;
    
    if (replayData.attacks && Array.isArray(replayData.attacks)) {
      console.log(`Found ${replayData.attacks.length} attacks in replay file`);
    } else {
      throw new Error("Invalid replay file format - no valid transactions found");
    }
    
    
    // Validate transactions array
    if (replayData.attacks.length === 0) {
      throw new Error("No attacks found in replay data");
    }
    // Replay transactions in order
    let contractABI = null;
    let attackCount = 0;
    
    for (let i = 0; i < replayData.attacks.length; i++) {
      const txData = replayData.attacks[i];
      let automineWasDisabled = false;
      try {
        console.log(`Processing transaction ${i + 1}/${replayData.attacks.length}:`);
        
        // Get initial block for this attack
        const initialBlock = await provider.getBlock('latest');
        const initialTimestamp = initialBlock.timestamp;
        
        // Compile the source code
        console.log("Compiling contract code for replay");
        let abi, bytecode;
        try {
          ({ abi, bytecode } = compileSolidity(txData.code));
          console.log("Replay compilation successful");
        } catch (compilationError) {
          console.error("Replay compilation error:", compilationError);
          throw new Error("Failed to compile contract code during replay: " + sanitizeErrorMessage(compilationError.message));
        }
        
        // ===== TRANSACTION 1: Deploy attack contract =====
        await provider.send("evm_setNextBlockTimestamp", [initialTimestamp]);
        const factory = new ethers.ContractFactory(abi, bytecode, attacker);
        const attackContract = await factory.deploy();
        await attackContract.deployed();
        console.log(`Attack contract deployed at: ${attackContract.address}`);
        
        // ===== TRANSACTION 2: Batch all approvals in one block =====
        await provider.send("evm_setAutomine", [false]);
        automineWasDisabled = true;

        // Approve WETH, USDC, and NISC for the attack contract
        const erc20ABI = ["function approve(address spender, uint256 amount) returns (bool)"];
        const maxApproval = ethers.constants.MaxUint256;
        
        // Queue all approval transactions (won't mine yet)
        const wethContract = new ethers.Contract(deployedConfig.weth, erc20ABI, attacker);
        const wethApproveTx = await wethContract.approve(attackContract.address, maxApproval);
        
        const usdcContract = new ethers.Contract(deployedConfig.usdc, erc20ABI, attacker);
        const usdcApproveTx = await usdcContract.approve(attackContract.address, maxApproval);
        
        const niscContract = new ethers.Contract(deployedConfig.nisc, erc20ABI, attacker);
        const niscApproveTx = await niscContract.approve(attackContract.address, maxApproval);
        
        // Mine approvals at same timestamp
        await provider.send("evm_setNextBlockTimestamp", [initialTimestamp]);
        await provider.send("evm_mine", []);
        console.log(`All approvals mined in block at timestamp ${initialTimestamp}`);
        
        // ===== TRANSACTION 3: Execute Attack() with same timestamp =====
        // Send Attack() transaction (won't mine yet)
        const tx = await attackContract.connect(attacker).Attack();
        console.log(`Attack() transaction sent with hash: ${tx.hash}`);
        
        // Mine attack with same timestamp
        await provider.send("evm_setNextBlockTimestamp", [initialTimestamp]);
        await provider.send("evm_mine", []);
        console.log(`Attack() mined in block at timestamp ${initialTimestamp}`);
        
        // Wait for the Attack() transaction receipt
        const receipt = await tx.wait();
        console.log("Attack() function executed");
        
        // Re-enable automine for subsequent operations
        await provider.send("evm_setAutomine", [true]);
        console.log("Automine re-enabled");
        
        attackCount++;
        
        // Check balance after each attack
        const currentBalance = await provider.getBalance(await attacker.getAddress());
        console.log(`Balance after attack ${attackCount}: ${ethers.utils.formatEther(currentBalance)} ETH`);
      } finally {
        // Always re-enable automine so a revert (e.g. in tx.wait()) doesn't leave the chain stuck
        // and cause subsequent replay attempts to hang at deploy()/deployed().
        if (automineWasDisabled) {
          await provider.send("evm_setAutomine", [true]);
          console.log("Automine re-enabled");
        }
      }
    }
    
    const attackerAddress = await attacker.getAddress();
    const balance = await calculateTotalWorthInETH(attackerAddress);
    
    // Add replayed attacks to the user's history if in Normal Mode
    if (isNormalMode && replayData.attacks && Array.isArray(replayData.attacks)) {
      console.log(`Adding ${replayData.attacks.length} replayed attacks to history`);
      userHistory.push(...replayData.attacks);
    }
    
    res.json({ 
      success: true, 
      score: balance, 
      message: "Replay executed successfully!",
      replayMode: true
    });
  } catch (err) {
    console.error("Error executing replay:", err);
    
    // Parse error message similar to regular attack execution
    let reason = "";
    try {
      reason = JSON.parse(err?.error?.body).error?.data?.message;
      if (!reason || reason.trim() === "") {
        reason = err.message || "Replay execution failed without a specific error message.";
      }
    } catch (jsonError) {
      // If we can't parse the nested error, try to extract from the main message
      if (err.message && err.message.includes("reverted with reason string")) {
        const match = err.message.match(/reverted with reason string '([^']*)'/);
        if (match) {
          reason = `Error: VM Exception while processing transaction: reverted with reason string '${match[1]}'`;
        } else {
          reason = err.message;
        }
      } else {
        reason = err.message || "Replay execution failed.";
      }
    }
    
    res.status(400).json({ error: sanitizeErrorMessage(reason) });
  }
}

// Get history count
app.get('/history-count', (req, res) => {
  res.json({ count: userHistory.length, recordingActive: isNormalMode });
});

// Get current mode state
app.get('/mode', (req, res) => {
  // Backend mode: 'normal' when isNormalMode is true, 'exploration' when false
  const mode = isNormalMode ? 'normal' : 'exploration';
  res.json({ mode, isNormalMode });
});

// Download accumulated replay history for a user
app.get('/download-history', (req, res) => {
  if (userHistory.length === 0) {
    return res.status(404).json({ error: "No replay history found for this user" });
  }
  
  const replayData = {
    attacks: userHistory,
    downloadTime: Date.now()
  };
  
  const filename = `replay-${Date.now()}.json`;
  const jsonString = JSON.stringify(replayData, null, 2);
  
  // Set headers to trigger download
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(jsonString));
  
  // Send the JSON directly without writing to filesystem
  res.send(jsonString);
});
