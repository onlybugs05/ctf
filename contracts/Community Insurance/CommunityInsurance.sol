// File: CommunityInsurance.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/ICommunityInsurance.sol";
import "../interfaces/ILendingPool.sol";
import "../interfaces/IRewardDistributor.sol";
import "../interfaces/ILendingManager.sol";
import "../interfaces/ILendingFactory.sol";

/**
 * @title CommunityInsurance
 * @notice ERC20 shares backed by a basket of supported assets; used to cover bad debt.
 */
contract CommunityInsurance is ERC20, ICommunityInsurance {
    using SafeERC20 for IERC20;

    ILendingFactory public immutable factory;
    IRewardDistributor public immutable rewardDistributor;

    uint256 public immutable withdrawDelay;
    uint256 public immutable minimalWithdraw;
    uint256 public totalLockedShares;

    IERC20[] public supportedAssets;
    
    mapping(IERC20 => bool) public isSupported;
    mapping(address => WithdrawRequest) public withdrawRequests;
    mapping(IERC20 => uint256) public internalBalance;

    constructor(
        string memory name_,
        string memory symbol_,
        address factory_,
        address rewardDistributor_,
        IERC20[] memory assets_,
        uint256 withdrawDelay_,
        uint256 minimalWithdraw_
    ) ERC20(name_, symbol_) {
        require(assets_.length > 0, "No assets");
        factory = ILendingFactory(factory_);
        rewardDistributor = IRewardDistributor(rewardDistributor_);
        withdrawDelay = withdrawDelay_;
        minimalWithdraw = minimalWithdraw_;
        for (uint256 i = 0; i < assets_.length; i++) {
            IERC20 asset = assets_[i];
            require(address(asset) != address(0) && !isSupported[asset], "Invalid or duplicate asset");
            isSupported[asset] = true;
            supportedAssets.push(asset);
            internalBalance[asset] = asset.balanceOf(address(this));
        }
    }

    /// @notice Returns internal-accounted balances of all supported assets
    function totalAssets() public view returns (uint256[] memory) {
        uint256 n = supportedAssets.length;
        uint256[] memory arr = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            arr[i] = internalBalance[supportedAssets[i]];
        }
        return arr;
    }

    /**
     * Standard deposit logic (updates internalBalance)
     */
    function deposit(uint256[] calldata amounts) external {
        uint256 n = supportedAssets.length;
        require(amounts.length == n, "Bad length");
        uint256 supply = totalSupply();
        uint256[] memory preBal = totalAssets();
        uint256 mintShares;
        if (supply == 0) {
            mintShares = 1e18;
        } else {
            for (uint256 i = 0; i < n; i++) {
                require(preBal[i] > 0, "Zero pool balance");
                uint256 candidate = (amounts[i] * supply) / preBal[i];
                if (i == 0) mintShares = candidate;
                else require(candidate == mintShares, "Unequal ratio");
            }
        }
        for (uint256 i = 0; i < n; i++) {
            IERC20 asset = supportedAssets[i];
            asset.safeTransferFrom(msg.sender, address(this), amounts[i]);
            internalBalance[asset] += amounts[i];
        }
        _mint(msg.sender, mintShares);
    }

    /**
     * Queue shares for withdrawal; locks them until completion.
     */
    function requestWithdraw(uint256 shares) external {
        require(shares > 0, "Zero shares");
        WithdrawRequest storage req = withdrawRequests[msg.sender];
        require(balanceOf(msg.sender) >= req.shares + shares, "Insufficient free");
        req.shares += shares;
        req.timestamp = block.timestamp;
        totalLockedShares += shares;
        require(req.shares >= minimalWithdraw, "Below minimal");
    }

    /**
     * Complete withdrawal after delay: burn shares and transfer underlying proportionally, updating internalBalance.
     */
    function completeWithdraw() external {
        WithdrawRequest memory req = withdrawRequests[msg.sender];
        require(req.shares > 0, "No request");
        require(block.timestamp >= req.timestamp + withdrawDelay, "Too early");
        uint256 shares = req.shares;
        delete withdrawRequests[msg.sender];
        totalLockedShares -= shares;

        uint256 supply = totalSupply();
        uint256 n = supportedAssets.length;
        _burn(msg.sender, shares);

        for (uint256 i = 0; i < n; i++) {
            IERC20 asset = supportedAssets[i];
            uint256 prev = internalBalance[asset];
            uint256 out = (shares * prev) / supply;
            internalBalance[asset] = prev - out;
            asset.safeTransfer(msg.sender, out);
        }
    }

    /**
     * Liquidate bad debt for any asset type, approve exact debt amount, then redeem collateral.
     * @param manager The address of the lending manager contract
     * @param user The address of the user with bad debt
     * @param assetType Which asset (A or B) has the bad debt
     * @return collateralShares Amount of collateral shares received
     * @return receivedAmount Amount of collateral tokens received
     */
    function liquidateBadDebt(ILendingManager manager, address user, ILendingManager.AssetType assetType) 
        public 
         
        returns (uint256 collateralShares, uint256 receivedAmount) 
    {
        // Verify the manager is from the factory
        ILendingFactory fac = ILendingFactory(factory);
        uint256 count = fac.getTrioCount();
        bool found;
        for (uint256 i = 0; i < count; i++) {
            (ILendingManager m,,) = fac.getTrio(i);
            if (address(m) == address(manager)) { found = true; break; }
        }
        require(found, "Unknown manager");

        ILendingManager lm = ILendingManager(manager);
        require(isSupported[lm.assetA()] && isSupported[lm.assetB()], "Assets not supported");
        
        // Check if the position has bad debt using the AssetType-based interface
        require(lm.isBadDebt(assetType, user), "Not bad debt");


        // Determine debt and collateral tokens based on assetType
        IERC20 debtToken;
        IERC20 collateralToken;
        ILendingPool collateralPool;
        
        if (assetType == ILendingManager.AssetType.A) {
            debtToken = lm.assetA();
            collateralToken = lm.assetB();
            collateralPool = lm.poolB();
        } else {
            debtToken = lm.assetB();
            collateralToken = lm.assetA();
            collateralPool = lm.poolA();
        }

        // Compute exact debt to cover
        uint256 debtAmount = lm.getDebt(assetType, user);

        // Approve exactly the debt using OZ forceApprove
        debtToken.forceApprove(address(manager), debtAmount);

        // Perform liquidation using the AssetType-based interface
        collateralShares = lm.liquidate(assetType, user);

        // Deduct from internal debt token balance
        internalBalance[debtToken] -= debtAmount;

        // Redeem collateral
        receivedAmount = collateralPool.redeem(collateralShares, address(this), address(this));
        internalBalance[collateralToken] += receivedAmount;
        
        return (collateralShares, receivedAmount);
    }

    /// @notice Free (unlocked) share balance of a user.
    function freeBalanceOf(address user) external view returns(uint256) {
        return balanceOf(user) - withdrawRequests[user].shares;
    }

    /// @notice Total free supply (i.e. totalSupply minus locked shares).
    function freeSupply() public view returns(uint256) {
        return totalSupply() - totalLockedShares;
    }

    /**
     * @dev Hook that is called during any token transfer, including minting and burning.
     *
     * Overrides the ERC20 _update hook to prevent transferring locked shares and
     * to update rewards via the reward distributor after the transfer.
     */
    function _update(address from, address to, uint256 value) internal override {        
        // Prevent transferring locked shares
        if (from != address(0)) {
            uint256 locked = withdrawRequests[from].shares;
            // Check that the amount being transferred does not exceed the user's free (unlocked) balance.
            // balanceOf(from) is the balance *before* the transfer occurs within super._update.
            require(balanceOf(from) >= locked + value, "Transfer exceeds free balance");
        }
        
        // Perform the actual transfer/mint/burn by calling the parent ERC20 implementation
        super._update(from, to, value);

        // Update rewards for sender and receiver for the pre-update balances
        // Current balances and totalSupply are now updated from super._update.
        uint256 totalFree = freeSupply();

        // if tokens moved within same account, do a single update for its free balance
        if (from == to && from != address(0)) {
            uint256 free = balanceOf(from) - withdrawRequests[from].shares;
            try IRewardDistributor(rewardDistributor).updateReward(from, free, totalFree) {} catch {}
            return;
        }
        // Update rewards for the sender if it's not a mint operation
        if (from != address(0)) {
            
            // Update locked shares for the sender, if needed
            WithdrawRequest storage req = withdrawRequests[from];
            uint256 delta = 0;
            uint256 originalShares = req.shares;
            if (originalShares > balanceOf(from)) {
                delta = originalShares - balanceOf(from);
                totalLockedShares -= delta;
                req.shares -= delta;
                if (req.shares == 0) 
                    delete withdrawRequests[from];
            }
            
            uint256 freeFrom = balanceOf(from) + value - originalShares;
            try IRewardDistributor(rewardDistributor).updateReward(from, freeFrom, totalFree) {} catch {}
        }

        // Update rewards for the receiver if it's not a burn operation
        if (to != address(0)) {
            uint256 freeTo = balanceOf(to) - withdrawRequests[to].shares - value;
             try IRewardDistributor(rewardDistributor).updateReward(to, freeTo, totalFree) {} catch {}
        }
    }
}
