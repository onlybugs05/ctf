// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";

import "../interfaces/ILendingManager.sol";
import "../interfaces/IFlashLoaner.sol";

/// @title Interface for LendingPool
/// @notice Exposes core ERC4626 methods plus borrow/repay and flashloan operations
interface ILendingPool is IERC4626 {

    // --- State Variable Getters ---
    function rateMin() external view returns (uint256);
    function rateOptimal() external view returns (uint256);
    function rateMax() external view returns (uint256);
    function utilOptimal() external view returns (uint256);
    function index() external view returns (uint256);
    function lastUpdate() external view returns (uint256);
    function totalBorrowNormalized() external view returns (uint256);
    function lendingManager() external view returns (ILendingManager);
    function feeBeneficiary() external view returns (address);
    function feePercentage() external view returns (uint256);
    function flashloanContract() external view returns (IFlashLoaner);

    // --- Custom getters ---
    function getCash() external view returns (uint256);
    function getAnnualRate() external view returns (uint256);

    // --- Index Management ---
    function updateIndex() external;

    // --- Borrow & Repay (called by LendingManager) ---
    function borrow(uint256 amount, address to) external;
    function repay(uint256 amount) external;

    // --- Flashloan support ---
    function flashloanWithdraw(uint256 amount) external returns (uint256);
    function flashloanReturn(uint256 amount) external;
    function isFlashloanActive() external view returns (bool);
}
