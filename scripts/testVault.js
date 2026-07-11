const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const WETH = await ethers.getContractAt('IERC20', deployed.weth);
  const pool = await ethers.getContractAt('ILendingPool', deployed.lendingPoolsB[0]);
  const vault = await ethers.getContractAt('IExchangeVault', deployed.exchangeVault);
  const p = await ethers.getContractAt('IPool', deployed.productPools[0]);
  const wethBalance = await WETH.balanceOf(deployed.exchangeVault);
  console.log('WETH balance in Vault:', wethBalance.toString());
  const usdcWethPoolTokens = await vault.getPoolTokens(p.address);
  console.log('USDC/WETH Pool Tokens:', usdcWethPoolTokens);
}
main().catch(console.error);
