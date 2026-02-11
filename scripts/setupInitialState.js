// scripts/setupInitialState.js
const { ethers, network } = require('hardhat');
const fs = require('fs');
const path = require('path');

const {
  parseEventParameter,
  buildEventsABI,
  generateAttackContractSource,
} = require('./setupHelper');

async function mintWeth(signer, amount, weth) {
  const address = await signer.getAddress();
  const currentBalance = await ethers.provider.getBalance(address);
  const newBalance = currentBalance.add(amount);
  await ethers.provider.send('hardhat_setBalance', [address, ethers.utils.hexValue(newBalance)]);
  tx = await weth.connect(signer).deposit({ value: amount });
  await tx.wait();
}

async function advanceTime(seconds) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

async function main() {


  // Use eight signers for distinct roles.
  const signers = await ethers.getSigners();
  const attacker = signers[0]; // Attacker
  const wethOwner = signers[1]; // WETH token owner
  const usdcOwner = signers[2]; // USDC token owner
  const niscOwner = signers[3]; // NISC token owner
  const lotteryOwner = signers[4]; // Lottery protocol owner
  const auctionOwner = signers[5]; // Auction protocol owner
  const exchangeOwner = signers[6]; // Exchange protocol owner (and also WETH owner)
  const oracleOwner = signers[7]; // Oracle owner
  const lendingOwner = signers[8]; // Lending protocol owner
  const investmentOwner = signers[9]; // Investment protocol owner
  const ticketBuyer0 = signers[10]; // Purchaser of a lottery ticket
  const ticketBuyer1 = signers[11]; // Purchaser of another lottery ticket
  const ticketBuyer2 = signers[12]; // Purchaser of another lottery ticket
  const exchangeUser0 = signers[13]; // User who swaps assets in the exchange protocol
  const lendingUser0 = signers[14]; // User who borrows assets in the lending protocol
  const lendingUser1 = signers[15]; // User who borrows assets in the lending protocol
  const lendingUser2 = signers[16]; // User who borrows assets in the lending protocol
  const investmentUser0 = signers[17]; // User who invests assets in the investment protocol
  const investmentUser1 = signers[18]; // User who invests assets in the investment protocol
  const communityInsuranceDepositor = signers[19]; // Using the next available signer index

  console.log('Attacker:', attacker.address);
  console.log('WETH Owner:', wethOwner.address);
  console.log('USDC Owner:', usdcOwner.address);
  console.log('NISC Owner:', niscOwner.address);
  console.log('Lottery Owner:', lotteryOwner.address);
  console.log('Auction Owner:', auctionOwner.address);
  console.log('Exchange Owner:', exchangeOwner.address);
  console.log('Oracle Owner:', oracleOwner.address);
  console.log('Lending Owner:', lendingOwner.address);
  console.log('Ticket Buyer 0:', ticketBuyer0.address);
  console.log('Ticket Buyer 1:', ticketBuyer1.address);
  console.log('Ticket Buyer 2:', ticketBuyer2.address);
  console.log('Exchange User 0:', exchangeUser0.address);
  console.log('Lending User 0:', lendingUser0.address);
  console.log('Lending User 1:', lendingUser1.address);
  console.log('Lending User 2:', lendingUser2.address);
  console.log('Investment User 0:', investmentUser0.address);
  console.log('Investment User 1:', investmentUser1.address);
  console.log('Community Insurance Depositor:', communityInsuranceDepositor.address);
  // Set attacker ETH balance to 1 ETH.
  await network.provider.send('hardhat_setBalance', [
    attacker.address,
    ethers.utils.hexValue(ethers.utils.parseEther('1')),
  ]);

  // // =========================================================
  // // 1. Set initial blockchain time (now + 1 second)
  // // =========================================================
  const currentBlock = await ethers.provider.getBlock('latest');
  const initialTime = currentBlock.timestamp + 1;
  await advanceTime(1);
  console.log('Initial blockchain time set to:', initialTime);

  // =========================================================
  // 2. Deploy Token Contracts and fund users
  // =========================================================

  console.log('Deploying Token Contracts...');

  // -- USDC deployed by USDC Owner (common token) --
  const USDC = await ethers.getContractFactory('USDC', usdcOwner);
  const usdc = await USDC.deploy();
  await usdc.deployed();
  console.log('USDC deployed to:', usdc.address);

  // -- NISC deployed by NISC Owner (common token) --
  const NISC = await ethers.getContractFactory('NISC', niscOwner);
  const nisc = await NISC.deploy();
  await nisc.deployed();
  console.log('NISC deployed to:', nisc.address);

  // -- WETH deployed by WETH Owner (common token) --
  const WETH = await ethers.getContractFactory('WETH', wethOwner);
  const weth = await WETH.deploy();
  await weth.deployed();
  console.log('WETH deployed to:', weth.address);

  // =========================================================
  // 3. Lottery Protocol
  // =========================================================

  console.log('=== Lottery Protocol Setup ===');

  const LotteryDepositAmount = ethers.utils.parseUnits('5000000', 6);

  const LotteryExtension = await ethers.getContractFactory('LotteryExtension',lotteryOwner);
  const lotteryExtensionInstance = await LotteryExtension.deploy();
  await lotteryExtensionInstance.deployed();
  console.log('LotteryExtension deployed to:',lotteryExtensionInstance.address);

  const Lottery = await ethers.getContractFactory('Lottery', lotteryOwner);
  const lottery = await Lottery.deploy(usdc.address,lotteryExtensionInstance.address);
  await lottery.deployed();
  console.log('Lottery deployed to:', lottery.address);

  // Pre-Ticket Lottery Actions by Lottery Owner.
  tx = await usdc.mint(lotteryOwner.address, LotteryDepositAmount);await tx.wait();
  console.log('USDC minted to Lottery Owner:', ethers.utils.formatUnits(LotteryDepositAmount, 6));
  tx = await usdc.connect(lotteryOwner).approve(lottery.address, LotteryDepositAmount);await tx.wait();
  tx = await lottery.connect(lotteryOwner).depositLiquidity(LotteryDepositAmount);await tx.wait();
  console.log('Lottery Owner deposited liquidity into Lottery');

  console.log('Adding commitments to Lottery...');
  const commit0 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('zk_obe_xW0w'));
  const commit1 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('_eUnJ6-REuI'));
  const commit2 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Olvpk5BXWCI'));
  const commit3 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('uFyk5UOyNqI'));
  tx = await lottery.connect(lotteryOwner).addCommitment(commit0);await tx.wait();
  tx = await lottery.connect(lotteryOwner).addCommitment(commit1);await tx.wait();
  tx = await lottery.connect(lotteryOwner).addCommitment(commit2);await tx.wait();
  tx = await lottery.connect(lotteryOwner).addCommitment(commit3);await tx.wait();


  console.log('Purchasing tickets...');
  const ticketPrice = await lottery.ticketPrice();
  
  await advanceTime(3600);

  tx = await usdc.connect(ticketBuyer0).approve(lottery.address, ticketPrice);await tx.wait();
  tx = await usdc.mint(ticketBuyer0.address, ticketPrice);await tx.wait();
  tx = await lottery.connect(ticketBuyer0).purchaseTicket('223');await tx.wait();

  await advanceTime(1.5 * 3600);

  tx = await usdc.mint(ticketBuyer1.address, ticketPrice);await tx.wait();
  tx = await usdc.connect(ticketBuyer1).approve(lottery.address, ticketPrice);await tx.wait();
  tx = await lottery.connect(ticketBuyer1).purchaseTicket('914');await tx.wait();

  await advanceTime(1 * 3600);

  tx = await usdc.mint(ticketBuyer2.address, ticketPrice);await tx.wait();
  tx = await usdc.connect(ticketBuyer2).approve(lottery.address, ticketPrice);await tx.wait();
  tx = await lottery.connect(ticketBuyer2).purchaseTicket('491');await tx.wait();

  tx = await lottery.connect(lotteryOwner).revealRandom(0, 'zk_obe_xW0w'); await tx.wait();
  tx = await lottery.connect(lotteryOwner).revealRandom(1, '_eUnJ6-REuI'); await tx.wait();
  tx = await lottery.connect(lotteryOwner).revealRandom(2, 'Olvpk5BXWCI'); await tx.wait();


