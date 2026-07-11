const { ethers } = require('hardhat');
const deployed = require('../deployed.json');

async function main() {
  const [attacker] = await ethers.getSigners();
  const ev = await ethers.getContractAt('contracts/Exchange/ExchangeVault.sol:ExchangeVault', deployed.exchangeVault);
  const WETH = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.weth);
  const USDC = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.usdc);
  const manager = await ethers.getContractAt('ILendingManager', deployed.lendingManagers[0]);
  const poolA = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsA[0]); // USDC
  const poolB = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsB[0]); // WETH
  
  const victim = await manager.debtorsA(0);
  console.log("Victim address:", victim);
  console.log("Victim debt before:", (await manager.getDebt(0, victim)).toString());
}
main().catch(console.error);
