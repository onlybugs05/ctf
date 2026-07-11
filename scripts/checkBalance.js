const { ethers } = require('hardhat');
const deployed = require('../deployed.json');

async function main() {
  const usdc = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.usdc);
  const bal = await usdc.balanceOf(deployed.usdcIdleMarket);
  console.log('usdcIdleMarket balance:', ethers.utils.formatUnits(bal, 6));
}

main().catch(console.error);
