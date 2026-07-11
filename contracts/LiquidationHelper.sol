// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IFlashLoaner {
    function flashloan(address asset, uint256 amount, address receiver, bytes calldata data) external;
    function flashloanFee() external view returns (uint256);
}

interface IFlashLoanReceiver {
    function onCallback(bytes calldata data) external;
}

interface ILendingManager {
    function liquidate(uint8 assetType, address target) external returns (uint256);
    function getDebt(uint8 assetType, address target) external view returns (uint256);
    function canLiquidate(uint8 assetType, address target) external view returns (bool);
    function poolB() external view returns (address);
}

interface ILendingPool {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title LiquidationHelper
 * @notice Flash-loans USDC to liquidate lendingUser2, receives WETH shares, redeems to WETH.
 */
contract LiquidationHelper is IFlashLoanReceiver {
    IFlashLoaner public immutable flashLoaner;
    IERC20 public immutable usdc;
    ILendingManager public immutable manager;
    ILendingPool public immutable wethPool;
    IERC20 public immutable weth;
    address public immutable owner;

    constructor(
        address _flashLoaner,
        address _usdc,
        address _manager,
        address _wethPool,
        address _weth
    ) {
        flashLoaner = IFlashLoaner(_flashLoaner);
        usdc = IERC20(_usdc);
        manager = ILendingManager(_manager);
        wethPool = ILendingPool(_wethPool);
        weth = IERC20(_weth);
        owner = msg.sender;
    }

    function execute(address target) external {
        require(msg.sender == owner, "only owner");
        uint256 debtAmount = manager.getDebt(0, target);
        require(debtAmount > 0, "no debt");
        bytes memory data = abi.encode(target, debtAmount);
        flashLoaner.flashloan(address(usdc), debtAmount, address(this), data);
    }

    function onCallback(bytes calldata data) external override {
        require(msg.sender == address(flashLoaner), "only flashloaner");
        (address target, uint256 debtAmount) = abi.decode(data, (address, uint256));

        // Approve manager to pull USDC for repayment
        usdc.approve(address(manager), debtAmount);

        // Liquidate: repay USDC debt, receive WETH pool shares
        uint256 wethShares = manager.liquidate(0, target);

        // Redeem WETH shares → WETH
        if (wethShares > 0) {
            wethPool.approve(address(wethPool), wethShares);
            wethPool.redeem(wethShares, address(this), address(this));
        }

        // Repay flash loan: need debtAmount + fee back in USDC
        // We already hold remaining USDC from the loan (debtAmount) plus pre-funded fee
        // Approve flashloaner to take it back (it checks balanceOf)
        // The flashloaner checks: balanceOf >= initialBalance + fee
        // initialBalance was 0 before loan, so we need debtAmount + fee in our balance
        // We already have debtAmount from the loan minus what we repaid via liquidate
        // Actually: we USED debtAmount to liquidate. The manager took it.
        // So our USDC is 0 after liquidation. We need fee from pre-funded amount.
        // The flashloaner will transferFrom? No - it checks balance directly.
        // After callback, flashloaner checks our USDC balance >= fee.
        // We pre-funded this contract with fee USDC. That stays.
        // But wait - the flashloaner sent us debtAmount, we used it for liquidate.
        // After that our balance = pre-funded fee amount. The loaner checks >= 0 + fee. OK.
    }

    function withdrawTokens(address token, address to) external {
        require(msg.sender == owner, "only owner");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(to, bal);
    }
}
