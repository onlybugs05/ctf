// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;


import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../interfaces/ILendingManager.sol";

/**
 * @title LendingManager
 * @notice Manages positions for an isolated lending trio.
 */
 
contract LendingManager is Ownable, ReentrancyGuard, ILendingManager {
    
    // --- State Variables ---
    
    // Pools and their assets
    ILendingPool public poolA;
    ILendingPool public poolB;
    IERC20 public assetA;
    IERC20 public assetB;
    
    // Minimum collateral per user position in USD (scaled by 1e18)
    uint256 public constant MIN_COLLATERAL_USD = 10 * 1e18;
    
    // LTV and LT in 1e18 precision (e.g., 0.8e18 and 0.9e18).
    uint256 public LTV;
    uint256 public LT;
    
    IPriceOracle public priceOracle;
    bool public poolsSet;
    bool private _initialized;
    
    // Track positions and debtors
    mapping(address => Position) public positions;
    address[] public debtorsA;
    address[] public debtorsB;
    mapping(address => bool) public isDebtorA;
    mapping(address => bool) public isDebtorB;

    // --- Constructor and Initialization ---
    
    constructor(IPriceOracle _oracle, uint256 _LTV, uint256 _LT) Ownable(msg.sender) {
        priceOracle = _oracle;
        LTV = _LTV;
        LT = _LT;
    }

    
    function setPools(ILendingPool _poolA, ILendingPool _poolB) external {
        require(!poolsSet, "LendingManager: Pools already set");
        poolA = _poolA;
        poolB = _poolB;
        assetA = IERC20(poolA.asset());
        assetB = IERC20(poolB.asset());
        poolsSet = true;
    }
    
    
    /**
     * @dev Get the pool and asset based on asset type
     */
    function _getPoolAndAsset(AssetType assetType) internal view returns (
        ILendingPool pool,
        IERC20 asset,
        uint256 collateralField,
        uint256 borrowField
    ) {
        if (assetType == AssetType.A) {
            pool = poolA;
            asset = assetA;
            collateralField = 1; // collateralAShares (0) or collateralBShares (1)
            borrowField = 0;     // normalizedBorrowA (0) or normalizedBorrowB (1)
        } else {
            pool = poolB;
            asset = assetB;
            collateralField = 0; // inverse of above
            borrowField = 1;
        }
        require(!pool.isFlashloanActive(), "LendingManager: Pool is in an active flashloan state");
    }
    
    /**
     * @dev Get collateral info based on asset type
     */
    function _getCollateral(Position storage pos, AssetType assetType) internal view returns (
        uint256 shares,
        uint256 underlying,
        uint256 usdValue
    ) {
        (ILendingPool pool, IERC20 asset,,) = _getPoolAndAsset(assetType);
        
        if (assetType == AssetType.A) {
            shares = pos.collateralAShares;
        } else {
            shares = pos.collateralBShares;
        }
        
        underlying = pool.convertToAssets(shares);
        uint8 decimals = IERC20Metadata(address(asset)).decimals();
        usdValue = (underlying * priceOracle.getPrice(asset)) / (10 ** decimals);
    }
    
    /**
     * @dev Get debt info based on asset type
     */
    function _getDebtInfo(Position storage pos, AssetType assetType) internal view returns (
        uint256 normalizedDebt,
        uint256 actualDebt,
        uint256 usdValue
    ) {
        (ILendingPool pool, IERC20 asset,,) = _getPoolAndAsset(assetType);
        
        if (assetType == AssetType.A) {
            normalizedDebt = pos.normalizedBorrowA;
        } else {
            normalizedDebt = pos.normalizedBorrowB;
        }
        
        actualDebt = Math.mulDiv(normalizedDebt, pool.index(), 1e18, Math.Rounding.Ceil);
        uint8 decimals = IERC20Metadata(address(asset)).decimals();
        usdValue = (actualDebt * priceOracle.getPrice(asset)) / (10 ** decimals);
    }
    
    
    function lockCollateral(AssetType assetType, uint256 shares) external {
        require(poolsSet, "LendingManager: Pools not set");
        
        (ILendingPool pool, IERC20 asset,,) = _getPoolAndAsset(assetType);
        
        // Transfer shares from user to this contract
        pool.transferFrom(msg.sender, address(this), shares);
        
        // Update position
        if (assetType == AssetType.A) {
            positions[msg.sender].collateralAShares += shares;
        } else {
            positions[msg.sender].collateralBShares += shares;
        }
        
        // Check minimum collateral requirement
        (,, uint256 totalUSD) = _getCollateral(positions[msg.sender], assetType);
        require(totalUSD >= MIN_COLLATERAL_USD, "LendingManager: collateral below minimum");
        
        emit LockedCollateral(msg.sender, asset, shares);
    }
    
    /**
     * @dev Internal function to unlock collateral
     */
    function unlockCollateral(AssetType assetType, uint256 shares) external {
        Position storage pos = positions[msg.sender];
        (ILendingPool pool, IERC20 asset,,) = _getPoolAndAsset(assetType);   //borrowField and collateralField are not used
        
        // Check if user has enough shares
        uint256 lockedShares = assetType == AssetType.A ? pos.collateralAShares : pos.collateralBShares;
        require(lockedShares >= shares, "LendingManager: Insufficient locked collateral");
        
        uint256 remainingShares = lockedShares - shares;
        
        // Get the opposing asset type for debt check
        AssetType opposingType = assetType == AssetType.A ? AssetType.B : AssetType.A;
        
        // Calculate remaining collateral and debt values
        uint256 remainingUnderlying = pool.convertToAssets(remainingShares);
        uint8 assetDecimals = IERC20Metadata(address(asset)).decimals();
        uint256 collateralUSD = (remainingUnderlying * priceOracle.getPrice(asset)) / (10 ** assetDecimals);
        
        // Get the debt in the opposing asset
        (,, uint256 debtUSD) = _getDebtInfo(pos, opposingType);
        
        // Ensure position remains healthy
        require((collateralUSD * LTV) / 1e18 >= debtUSD, "LendingManager: Unlock would undercollateralize");
        
        // Enforce either zero or above minimum
        require(remainingShares == 0 || collateralUSD >= MIN_COLLATERAL_USD,
                "LendingManager: residual collateral below minimum");
        
        // Update position
        if (assetType == AssetType.A) {
            pos.collateralAShares = remainingShares;
        } else {
            pos.collateralBShares = remainingShares;
        }
        
        // Transfer shares back to user
        pool.transfer(msg.sender, shares);
        
        emit UnlockedCollateral(msg.sender, asset, shares);
    }
    
    /**
     * @dev Internal function to borrow assets
     */
    function borrow(AssetType assetType, uint256 amount) external {
        Position storage pos = positions[msg.sender];
        
        // This returns the pool we're borrowing FROM and the asset we're borrowing
        (ILendingPool borrowPool, IERC20 borrowAsset,, ) = _getPoolAndAsset(assetType);
        
        // For collateral, we need the OPPOSING asset type
        AssetType collateralType = assetType == AssetType.A ? AssetType.B : AssetType.A;
        (ILendingPool collateralPool, IERC20 collateralAsset,,) = _getPoolAndAsset(collateralType);
        
        // Check if user has collateral
        uint256 collateralShares = collateralType == AssetType.A ? pos.collateralAShares : pos.collateralBShares;
        require(collateralShares > 0, "LendingManager: No collateral locked");
        
        // Get collateral value
        uint256 collateralUnderlying = collateralPool.convertToAssets(collateralShares);
        uint256 collateralUSD = (collateralUnderlying * priceOracle.getPrice(collateralAsset)) / (10 **  IERC20Metadata(address(collateralAsset)).decimals());
        
        // Get current debt and calculate new debt
        uint256 normalizedDebt = assetType == AssetType.A ? pos.normalizedBorrowA : pos.normalizedBorrowB;
        uint256 actualDebt = Math.mulDiv(normalizedDebt, borrowPool.index(), 1e18, Math.Rounding.Ceil);
        uint256 newDebtUSD = ((actualDebt + amount) * priceOracle.getPrice(borrowAsset)) / (10 ** IERC20Metadata(address(borrowAsset)).decimals());
        
        // Check against LTV
        require(newDebtUSD <= (collateralUSD * LTV) / 1e18, "LendingManager: Exceeds LTV");
        
        // Update position
        if (assetType == AssetType.A) {
            pos.normalizedBorrowA += Math.mulDiv(amount, 1e18, borrowPool.index(), Math.Rounding.Ceil);
            _addDebtor(AssetType.A, msg.sender);
        } else {
            pos.normalizedBorrowB += Math.mulDiv(amount, 1e18, borrowPool.index(), Math.Rounding.Ceil);
            _addDebtor(AssetType.B, msg.sender);
        }
        
        // Execute borrow and transfer
        borrowPool.borrow(amount, address(this));
        borrowAsset.transfer(msg.sender, amount);
        
        emit Borrowed(msg.sender, borrowAsset, amount);
    }
    
    /**
     * @dev Internal function to repay debt
     */
    function repay(AssetType assetType, uint256 amount) external {
        Position storage pos = positions[msg.sender];
        
        (ILendingPool pool, IERC20 asset,,) = _getPoolAndAsset(assetType);
        
        // Get actual debt
        uint256 normalizedDebt = assetType == AssetType.A ? pos.normalizedBorrowA : pos.normalizedBorrowB;
        uint256 actualDebt = Math.mulDiv(normalizedDebt, pool.index(), 1e18, Math.Rounding.Ceil);
        
        // Cap repayment to full debt
        if (amount > actualDebt) {
            amount = actualDebt;
        }
        
        // Transfer tokens from user for repayment
        asset.transferFrom(msg.sender, address(this), amount);
        asset.approve(address(pool), amount);
        pool.repay(amount);
        
        // Update position
        uint256 normalizedRepay = Math.mulDiv(amount, 1e18, pool.index(), Math.Rounding.Floor);
        if (assetType == AssetType.A) {
            pos.normalizedBorrowA = pos.normalizedBorrowA - normalizedRepay;
            if (pos.normalizedBorrowA == 0) {
                _removeDebtor(AssetType.A, msg.sender);
            }
        } else {
            pos.normalizedBorrowB = pos.normalizedBorrowB - normalizedRepay;
            if (pos.normalizedBorrowB == 0) {
                _removeDebtor(AssetType.B, msg.sender);
            }
        }
        
        emit Repaid(msg.sender, asset, amount);
    }
    
    /**
     * @dev Check if a position can be liquidated
     */
    function canLiquidate(AssetType assetType, address target) public view returns (bool) {
        Position storage pos = positions[target];
        
        // Get debt
        uint256 normalizedDebt = assetType == AssetType.A ? pos.normalizedBorrowA : pos.normalizedBorrowB;
        if (normalizedDebt == 0) return false;
        
        // Get opposing asset type for collateral
        AssetType collateralType = assetType == AssetType.A ? AssetType.B : AssetType.A;
        
        // Get debt and collateral values
        (,, uint256 debtUSD) = _getDebtInfo(pos, assetType);
        (,, uint256 collateralUSD) = _getCollateral(pos, collateralType);
        
        return debtUSD > (collateralUSD * LT) / 1e18;
    }
    
    /**
     * @dev Check if a position has bad debt
     */
    function isBadDebt(AssetType assetType, address target) external view returns (bool) {
        Position storage pos = positions[target];
        
        // Get debt
        uint256 normalizedDebt = assetType == AssetType.A ? pos.normalizedBorrowA : pos.normalizedBorrowB;
        if (normalizedDebt == 0) return false;
        
        // Get opposing asset type for collateral
        AssetType collateralType = assetType == AssetType.A ? AssetType.B : AssetType.A;
        
        // Get debt and collateral values
        (,, uint256 debtUSD) = _getDebtInfo(pos, assetType);
        (,, uint256 collateralUSD) = _getCollateral(pos, collateralType);
        
        return debtUSD > collateralUSD;
    }
    
    /**
     * @dev Get debt for a position
     */
    function getDebt(AssetType assetType, address target) public view returns (uint256 actualDebt) {
        Position storage pos = positions[target];
        
        if (assetType == AssetType.A) {
            actualDebt = Math.mulDiv(pos.normalizedBorrowA, poolA.index(), 1e18, Math.Rounding.Ceil);
        } else {
            actualDebt = Math.mulDiv(pos.normalizedBorrowB, poolB.index(), 1e18, Math.Rounding.Ceil);
        }
    }
    
    
    /**
     * @dev Liquidate a position
     */
    function liquidate(AssetType assetType, address target) external returns (uint256 collateralShares_) {
        require(canLiquidate(assetType, target), "LendingManager: Position is healthy");
        
        Position storage pos = positions[target];
        (ILendingPool debtPool, IERC20 debtAsset,,) = _getPoolAndAsset(assetType);
        
        // Get debt amount
        uint256 actualDebt = getDebt(assetType, target);
        
        // Transfer tokens from liquidator to repay the debt
        debtAsset.transferFrom(msg.sender, address(this), actualDebt);
        debtAsset.approve(address(debtPool), actualDebt);
        debtPool.repay(actualDebt);
        
        // Clear debt
        if (assetType == AssetType.A) {
            pos.normalizedBorrowA = 0;
            _removeDebtor(AssetType.A, target);
        } else {
            pos.normalizedBorrowB = 0;
            _removeDebtor(AssetType.B, target);
        }
        
        // Get the collateral info (the opposite asset of the debt)
        AssetType collateralType = assetType == AssetType.A ? AssetType.B : AssetType.A;
        (ILendingPool collateralPool, IERC20 collateralAsset,,) = _getPoolAndAsset(collateralType);
        
        // Transfer collateral to liquidator
        if (collateralType == AssetType.A) {
            collateralShares_ = pos.collateralAShares;
            pos.collateralAShares = 0;
        } else {
            collateralShares_ = pos.collateralBShares;
            pos.collateralBShares = 0;
        }
        
        collateralPool.transfer(msg.sender, collateralShares_);
        
        emit Liquidation(msg.sender,target,debtAsset,actualDebt,collateralAsset,collateralShares_);
    }
    
    /**
     * @dev Get all liquidatable positions for an asset type
     */
    function getLiquidatable(AssetType assetType) external view returns (
        address[] memory users,
        uint256[] memory collateralShares,
        uint256[] memory debtAmounts
    ) {
        address[] storage debtors = assetType == AssetType.A ? debtorsA : debtorsB;
        uint256 total = debtors.length;
        uint256 count = 0;
        
        // First pass: count how many are liquidatable
        for (uint256 i = 0; i < total; ++i) {
            if (canLiquidate(assetType, debtors[i])) {
                count++;
            }
        }
        
        // Allocate arrays
        users = new address[](count);
        collateralShares = new uint256[](count);
        debtAmounts = new uint256[](count);
        
        // Second pass: fill arrays
        uint256 idx = 0;
        for (uint256 i = 0; i < total; ++i) {
            address usr = debtors[i];
            if (canLiquidate(assetType, usr)) {
                users[idx] = usr;
                
                // Get the associated collateral type (opposite of debt type)
                AssetType collateralType = assetType == AssetType.A ? AssetType.B : AssetType.A;
                
                // Get collateral shares
                if (collateralType == AssetType.A) {
                    collateralShares[idx] = positions[usr].collateralAShares;
                } else {
                    collateralShares[idx] = positions[usr].collateralBShares;
                }
                
                // Get debt amount
                debtAmounts[idx] = getDebt(assetType, usr);
                
                idx++;
            }
        }
    }

    /**
     * @dev Add a debtor to the tracking list
     */
    function _addDebtor(AssetType assetType, address user) internal {
        if (assetType == AssetType.A) {
            if (!isDebtorA[user]) {
                isDebtorA[user] = true;
                debtorsA.push(user);
            }
        } else {
            if (!isDebtorB[user]) {
                isDebtorB[user] = true;
                debtorsB.push(user);
            }
        }
    }
    
    /**
     * @dev Remove a debtor from the tracking list
     */
    function _removeDebtor(AssetType assetType, address user) internal {
        if (assetType == AssetType.A) {
            if (isDebtorA[user]) {
                isDebtorA[user] = false;
                uint256 len = debtorsA.length;
                for (uint256 i = 0; i < len; ++i) {
                    if (debtorsA[i] == user) {
                        debtorsA[i] = debtorsA[len - 1];
                        debtorsA.pop();
                        break;
                    }
                }
            }
        } else {
            if (isDebtorB[user]) {
                isDebtorB[user] = false;
                uint256 len = debtorsB.length;
                for (uint256 i = 0; i < len; ++i) {
                    if (debtorsB[i] == user) {
                        debtorsB[i] = debtorsB[len - 1];
                        debtorsB.pop();
                        break;
                    }
                }
            }
        }
    }
}