// =========================================================
  // 3. Lending Protocol
  // =========================================================

  console.log('=== Lending Protocol Setup ===');

  const PriceOracle = await ethers.getContractFactory('PriceOracle',oracleOwner);
  const priceOracle = await PriceOracle.deploy();
  await priceOracle.deployed();
  console.log('PriceOracle deployed at:', priceOracle.address);

  const usdcPrice = ethers.utils.parseUnits('1', 18); // 1e18
  const niscPrice = ethers.utils.parseUnits('25', 16); // 25e16
  const wethPrice = ethers.utils.parseUnits('2000', 18); // 2000e18


  console.log('Setting prices...');
  tx = await priceOracle.setPrice(usdc.address, usdcPrice);await tx.wait();
  tx = await priceOracle.setPrice(nisc.address, niscPrice);await tx.wait();
  tx = await priceOracle.setPrice(weth.address, wethPrice);await tx.wait();

  const LendingFactory = await ethers.getContractFactory('LendingFactory',lendingOwner);
  const lendingFactory = await LendingFactory.deploy();
  await lendingFactory.deployed();
  console.log('LendingFactory deployed at:', lendingFactory.address);

  const FlashLoaner = await ethers.getContractFactory('FlashLoaner',lendingOwner);
  const flashLoaner = await FlashLoaner.deploy(
    lendingFactory.address,
    1000, // 10% in basis points
    lendingOwner.address // flashloanFeeRecipient is the owner
  );
  await flashLoaner.deployed();
  console.log('FlashLoaner deployed at:', flashLoaner.address);

  tx = await lendingFactory.setFlashLoaner(flashLoaner.address);await tx.wait();
  console.log('FlashLoaner set in LendingFactory.');

  console.log('Creating Lending Trios...');

  const assetInfo1 = {
    assetA: usdc.address,
    assetB: weth.address,
    nameA: 'Trio 1 USDC Lending Pool',
    symbolA: 'lpUSDC1',
    nameB: 'Trio 1 WETH Lending Pool',
    symbolB: 'lpWETH1',
  };

  const rateInfo = {
    rateMin: ethers.utils.parseUnits('0.02', 18), // 2% minimum rate
    rateOptimal: ethers.utils.parseUnits('0.05', 18), // 5% optimal rate
    rateMax: ethers.utils.parseUnits('0.40', 18), // 40% maximum rate
    utilOptimal: ethers.utils.parseUnits('0.80', 18), // 80% optimal utilization
  };

  const policyInfo = {
    LTV: ethers.utils.parseUnits('0.75', 18), // 75% LTV
    LT: ethers.utils.parseUnits('0.80', 18), // 85% liquidation threshold
  };

  const feeInfo = {
    feeBeneficiary: lendingOwner.address,
    feePercentage: ethers.utils.parseUnits('0', 18), // 0% fee
  };

  tx = await lendingFactory.createTrio(assetInfo1, rateInfo, policyInfo, feeInfo, priceOracle.address);await tx.wait();
  console.log('Lending trio USDC/WETH created using LendingFactory.');

  const assetInfo2 = {
    assetA: usdc.address,
    assetB: nisc.address,
    nameA: 'Trio 2 USDC Lending Pool',
    symbolA: 'lpUSDC2',
    nameB: 'Trio 2 NISC Lending Pool',
    symbolB: 'lpNISC2',
  };

  tx = await lendingFactory.createTrio(assetInfo2, rateInfo, policyInfo, feeInfo, priceOracle.address);await tx.wait();
  console.log('Lending trio USDC/NISC created using LendingFactory.');




  console.log('Depositing liquidity into Lending Pools...');

  const depositAmountUSDC = ethers.utils.parseUnits('100000', 6); // 100,000 USDC
  const depositAmountWETH = ethers.utils.parseUnits('10', 18); // 10 WETH
  const depositAmountNISC = ethers.utils.parseUnits('100000', 18); // 100,000 NISC

  const lockAmountUSDCShares = ethers.utils.parseUnits('90000', 6); // 90,000 USDC shares
  const lockAmountNISCShares = ethers.utils.parseUnits('90000', 18); // 90,000 USDC shares

  const borrowAmountWETH = ethers.utils.parseUnits('42', 17); // 4.2 WETH
  const borrowAmountNISC = ethers.utils.parseUnits('50000', 18); // 50,000 NISC
  const borrowAmountUSDC = ethers.utils.parseUnits('15000', 6); // 15,000 USDC

  console.log('Depositing liquidity into Lending Pools...');

  // AssetType enum for clarity in code
  const AssetType = {A: 0,B: 1};

  // Retrieve all deployed trios and store their addresses in arrays.
  const trioCountBN = await lendingFactory.getTrioCount();
  const trioCount = trioCountBN.toNumber();
  let lendingManagers = [];
  let lendingPoolsA = [];
  let lendingPoolsB = [];

  const LendingPool = await ethers.getContractFactory('LendingPool');
  const LendingManager = await ethers.getContractFactory('LendingManager');

  for (let i = 0; i < trioCount; i++) {
    console.log(`Starting Trio ${i+1} Setup`);
    const trio = await lendingFactory.trios(i);
    lendingManagers.push(trio.lendingManager);
    lendingPoolsA.push(trio.poolA);
    lendingPoolsB.push(trio.poolB);
    console.log(`Lending Trio ${i+1} - Manager: ${trio.lendingManager}, Pool A: ${trio.poolA}, Pool B: ${trio.poolB}`);

    const managerAddress = lendingManagers[i];
    const poolAAddress = lendingPoolsA[i];
    const poolBAddress = lendingPoolsB[i];

    let manager = LendingManager.attach(managerAddress);
    const poolA = LendingPool.attach(poolAAddress);
    const poolB = LendingPool.attach(poolBAddress);

    if (i === AssetType.A) {
      console.log(`Trio 1: LendingOwner depositing USDC to Pool A...`);
      tx = await usdc.connect(lendingOwner).approve(poolAAddress, depositAmountUSDC);await tx.wait();
      tx = await usdc.mint(lendingOwner.address, depositAmountUSDC);await tx.wait();
      tx = await poolA.connect(lendingOwner).deposit(depositAmountUSDC, lendingOwner.address);await tx.wait();
  
      console.log(`Trio 1: LendingOwner depositing WETH to Pool B...`);
      tx = await weth.connect(lendingOwner).approve(poolBAddress, depositAmountWETH);await tx.wait();

      await mintWeth(lendingOwner, depositAmountWETH, weth);
      tx = await poolB.connect(lendingOwner).deposit(depositAmountWETH, lendingOwner.address);await tx.wait();

      console.log(`Trio 1: LendingUser0 depositing USDC to Pool A...`);
      tx = await usdc.connect(lendingUser0).approve(poolAAddress, depositAmountUSDC);await tx.wait();
      tx = await usdc.mint(lendingUser0.address, depositAmountUSDC);await tx.wait();
      tx = await poolA.connect(lendingUser0).deposit(depositAmountUSDC, lendingUser0.address);await tx.wait();
      
      console.log(`Trio 1: LendingUser0 locking collateral...`);
      tx = await poolA.connect(lendingUser0).approve(managerAddress, lockAmountUSDCShares);await tx.wait();
      tx = await manager.connect(lendingUser0).lockCollateral(AssetType.A, lockAmountUSDCShares);await tx.wait();
      manager = manager.connect(lendingUser0);

      console.log(`Trio 1: LendingUser0 borrowing WETH...`);
      tx = await manager.borrow(AssetType.B, borrowAmountWETH);await tx.wait();
      console.log(`Deposited liquidity and borrowed trio 1`);
    } else if (i === AssetType.B) {
      console.log(`Trio 2: LendingOwner depositing USDC to Pool A...`);      
      tx = await usdc.connect(lendingOwner).approve(poolAAddress, depositAmountUSDC);await tx.wait();
      tx = await usdc.mint(lendingOwner.address, depositAmountUSDC);await tx.wait();
      tx = await poolA.connect(lendingOwner).deposit(depositAmountUSDC, lendingOwner.address);await tx.wait();
    
      console.log(`Trio 2: LendingOwner depositing NISC to Pool B...`);
      tx = await nisc.connect(lendingOwner).approve(poolBAddress, depositAmountNISC);await tx.wait();
      tx = await nisc.mint(lendingOwner.address, depositAmountNISC);await tx.wait();
      tx = await poolB.connect(lendingOwner).deposit(depositAmountNISC, lendingOwner.address);await tx.wait();
    
      console.log(`Trio 2: LendingUser0 depositing USDC to Pool A...`);
      tx = await usdc.connect(lendingUser0).approve(poolAAddress, depositAmountUSDC);await tx.wait();
      tx = await usdc.mint(lendingUser0.address, depositAmountUSDC);await tx.wait();
      tx = await poolA.connect(lendingUser0).deposit(depositAmountUSDC, lendingUser0.address);await tx.wait();

      console.log(`Trio 2: LendingUser0 locking collateral...`);
      tx = await poolA.connect(lendingUser0).approve(managerAddress, lockAmountUSDCShares);await tx.wait();
      tx = await manager.connect(lendingUser0).lockCollateral(AssetType.A, lockAmountUSDCShares);await tx.wait();
      manager = manager.connect(lendingUser0);

      console.log(`Trio 2: LendingUser0 borrowing NISC...`);
      tx = await manager.borrow(AssetType.B, borrowAmountNISC);await tx.wait();

      console.log(`Trio 2: LendingUser1 depositing NISC to Pool B...`);
      tx = await nisc.connect(lendingUser1).approve(poolBAddress, depositAmountNISC);await tx.wait();
      tx = await nisc.mint(lendingUser1.address, depositAmountNISC);await tx.wait();
      tx = await poolB.connect(lendingUser1).deposit(depositAmountNISC, lendingUser1.address);await tx.wait();

      console.log(`Trio 2: LendingUser1 locking collateral...`);
      tx = await poolB.connect(lendingUser1).approve(managerAddress, lockAmountNISCShares);await tx.wait();
      tx = await manager.connect(lendingUser1).lockCollateral(1, lockAmountNISCShares);await tx.wait();
      
      console.log(`Trio 2: LendingUser1 borrowing USDC...`);
      tx = await manager.connect(lendingUser1).borrow(0, borrowAmountUSDC);await tx.wait();
      console.log(`Deposited liquidity and borrowed trio 2`);
    }
  }

  console.log('Setting up Liquidation Position...');

  let managerAddress = lendingManagers[0];
  let poolAAddress = lendingPoolsA[0];
  let poolBAddress = lendingPoolsB[0];
  let manager = LendingManager.attach(managerAddress);
  let poolA = LendingPool.attach(poolAAddress);
  let poolB = LendingPool.attach(poolBAddress);
  const collateralAmountWETH = ethers.utils.parseUnits('60', 18);
  const lockAmountLiquidationWETHShares = ethers.utils.parseUnits('60', 18);
  const borrowAmountLiquidationUSDC = ethers.utils.parseUnits('100000', 6);
  const wethTemporaryPrice = ethers.utils.parseUnits('4000', 18); // 4000e18

  console.log('Liquidation: Setting WETH temporary high price to 4000...');
  tx = await priceOracle.setPrice(weth.address, wethTemporaryPrice);await tx.wait();

  console.log('Liquidation: LendingUser2 depositing WETH to Pool B...');
  tx = await weth.connect(lendingUser2).approve(poolBAddress, collateralAmountWETH);await tx.wait();
  await mintWeth(lendingUser2, collateralAmountWETH, weth);
  tx = await poolB.connect(lendingUser2).deposit(collateralAmountWETH, lendingUser2.address);await tx.wait();

  console.log('Liquidation: LendingUser2 locking WETH collateral...');
  const lendingUser2Balance = await poolB.balanceOf(lendingUser2.address);
  tx = await poolB.connect(lendingUser2).approve(managerAddress, lendingUser2Balance);await tx.wait();
  tx = await manager.connect(lendingUser2).lockCollateral(1, lendingUser2Balance);await tx.wait();

  console.log('Liquidation: LendingUser2 borrowing USDC (creating bad debt)...');
  tx = await manager.connect(lendingUser2).borrow(0, borrowAmountLiquidationUSDC);await tx.wait();

  console.log('Liquidation: Resetting WETH price to 2000...');
  tx = await priceOracle.connect(oracleOwner).setPrice(weth.address, wethPrice);await tx.wait();
  
  console.log('WETH price reset - Liquidation position created');


  // =========================================================
  // 4. Auction Protocol
  // =========================================================

  
  console.log('=== Auction Protocol Setup ===');


  const AuctionDepositAmountUSDC = ethers.utils.parseUnits('100000', 6);
  const AuctionDepositAmountNISC = ethers.utils.parseUnits('200000', 18);

  const usdcLendingPoolAddress = lendingPoolsA[0]; // From Lending Protocol setup
  const LendingPoolStrategy = await ethers.getContractFactory('LendingPoolStrategy',auctionOwner);
  const lendingPoolStrategy = await LendingPoolStrategy.deploy(usdcLendingPoolAddress);
  await lendingPoolStrategy.deployed();
  console.log('LendingPoolStrategy deployed (Auction):',lendingPoolStrategy.address);
  const AuctionVault = await ethers.getContractFactory('AuctionVault',auctionOwner);
  const auctionVault = await AuctionVault.deploy(lendingPoolStrategy.address);
  await auctionVault.deployed();
  console.log('AuctionVault deployed (Auction):', auctionVault.address);

  const AuctionManager = await ethers.getContractFactory('AuctionManager',auctionOwner);
  const auctionManager = await AuctionManager.deploy(auctionVault.address);
  await auctionManager.deployed();
  console.log('AuctionManager deployed (Auction):', auctionManager.address);


  await auctionVault.setAuctionManager(auctionManager.address)
  await lendingPoolStrategy.setAuctionVault(auctionVault.address);

  console.log('Registering AuctionTokens...');
  tx = await auctionManager.registerAuctionToken(usdc.address, 'Auction USDC', 'aUSDC');await tx.wait();
  tx = await auctionManager.approveToken(usdc.address);await tx.wait();
  tx = await auctionManager.registerAuctionToken(nisc.address, 'Auction NISC', 'aNISC');await tx.wait();
  tx = await auctionManager.approveToken(nisc.address);await tx.wait();
  tx = await auctionManager.registerAuctionToken(weth.address, 'Auction WETH', 'aWETH');await tx.wait();
  tx = await auctionManager.approveToken(weth.address);await tx.wait();

  console.log('Depositing AuctionTokens...');
  tx = await usdc.connect(usdcOwner).approve(auctionManager.address, AuctionDepositAmountUSDC);await tx.wait();
  tx = await usdc.mint(usdcOwner.address, AuctionDepositAmountUSDC);await tx.wait();
  tx = await auctionManager.connect(usdcOwner).depositERC20(usdc.address, AuctionDepositAmountUSDC);await tx.wait();
  console.log('USDC Owner deposited',ethers.utils.formatUnits(AuctionDepositAmountUSDC, 6),'USDC into AuctionManager');

  tx = await nisc.connect(niscOwner).approve(auctionManager.address, AuctionDepositAmountNISC);await tx.wait();
  tx = await nisc.mint(niscOwner.address, AuctionDepositAmountNISC);await tx.wait();
  tx = await auctionManager.connect(niscOwner).depositERC20(nisc.address, AuctionDepositAmountNISC);await tx.wait();
  console.log('NISC Owner deposited',ethers.utils.formatUnits(AuctionDepositAmountNISC, 18),'NISC into AuctionManager');

  console.log('Investing in Strategy...');
  const investmentAmount = ethers.utils.parseUnits('100000', 6); // 100,000 USDC
  tx = await auctionManager.connect(auctionOwner).investInStrategy(usdc.address, investmentAmount);await tx.wait();
  console.log(`Auction owner invested ${ethers.utils.formatUnits(investmentAmount, 6)} USDC from the vault into the strategy via the AuctionManager`);


  console.log('Creating Auctions...');
  await advanceTime(4 * 3600);

  tx = await lottery.connect(ticketBuyer0).approve(auctionManager.address, 0);await tx.wait();
  tx = await lottery.connect(ticketBuyer1).approve(auctionManager.address, 1);await tx.wait();
  tx = await lottery.connect(ticketBuyer2).approve(auctionManager.address, 2);await tx.wait();
  console.log('Ticket owners approved AuctionManager for their tickets.');

  tx = await auctionManager.connect(ticketBuyer0).createAuction(
    lottery.address,
    0, // ticket ID
    ethers.utils.parseUnits('180000', 6),
    ethers.utils.parseUnits('200000', 6),
    usdc.address,
    2 * 24 * 3600 // duration: 2 days
  );await tx.wait();

  tx = await auctionManager.connect(ticketBuyer1).createDutchAuction(
    lottery.address,
    1, // ticket ID
    ethers.utils.parseUnits('2000000', 18),
    ethers.utils.parseUnits('250000', 18),
    nisc.address,
    10 * 24 * 3600
  );await tx.wait();
  console.log('Creating Auctions...');
  await advanceTime(1 * 3600);

  tx = await auctionManager.connect(ticketBuyer2).createDutchAuction(
    lottery.address,
    2, // ticket ID
    ethers.utils.parseUnits('2000000', 18),
    ethers.utils.parseUnits('200000', 18),
    nisc.address,
    5 * 24 * 3600
  );await tx.wait();



  // =========================================================
  // 5. Exchange Protocol
  // =========================================================

   console.log('=== Exchange Protocol Setup ===');


  const liquidity1USDC = ethers.utils.parseUnits('2000000', 6); // 2,000,000 USDC
  const liquidity1WETH = ethers.utils.parseUnits('1000', 18); // 1,000 WETH
  const liquidity2USDC = ethers.utils.parseUnits('50000', 6); // 50,000 USDC
  const liquidity2NISC = ethers.utils.parseUnits('200000', 18); // 200,000 NISC

   const ExchangeVault = await ethers.getContractFactory('ExchangeVault',exchangeOwner);
   const feeBasisPoints = 3;
   const exchangeVault = await ExchangeVault.deploy(exchangeOwner.address,feeBasisPoints);
   await exchangeVault.deployed();
   console.log('ExchangeVault deployed (Exchange):', exchangeVault.address);
 
   const PoolHelper = await ethers.getContractFactory('PoolHelper',exchangeOwner);
   const poolHelper = await PoolHelper.deploy(exchangeVault.address);
   await poolHelper.deployed();
   console.log('PoolHelper deployed at:', poolHelper.address);
 
   tx = await usdc.connect(exchangeOwner).approve(poolHelper.address, ethers.constants.MaxUint256);await tx.wait();
   tx = await nisc.connect(exchangeOwner).approve(poolHelper.address, ethers.constants.MaxUint256);await tx.wait();
   tx = await weth.connect(exchangeOwner).approve(poolHelper.address, ethers.constants.MaxUint256);await tx.wait();
   console.log('ExchangeOwner approved PoolHelper for USDC, NISC and WETH');
   
   const poolData = [
     {
       tokenA: usdc.address,
       tokenB: weth.address,
       amountA: liquidity1USDC,
       amountB: liquidity1WETH,
       poolName: 'USDC/WETH Pool',
     },
     {
       tokenA: usdc.address,
       tokenB: nisc.address,
       amountA: liquidity2USDC,
       amountB: liquidity2NISC,
       poolName: 'USDC/NISC Pool',
     },
   ];
 
    console.log('Registering Pools...');

    // Get the fee from ExchangeVault to calculate total amount needed
    const vaultFee = await exchangeVault.fee();
    const PERCENT_DIVISOR = await exchangeVault.PERCENT_DIVISOR();

   const productPools = [];
   for (let i = 0; i < poolData.length; i++) {
     const data = poolData[i];
     let token0, token1, amount0, amount1;
     if (data.tokenA.toLowerCase() < data.tokenB.toLowerCase()) {
       token0 = data.tokenA;
       token1 = data.tokenB;
       amount0 = data.amountA;
       amount1 = data.amountB;
     } else {
       token0 = data.tokenB;
       token1 = data.tokenA;
       amount0 = data.amountB;
       amount1 = data.amountA;
     }
     const ProductPool = await ethers.getContractFactory('ProductPool',exchangeOwner);
     const productPool = await ProductPool.deploy(token0, token1, data.poolName);
     await productPool.deployed();
     console.log(`${data.poolName} deployed (Exchange):`, productPool.address);
     productPools.push(productPool.address);
 
    tx = await exchangeVault.registerPool(productPool.address, [token0, token1]);await tx.wait();
    console.log(`${data.poolName} registered with ExchangeVault by Exchange Owner`);
    
    // Calculate total amounts needed (amount + fee)
    const feeAmount0 = amount0.mul(vaultFee).div(PERCENT_DIVISOR);
    const totalAmount0 = amount0.add(feeAmount0);
    const feeAmount1 = amount1.mul(vaultFee).div(PERCENT_DIVISOR);
    const totalAmount1 = amount1.add(feeAmount1);
    
    console.log(`Minting tokens with fee: token0=${totalAmount0.toString()} (${amount0.toString()} + ${feeAmount0.toString()} fee), token1=${totalAmount1.toString()} (${amount1.toString()} + ${feeAmount1.toString()} fee)`);

    const amounts = [amount0, amount1];
    // Mint tokens based on token addresses (including fee)
    if (token0 === weth.address) {
      await mintWeth(exchangeOwner, totalAmount0, weth);
    } else if (token0 === usdc.address) {
      tx = await usdc.mint(exchangeOwner.address, totalAmount0);await tx.wait();
    } else if (token0 === nisc.address) {
      tx = await nisc.mint(exchangeOwner.address, totalAmount0);await tx.wait();
    }

    if (token1 === weth.address) {
      await mintWeth(exchangeOwner, totalAmount1, weth);
    } else if (token1 === usdc.address) {
      tx = await usdc.mint(exchangeOwner.address, totalAmount1);await tx.wait();
    } else if (token1 === nisc.address) {
      tx = await nisc.mint(exchangeOwner.address, totalAmount1);await tx.wait();
    }
    tx = await poolHelper.connect(exchangeOwner).supplyLiquidity(productPool.address, amounts, exchangeOwner.address);await tx.wait();
    console.log('Liquidity added to', data.poolName, 'via PoolHelper');
   }
 
   // ExchangeUser0 swaps
   tx = await usdc.connect(exchangeUser0).approve(poolHelper.address, ethers.constants.MaxUint256);await tx.wait();
   tx = await nisc.connect(exchangeUser0).approve(poolHelper.address, ethers.constants.MaxUint256);await tx.wait();
  
 
  const swap1USDC = ethers.utils.parseUnits('10000', 6); // 10,000 USDC
  const swap2NISC = ethers.utils.parseUnits('1000', 18); // 1,000 NISC

  // Calculate fee for swaps (use the same vaultFee and PERCENT_DIVISOR from above)
  const swap1Fee = swap1USDC.mul(vaultFee).div(PERCENT_DIVISOR);
  const swap1Total = swap1USDC.add(swap1Fee);
  const swap2Fee = swap2NISC.mul(vaultFee).div(PERCENT_DIVISOR);
  const swap2Total = swap2NISC.add(swap2Fee);
    
  tx = await usdc.mint(exchangeUser0.address, swap1Total);await tx.wait();
  tx = await nisc.mint(exchangeUser0.address, swap2Total);await tx.wait();
  
  tx = await poolHelper.connect(exchangeUser0).swap(productPools[0],usdc.address,weth.address,swap1USDC,0,exchangeUser0.address);await tx.wait();
  tx = await poolHelper.connect(exchangeUser0).swap(productPools[1],nisc.address,usdc.address,swap2NISC,0,exchangeUser0.address);await tx.wait();

  // =========================================================
  // 6. CommunityInsurance Protocol
  // =========================================================

  console.log('=== CommunityInsurance Protocol Setup ===');

  // Deploy RewardDistributor contract first since CommunityInsurance needs it
  const RewardDistributor = await ethers.getContractFactory('RewardDistributor',lendingOwner);
  const rewardDistributor = await RewardDistributor.deploy(
    lendingOwner.address, // owner
    usdc.address, // rewardToken (USDC)
    ethers.utils.parseUnits('1', 6), // rewardRate (1 USDC per second)
    ethers.utils.parseUnits('10', 18) // optimalSupply (This translates to 10 WETH, due to the amounts deposited by communityInsuranceDepositor)
  );
  await rewardDistributor.deployed();
  console.log('RewardDistributor deployed to:', rewardDistributor.address);

  // Deploy CommunityInsurance contract with all three tokens
  const CommunityInsurance = await ethers.getContractFactory('CommunityInsurance',lendingOwner);
  const communityInsurance = await CommunityInsurance.deploy(
    'Community Insurance', // name
    'CI', // symbol
    lendingFactory.address, // factory
    rewardDistributor.address, // rewardDistributor
    [usdc.address, nisc.address, weth.address], // supported assets (USDC, NISC, WETH)
    24 * 3600, // withdrawDelay (24 hours)
    ethers.utils.parseUnits('100', 6) // minimalWithdraw (100 USDC)
  );
  await communityInsurance.deployed();
  console.log('CommunityInsurance deployed to:', communityInsurance.address);

  // Set the CommunityInsurance address in RewardDistributor
  tx = await rewardDistributor.setCommunityInsurance(communityInsurance.address);await tx.wait();
  console.log('CommunityInsurance address set in RewardDistributor');

  // Fund the reward distributor with USDC
  const rewardDistributorFunding = ethers.utils.parseUnits('120000', 6); // 120,00 USDC
  tx = await usdc.connect(lendingOwner).approve(rewardDistributor.address, rewardDistributorFunding);await tx.wait();
  tx = await usdc.mint(lendingOwner.address, rewardDistributorFunding);await tx.wait();
  tx = await rewardDistributor.connect(lendingOwner).fund(rewardDistributorFunding);await tx.wait();
  console.log('RewardDistributor funded with',ethers.utils.formatUnits(rewardDistributorFunding, 6),'USDC');

  // Calculate deposit amounts dynamically based on oracle prices
  const usdcDeposit = ethers.utils.parseUnits('40000', 6);
  const wethDeposit = usdcDeposit.mul(ethers.utils.parseUnits('1', 30)).div(wethPrice); // 40000 USD worth of WETH
  const niscDeposit = usdcDeposit.mul(ethers.utils.parseUnits('1', 30)).div(niscPrice); // 40000 USD worth of NISC

  // Fund the community insurance depositor with all tokens
  tx = await usdc.mint(communityInsuranceDepositor.address, usdcDeposit);await tx.wait();
  tx = await nisc.mint(communityInsuranceDepositor.address, niscDeposit);await tx.wait();
  await mintWeth(communityInsuranceDepositor, wethDeposit, weth);

  tx = await usdc.connect(communityInsuranceDepositor).approve(communityInsurance.address, usdcDeposit);await tx.wait();
  tx = await nisc.connect(communityInsuranceDepositor).approve(communityInsurance.address, niscDeposit);await tx.wait();
  tx = await weth.connect(communityInsuranceDepositor).approve(communityInsurance.address, wethDeposit);await tx.wait();

  // Deposit into CommunityInsurance
  tx = await communityInsurance.connect(communityInsuranceDepositor).deposit([usdcDeposit, niscDeposit, wethDeposit]);await tx.wait();
  console.log('CommunityInsurance depositor deposited all tokens');

  // =========================================================
  // 7. Investment Protocol
  // =========================================================

  console.log('=== Investment Protocol Setup ===');

  // Deploy the InvestmentVaultFactory
  const InvestmentVaultFactory = await ethers.getContractFactory('InvestmentVaultFactory',investmentOwner);
  const investmentVaultFactory = await InvestmentVaultFactory.deploy();
  await investmentVaultFactory.deployed();
  console.log('InvestmentVaultFactory deployed to:',investmentVaultFactory.address);

  // Create first USDC InvestmentVault instance.
  // Use callStatic to get the return value before executing
  const investmentVaultAddress1 = await investmentVaultFactory.connect(investmentOwner).callStatic.createInvestmentVault(
      usdc.address,
      'USDC Investment Vault 1',
      'iUSDC1',
      24 * 3600 // 24 hours delay for timelocks
    );
  tx = await investmentVaultFactory.connect(investmentOwner).createInvestmentVault(
      usdc.address,
      'USDC Investment Vault 1',
      'iUSDC1',
      24 * 3600
    );
  await tx.wait();
  console.log('InvestmentVault instance 1 deployed at:',investmentVaultAddress1);

  // Create second USDC InvestmentVault instance.
  const investmentVaultAddress2 = await investmentVaultFactory.connect(investmentOwner).callStatic.createInvestmentVault(
      usdc.address,
      'USDC Investment Vault 2',
      'iUSDC2',
      24 * 3600
    );
  tx = await investmentVaultFactory
    .connect(investmentOwner)
    .createInvestmentVault(
      usdc.address,
      'USDC Investment Vault 2',
      'iUSDC2',
      24 * 3600
    );
  await tx.wait();
  console.log('InvestmentVault instance 2 deployed at:',investmentVaultAddress2);

  const usdcIdleMarket = await investmentVaultFactory.idleMarkets(usdc.address);
  console.log('USDC IdleMarket deployed at:', usdcIdleMarket);

  // Assume these variables hold the addresses for the two USDC lending pools:
  const usdcPoolFromUSDCWETHTriad = lendingPoolsA[0]; // from lending deployment logic
  const usdcPoolFromUSDCNISCTriad = lendingPoolsA[1]; // as above

  // Also define a cap (the maximum USDC allowed) for each market
  const marketCap = ethers.utils.parseUnits('50000', 6);

  // For each InvestmentVault instance, submit and then accept the market additions.
  // We need to perform these actions from the owner of each InvestmentVault (which is investmentOwner):

  console.log('Submitting market additions...');

  const InvestmentVault1 = await ethers.getContractAt('InvestmentVault',investmentVaultAddress1,investmentOwner);
  tx = await InvestmentVault1.submitMarketAddition(usdcPoolFromUSDCWETHTriad,marketCap);await tx.wait();
  tx = await InvestmentVault1.submitMarketAddition(usdcPoolFromUSDCNISCTriad,marketCap);await tx.wait();
  // IdleMarket is now added automatically in the constructor

  const InvestmentVault2 = await ethers.getContractAt('InvestmentVault',investmentVaultAddress2,investmentOwner);
  tx = await InvestmentVault2.submitMarketAddition(usdcPoolFromUSDCNISCTriad,marketCap);await tx.wait();
  tx = await InvestmentVault2.submitMarketAddition(usdcPoolFromUSDCWETHTriad,marketCap);await tx.wait();
  // IdleMarket is now added automatically in the constructor

  console.log('Accepting market additions...');

  // Advance time by 24 hours (24 * 3600 seconds) to allow market additions to be accepted
  await advanceTime(24 * 3600);

  tx = await InvestmentVault1.connect(investmentOwner).acceptMarketAddition(usdcPoolFromUSDCWETHTriad);await tx.wait();
  tx = await InvestmentVault1.connect(investmentOwner).acceptMarketAddition(usdcPoolFromUSDCNISCTriad);await tx.wait();

  tx = await InvestmentVault2.connect(investmentOwner).acceptMarketAddition(usdcPoolFromUSDCNISCTriad);await tx.wait();
  tx = await InvestmentVault2.connect(investmentOwner).acceptMarketAddition(usdcPoolFromUSDCWETHTriad);await tx.wait();

  console.log('Investment users depositing...');

  const user0Vault1investmentAmountUSDC = ethers.utils.parseUnits('60000', 6); // 75,000 USDC
  const user1Vault1investmentAmountUSDC = ethers.utils.parseUnits('60000', 6); // 30,000 USDC

  // Investment users interactions
  tx = await usdc.connect(investmentUser0).approve(investmentVaultAddress1, user0Vault1investmentAmountUSDC);await tx.wait();
  tx = await usdc.mint(investmentUser0.address, user0Vault1investmentAmountUSDC);await tx.wait();
  tx = await InvestmentVault1.connect(investmentUser0).deposit(user0Vault1investmentAmountUSDC,investmentUser0.address);await tx.wait();
  
  tx = await usdc.connect(investmentUser1).approve(investmentVaultAddress2, user1Vault1investmentAmountUSDC);await tx.wait();
  tx = await usdc.mint(investmentUser1.address, user1Vault1investmentAmountUSDC);await tx.wait();
  tx = await InvestmentVault2.connect(investmentUser1).deposit(user1Vault1investmentAmountUSDC,investmentUser1.address);await tx.wait();


  
  console.log('Owner reallocations...');

  const marketReallocate1 = {
    market: usdcPoolFromUSDCWETHTriad,
    assets: ethers.utils.parseUnits('40000', 6),
  };

  const marketReallocate2 = {
    market: usdcPoolFromUSDCNISCTriad,
    assets: ethers.utils.parseUnits('15000', 6),
  };

  const marketReallocateIdle = {
    market: usdcIdleMarket,
    assets: ethers.constants.MaxUint256,
  };

  let allocation1 = [];
  allocation1.push(marketReallocate1);
  allocation1.push(marketReallocate2);
  allocation1.push(marketReallocateIdle);

  let allocation2 = [];
  allocation2.push(marketReallocate2);
  allocation2.push(marketReallocate1);
  allocation2.push(marketReallocateIdle);

  tx = await InvestmentVault1.connect(investmentOwner).reallocate(allocation1);await tx.wait();
  tx = await InvestmentVault2.connect(investmentOwner).reallocate(allocation2);await tx.wait();
  console.log('InvestmentVaults reallocation complete');

  let investmentVaults = [];
  investmentVaults.push(investmentVaultAddress1);
  investmentVaults.push(investmentVaultAddress2);

 // ------------------------------------------------------------
 // 8. Finish Setup
 // ------------------------------------------------------------

  console.log('Advancing time to attack phase...');

  await advanceTime(5 * 3600);
  const currentBlock2 = await ethers.provider.getBlock("latest");

  const config = {
    usdc: usdc.address,
    nisc: nisc.address,
    weth: weth.address,
    lottery: lottery.address,
    lotteryExtension: lottery.address,
    auctionVault: auctionVault.address,
    auctionManager: auctionManager.address,
    lendingPoolStrategy: lendingPoolStrategy.address,
    exchangeVault: exchangeVault.address,
    productPools: productPools,
    priceOracle: priceOracle.address,
    lendingFactory: lendingFactory.address,
    lendingManagers: lendingManagers,
    lendingPoolsA: lendingPoolsA,
    lendingPoolsB: lendingPoolsB,
    flashLoaner: flashLoaner.address,
    investmentFactory: investmentVaultFactory.address,
    usdcIdleMarket: usdcIdleMarket,
    investmentVaults: investmentVaults,
    communityInsurance: communityInsurance.address,
    rewardDistributor: rewardDistributor.address,
    attackTime: currentBlock2.timestamp,
  };

  fs.writeFileSync('deployed.json', JSON.stringify(config, null, 2));
  console.log('Deployment configuration saved to deployed.json');

  const attackContractSource = generateAttackContractSource(config);
  const publicDir = path.join(__dirname, '..', 'public');
  const attackContractPath = path.join(publicDir,'default.sol');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(attackContractPath, attackContractSource, 'utf8');
  console.log(`Generated Solidity file at: ${attackContractPath}`);

  const interfacesFolder = path.join(__dirname,'..','contracts','interfaces');
  const eventsAbi = buildEventsABI(interfacesFolder);
  
  const abiOutputPath = path.join(publicDir, 'eventsABI.json');
  fs.writeFileSync(abiOutputPath, JSON.stringify(eventsAbi, null, 2), 'utf8');
  console.log(`Events ABI has been written to ${abiOutputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
