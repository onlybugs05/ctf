const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const USDC = await ethers.getContractAt('IERC20', deployed.usdc);
  const pool = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsA[0]);
  console.log('USDC balance in PoolA:', (await USDC.balanceOf(pool.address)).toString());
}
main().catch(console.error);
