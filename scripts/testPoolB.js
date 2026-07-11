const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const WETH = await ethers.getContractAt('IERC20', deployed.weth);
  const pool = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsB[0]);
  console.log('WETH balance in LendingPoolB (WETH):', (await WETH.balanceOf(pool.address)).toString());
}
main().catch(console.error);
