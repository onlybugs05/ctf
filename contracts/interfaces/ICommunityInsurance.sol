// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./ILendingFactory.sol";
import "./IRewardDistributor.sol";
import "./ILendingManager.sol";

interface ICommunityInsurance is IERC20 {
    // Struct to track pending withdrawals
    struct WithdrawRequest {
        uint256 shares;
        uint256 timestamp;
    }

    // View functions
    function factory() external view returns (ILendingFactory);
    function rewardDistributor() external view returns (IRewardDistributor);
    function withdrawDelay() external view returns (uint256);
    function minimalWithdraw() external view returns (uint256);
    function supportedAssets(uint256 index) external view returns (IERC20);
    function isSupported(IERC20 token) external view returns (bool);
    function withdrawRequests(address user) external view returns (uint256 shares, uint256 timestamp);
    function totalLockedShares() external view returns (uint256);
    function internalBalance(IERC20 token) external view returns (uint256);
    function totalAssets() external view returns (uint256[] memory);
    function freeBalanceOf(address user) external view returns (uint256);
    function freeSupply() external view returns (uint256);


    // Core operations
    function deposit(uint256[] calldata amounts) external;
    function requestWithdraw(uint256 shares) external;
    function completeWithdraw() external;
    function liquidateBadDebt(ILendingManager manager, address user, ILendingManager.AssetType assetType) 
        external 
        returns (uint256 collateralShares, uint256 receivedAmount);
}
