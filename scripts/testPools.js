const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const WETH = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.weth);
  const USDC = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.usdc);
  const poolB = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsB[0]);
  const poolA = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsA[0]);
  console.log('WETH balance in LendingPoolB:', (await WETH.balanceOf(poolB.address)).toString());
  console.log('USDC balance in LendingPoolA:', (await USDC.balanceOf(poolA.address)).toString());
}
main().catch(console.error);
