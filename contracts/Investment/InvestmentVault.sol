// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "../interfaces/IInvestmentVault.sol";

/// @notice An ERC4626 vault where only the owner manages market allocations.
/// Market additions, removals, and limit updates require a time delay.
contract InvestmentVault is 
    ERC4626, 
    Ownable, 
    ReentrancyGuard,
    IInvestmentVault
{
    using Math for uint256;
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Constants and Types
    // ──────────────────────────────────────────────────────────────

    uint8 public DEC_OFFSET;
    uint256 public constant WAD = 1e18;
    
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant MAX_DELAY = 30 days;

    // ──────────────────────────────────────────────────────────────
    // State Variables
    // ──────────────────────────────────────────────────────────────

    // Global time delay for market changes.
    uint256 public delay;

    // Pending delay update.
    PendingChange public pendingDelay;

    // Array of markets used for investing funds.
    IERC4626[] public markets;
    // Information per market.
    mapping(IERC4626 => MarketInfo) public marketInfo;

    // Pending market additions (for markets not yet enabled).
    mapping(IERC4626 => PendingChange) public pendingMarketAddition;

    // Pending market limit (cap) update.
    mapping(IERC4626 => PendingChange) public pendingMarketLimit;

    // ──────────────────────────────────────────────────────────────
    // Additional state variable for IdleMarket
    IIdleMarket public immutable idleMarket;



    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /// @notice Constructor to initialize the InvestmentVault.
    /// @param _owner The owner of the vault.
    /// @param _initialDelay The initial delay for timelocked operations.
    /// @param _asset The underlying asset.
    /// @param _name The name of the InvestmentVault token.
    /// @param _symbol The symbol of the InvestmentVault token.
    /// @param _idleMarket The IdleMarket instance.
    constructor(
        address _owner,
        uint256 _initialDelay,
        IERC20 _asset,
        string memory _name,
        string memory _symbol,
        IIdleMarket _idleMarket
    )
        ERC4626(_asset)
        ERC20(_name, _symbol)
        Ownable(_owner)
    {
        require(address(_asset) != address(0), "Zero asset address");
        require(address(_idleMarket) != address(0), "Zero idleMarket address");
        require(_idleMarket.asset() == address(_asset), "IdleMarket asset mismatch");
        
        // Set DEC_OFFSET = max(0, 18 - asset decimals)
        uint8 assetDecimals = IERC20Metadata(address(_asset)).decimals();
        DEC_OFFSET = (18 > assetDecimals) ? uint8(18 - assetDecimals) : 0;

        require(_initialDelay >= MIN_DELAY && _initialDelay <= MAX_DELAY, "Delay out of bounds");
        delay = _initialDelay;
        idleMarket = _idleMarket;
        
        // Add IdleMarket as the first (and always last) market with no cap (cap = 0 means unlimited)
        markets.push(IERC4626(address(_idleMarket)));
        marketInfo[IERC4626(address(_idleMarket))] = MarketInfo({
            cap: type(uint256).max,  // no limit for IdleMarket
            enabled: true,
            pendingRemovalTimestamp: 0
        });
        _asset.forceApprove(address(_idleMarket), type(uint256).max);
    }


    /// @notice Returns all markets currently enabled in the vault.
    /// @return Array of IERC4626 market addresses.
    function getMarkets() external view returns (IERC4626[] memory) {
        return markets;
    }
    
    // ──────────────────────────────────────────────────────────────
    // Market Management (Only Owner)
    // ──────────────────────────────────────────────────────────────

    /// @notice Submit a market for addition with a given cap.
    /// @dev IdleMarket is added in the constructor and cannot be added again.
    function submitMarketAddition(IERC4626 market, uint256 cap) external onlyOwner {
        require(address(market) != address(0), "Zero market address");
        require(address(market) != address(idleMarket), "Cannot add IdleMarket");
        require(market.asset() == asset(), "Inconsistent asset");
        require(!marketInfo[market].enabled, "Market already enabled");
        require(pendingMarketAddition[market].validAt == 0, "Already pending");

        pendingMarketAddition[market] = PendingChange({
            value: cap,
            validAt: block.timestamp + delay
        });
        emit MarketAdditionSubmitted(market, cap, block.timestamp + delay);
    }

    /// @notice Accept a pending market addition after the delay.
    /// @dev New markets are inserted before IdleMarket to keep IdleMarket at the end.
    function acceptMarketAddition(IERC4626 market) external onlyOwner nonReentrant {
        PendingChange memory pending = pendingMarketAddition[market];
        require(pending.validAt != 0, "No pending addition");
        require(block.timestamp >= pending.validAt, "Delay not elapsed");

        marketInfo[market] = MarketInfo({
            cap: pending.value,
            enabled: true,
            pendingRemovalTimestamp: 0
        });
        
        // Insert the new market before IdleMarket (which is always last)
        uint256 len = markets.length;
        require(len > 0 && address(markets[len - 1]) == address(idleMarket), "IdleMarket not last");
        
        // Add the new market at the end
        markets.push(market);
        // Swap it with the last position (IdleMarket)
        markets[len - 1] = market;
        markets[len] = IERC4626(address(idleMarket));
        
        IERC20(asset()).forceApprove(address(market), type(uint256).max);
        delete pendingMarketAddition[market];
        emit MarketAdditionAccepted(market, pending.value);
    }

    /// @notice Submit a market for removal. (Cap must be zero.)
    /// @dev IdleMarket cannot be removed.
    function submitMarketRemoval(IERC4626 market) external onlyOwner {
        require(address(market) != address(idleMarket), "Cannot remove IdleMarket");
        require(marketInfo[market].enabled, "Market not enabled");
        require(marketInfo[market].cap == 0, "Non-zero cap");
        require(marketInfo[market].pendingRemovalTimestamp == 0, "Removal already pending");

        marketInfo[market].pendingRemovalTimestamp = block.timestamp + delay;
        emit MarketRemovalSubmitted(market, block.timestamp + delay);
    }

    /// @notice Accept a pending market removal after the delay.
    /// @dev Ensures IdleMarket remains at the end when removing other markets.
    function acceptMarketRemoval(IERC4626 market) external onlyOwner {
        uint256 removalTime = marketInfo[market].pendingRemovalTimestamp;
        require(removalTime != 0, "No pending removal");
        require(block.timestamp >= removalTime, "Delay not elapsed");

        // Ensure the market holds no funds.
        uint256 market_balance = IERC20(address(market)).balanceOf(address(this));
        require(market_balance == 0, "Market still holds funds");

        // Remove market from the array while keeping IdleMarket at the end.
        uint256 len = markets.length;
        require(len > 1, "Cannot remove last market");  // At least IdleMarket must remain
        require(address(markets[len - 1]) == address(idleMarket), "IdleMarket not last");
        
        for (uint256 i = 0; i < len - 1; i++) {  // Don't check the last position (IdleMarket)
            if (markets[i] == market) {
                // Swap with second-to-last market (just before IdleMarket)
                markets[i] = markets[len - 2];
                // Remove the second-to-last position and shift IdleMarket down
                markets[len - 2] = markets[len - 1];
                markets.pop();
                break;
            }
        }
        
        IERC20(asset()).forceApprove(address(market), 0);
        delete marketInfo[market];
        emit MarketRemovalAccepted(market);
    }

    /// @notice Submit an update to the market cap.
    function submitMarketLimitUpdate(IERC4626 market, uint256 newCap) external onlyOwner {
        require(marketInfo[market].enabled, "Market not enabled");
        require(pendingMarketLimit[market].validAt == 0, "Update already pending");

        pendingMarketLimit[market] = PendingChange({
            value: newCap,
            validAt: block.timestamp + delay
        });
        emit MarketLimitUpdateSubmitted(market, newCap, block.timestamp + delay);
    }

    /// @notice Accept a pending market cap update after the delay.
    function acceptMarketLimitUpdate(IERC4626 market) external onlyOwner {
        PendingChange memory pending = pendingMarketLimit[market];
        require(pending.validAt != 0, "No pending update");
        require(block.timestamp >= pending.validAt, "Delay not elapsed");

        marketInfo[market].cap = pending.value;
        delete pendingMarketLimit[market];
        emit MarketLimitUpdateAccepted(market, pending.value);
    }

    /// @notice Submit a new delay value.
    function submitDelayChange(uint256 newDelay) external onlyOwner {
        require(newDelay != delay, "Delay already set");
        require(newDelay >= MIN_DELAY && newDelay <= MAX_DELAY, "Delay out of bounds");
        require(pendingDelay.validAt == 0, "Delay change already pending");

        pendingDelay = PendingChange({
            value: newDelay,
            validAt: block.timestamp + delay
        });
        emit DelayChangeSubmitted(newDelay, block.timestamp + delay);
    }

    /// @notice Accept the pending delay change.
    function acceptDelayChange() external onlyOwner {
        require(pendingDelay.validAt != 0, "No pending delay change");
        require(block.timestamp >= pendingDelay.validAt, "Delay not elapsed");

        delay = pendingDelay.value;
        delete pendingDelay;
        emit DelayChangeAccepted(delay);
    }

    // ──────────────────────────────────────────────────────────────
    // Fund Reallocation (Only Owner)
    // ──────────────────────────────────────────────────────────────

    /// @notice Reallocate funds between markets to match target asset amounts.
    /// For each allocation, if current assets exceed target then withdraw the difference;
    /// if lower then deposit the difference.
    function reallocate(MarketAllocation[] calldata allocations)
        external
        onlyOwner
        nonReentrant
    {
        uint256 totalWithdrawn;
        uint256 totalDeposited;
        for (uint256 i = 0; i < allocations.length; i++) {
            MarketAllocation calldata alloc = allocations[i];
            (uint256 currentAssets, ) = marketBalance(alloc.market);
            if (alloc.assets == type(uint256).max) {
                uint256 toDeposit = totalWithdrawn - totalDeposited;
                if (toDeposit > 0){
                    // Check allocation cap if set.
                    MarketInfo memory info = marketInfo[alloc.market];
                    require(currentAssets + toDeposit <= info.cap, "Cap exceeded");
                    alloc.market.deposit(toDeposit, address(this));
                    totalDeposited += toDeposit;
                    emit MarketReallocatedDeposit(alloc.market, toDeposit);
                }
            }
            else if (currentAssets > alloc.assets) {
                uint256 toWithdraw = currentAssets - alloc.assets;
                // Withdraw using ERC4626's interface.
                alloc.market.withdraw(toWithdraw, address(this), address(this));
                totalWithdrawn += toWithdraw;
                emit MarketReallocatedWithdraw(alloc.market, toWithdraw);
            } else if (alloc.assets > currentAssets) {
                uint256 toDeposit = alloc.assets - currentAssets;
                // Check allocation cap if set.
                MarketInfo memory info = marketInfo[alloc.market];
                require(alloc.assets <= info.cap, "Cap exceeded");
                alloc.market.deposit(toDeposit, address(this));
                totalDeposited += toDeposit;
                emit MarketReallocatedDeposit(alloc.market, toDeposit);
            }
        }
        require(totalWithdrawn == totalDeposited, "Inconsistent reallocation");
    }

    // ──────────────────────────────────────────────────────────────
    // Market Balance Helpers
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the asset balance (and underlying shares) in a given market.
    function marketBalance(IERC4626 market)
        public
        view
        returns (uint256 assets, uint256 shares)
    {
        shares = IERC20(address(market)).balanceOf(address(this));
        assets = market.convertToAssets(shares);
    }

    // ──────────────────────────────────────────────────────────────
    // Overridden Deposit/Redeem/Withdraw Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Deposits funds and then supplies them into managed markets.
    function deposit(uint256 assets, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256 shares)
    {
        shares = super.deposit(assets, receiver);
        _supplyFunds(assets);
    }

    /// @notice Mints vault shares by depositing funds and supplying them into markets.
    function mint(uint256 shares, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256 assets)
    {
        assets = super.mint(shares, receiver);
        _supplyFunds(assets);
    }

    /// @notice Withdraws funds from markets prior to processing the vault withdrawal.
    function withdraw(
        uint256 assets,
        address receiver,
        address owner_
    ) public override(ERC4626, IERC4626) nonReentrant returns (uint256 shares) {
        shares = super.previewWithdraw(assets);
        _withdrawFunds(assets);
        super._withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    /// @notice Redeems vault shares by withdrawing funds from markets.
    function redeem(
        uint256 shares,
        address receiver,
        address owner_
    ) public override(ERC4626, IERC4626) nonReentrant returns (uint256 assets) {
        assets = super.previewRedeem(shares);
        _withdrawFunds(assets);
        super._withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    // ──────────────────────────────────────────────────────────────
    // Overridden Total assets
    // ──────────────────────────────────────────────────────────────

        function totalAssets() public view virtual override(ERC4626, IERC4626) returns (uint256 assets) {
        uint256 length = markets.length;

        for (uint256 i; i < length; ++i) {
            IERC4626 market = markets[i];
            assets += _expectedSupplyAssets(market);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Internal Helpers for Funding Markets
    // ──────────────────────────────────────────────────────────────

    /// @notice Invests the specified amount across enabled markets.
    function _supplyFunds(uint256 assets) internal {
        uint256 remaining = assets;
        for (uint256 i = 0; i < markets.length; i++) {
            IERC4626 market = markets[i];
            MarketInfo memory info = marketInfo[market];
            if (!info.enabled || info.cap == 0) {
                continue;
            }
            (uint256 currentAssets, ) = marketBalance(market);
            uint256 availableCap = (info.cap > currentAssets) ? info.cap - currentAssets : 0;
            uint256 toDeposit = (availableCap < remaining) ? availableCap : remaining;
            market.deposit(toDeposit, address(this));
            remaining -= toDeposit;
            if (remaining == 0) break;
        }
        require(remaining == 0, "Not all assets supplied. Markets at cap");
    }

    /// @notice Withdraws the requested asset amount from the markets.
    function _withdrawFunds(uint256 assets) internal {
        uint256 remaining = assets;
        for (uint256 i = markets.length ; i > 0 ; i--) {
            IERC4626 market = markets[i-1];
            uint256 available = market.maxWithdraw(address(this));
            uint256 toWithdraw = (available < remaining) ? available : remaining;
            if (toWithdraw > 0) {
                try market.withdraw(toWithdraw, address(this), address(this)) returns (uint256) {
                    remaining -= toWithdraw;
                } catch {
                    // Skip this market if withdrawal fails.
                }
            }
            if (remaining == 0) break;
        }
        require(remaining == 0, "Not enough liquidity in markets");
    }

    function _expectedSupplyAssets(IERC4626 _market) internal view returns (uint256 assets) {
        assets = _market.convertToAssets(_market.balanceOf(address(this)));
    }

    // ──────────────────────────────────────────────────────────────
    // Overridden Decimals
    // ──────────────────────────────────────────────────────────────

    function decimals() public view override(ERC4626, IERC20Metadata) returns (uint8) {
        return ERC4626.decimals();
    }
}
