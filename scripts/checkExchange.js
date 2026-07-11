const { ethers } = require('hardhat');
const deployed = require('../deployed.json');
async function main() {
  const WETH = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.weth);
  const USDC = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', deployed.usdc);
  const Exchange = await ethers.getContractAt('IExchangeVault', '0x776B51e76150de6D50B06fD0Bd045de0a13D68C7');
  console.log('WETH balance of ExchangeVault:', (await WETH.balanceOf('0x776B51e76150de6D50B06fD0Bd045de0a13D68C7')).toString());
  console.log('USDC balance of ExchangeVault:', (await USDC.balanceOf('0x776B51e76150de6D50B06fD0Bd045de0a13D68C7')).toString());
}
main().catch(console.error);
