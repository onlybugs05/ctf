const { ethers } = require('hardhat'); 
async function main() { 
    const lm = await ethers.getContractAt('ILendingManager', '0x610178dA211FEF7D417bC0e6FeD39F05609AD788'); 
    try {
        const debtorsA = await lm.debtorsA(0); 
        console.log('DebtorsA 0:', debtorsA); 
    } catch (e) { console.log('No debtorsA 0'); }
    try {
        const debtorsB = await lm.debtorsB(0); 
        console.log('DebtorsB 0:', debtorsB); 
    } catch (e) { console.log('No debtorsB 0'); }
} 
main();
