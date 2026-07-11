const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const manager = await ethers.getContractAt('ILendingManager', deployed.lendingManagers[0]);
  const result = await manager.getLiquidatable(0);
  console.log('Liquidatable Users A:', result.users);
  const resultB = await manager.getLiquidatable(1);
  console.log('Liquidatable Users B:', resultB.users);
}
main().catch(console.error);
