const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const pool = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsB[0]);
  const shares = await pool.convertToShares(ethers.utils.parseEther('52'));
  console.log('52 WETH in shares:', shares.toString());
}
main().catch(console.error);
