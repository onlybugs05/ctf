const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const USDC = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.usdc);
  const manager = await ethers.getContractAt('ILendingManager', deployed.lendingManagers[0]);
  console.log('Manager:', manager.address);
  // Address from the revert
  console.log('Balance:', (await USDC.balanceOf('0x4e1A669e32C9590100d0D97D54628F5460e0A33d')).toString());
}
main().catch(console.error);
