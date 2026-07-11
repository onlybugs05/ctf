const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const manager = await ethers.getContractAt('ILendingManager', deployed.lendingManagers[0]);
  const victim = '0xfa614DEB6D1b897099C15B512c5A62C6a6611bdC';
  const isHealthy = await manager.canLiquidate(0, victim);
  console.log('Can liquidate?', isHealthy);
}
main().catch(console.error);
