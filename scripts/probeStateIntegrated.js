const { ethers } = require("hardhat");
const { main: setupInitialState } = require("./setupInitialState");

async function main() {
  await setupInitialState();
  const deployed = require("../deployed.json");
  const lottery = await ethers.getContractAt("ILottery", deployed.lottery);
  const auction = await ethers.getContractAt("IAuctionManager", deployed.auctionManager);
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", deployed.usdc);
  const weth = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", deployed.weth);
  const nisc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", deployed.nisc);
  const exchangeVault = await ethers.getContractAt(
    "contracts/interfaces/IExchangeVault.sol:IExchangeVault",
    deployed.exchangeVault
  );

  console.log("=== PROBE ===");
  for (let i = 0; i < 3; i++) {
    console.log("ticket", i, "base", (await lottery.getBasePrize(i)).toString());
    console.log("auction", i, await auction.getCurrentPrice(i).catch(() => ethers.constants.Zero));
  }
  console.log("lottery USDC", (await usdc.balanceOf(deployed.lottery)).toString());
  console.log("exchange WETH", (await weth.balanceOf(deployed.exchangeVault)).toString());
  console.log("exchange USDC", (await usdc.balanceOf(deployed.exchangeVault)).toString());
  console.log("exchange NISC", (await nisc.balanceOf(deployed.exchangeVault)).toString());
  for (const pool of deployed.productPools) {
    console.log("pool", pool, "USDC", (await exchangeVault.poolBalances(pool, deployed.usdc)).toString());
    console.log("pool", pool, "WETH", (await exchangeVault.poolBalances(pool, deployed.weth)).toString());
    console.log("pool", pool, "NISC", (await exchangeVault.poolBalances(pool, deployed.nisc)).toString());
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
