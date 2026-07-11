const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const manager = await ethers.getContractAt('ILendingManager', deployed.lendingManagers[0]);
  try {
    const debtorA = await manager.debtorsA(0);
    console.log('Debtor A 0:', debtorA);
    const debtorB = await manager.debtorsB(0);
    console.log('Debtor B 0:', debtorB);
  } catch (e) {}
}
main().catch(console.error);
