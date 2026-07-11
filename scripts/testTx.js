const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const tx = await ethers.provider.getTransactionReceipt('0xfb645d7eb29f5a66cdc4421d4ea4b3c3cdcc1cb5afc0dcab7a0f4ba917f3f716');
  if (!tx) { console.log('Transaction not found'); return; }
  console.log('Gas used:', tx.gasUsed.toString());
  const manager = await ethers.getContractAt('ILendingManager', deployed.lendingManagers[0]);
  for (const log of tx.logs) {
    try {
      const parsed = manager.interface.parseLog(log);
      console.log(parsed.name, parsed.args);
    } catch(e) {}
  }
}
main().catch(console.error);
