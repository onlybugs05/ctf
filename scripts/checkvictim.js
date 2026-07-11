const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const WETH = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.weth);
  const pool = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsB[0]);
  const manager = await ethers.getContractAt('ILendingManager', deployed.lendingManagers[0]);
  console.log('PoolB WETH balance:', (await WETH.balanceOf(pool.address)).toString());
  const victim = '0xfa614DEB6D1b897099C15B512c5A62C6a6611bdC';
  const pos = await manager.positions(victim);
  console.log('Victim collateral shares:', pos.collateralBShares.toString());
}
main().catch(console.error);
