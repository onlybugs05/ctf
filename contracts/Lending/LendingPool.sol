// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/ILendingPool.sol";

/**
 * @title LendingPool
 * @notice An ERC4626 vault for a single underlying asset.
 * In addition to standard deposit/withdraw functionality, supports borrow() and repay()
 * (called by the LendingManager) and maintains internal cash accounting with an interest index.
 */
contract LendingPool is ERC4626, ReentrancyGuard, ILendingPool {
    using SafeERC20 for IERC20;

    // Interest rate parameters (in 1e18 precision).
    uint256 public immutable rateMin;
    uint256 public immutable rateOptimal;
    uint256 public immutable rateMax;
    uint256 public immutable utilOptimal;

    // Debt index and timestamp.
    uint256 public index;
    uint256 public lastUpdate;
    uint256 public totalBorrowNormalized;

    // LendingManager authorized to call borrow() and repay().
    ILendingManager public immutable lendingManager;

    // Fee settings.
    address public immutable feeBeneficiary;
    uint256 public immutable feePercentage;

    // Flashloan fee (in basis points) is now set at the FlashLoaner level.

    // The centralized FlashLoaner allowed to withdraw/return funds.
    IFlashLoaner public immutable flashloanContract;

    // Internal liquidity tracking.
    uint256 internal _poolCash;

    // Track if a flashloan is currently active to prevent manipulation
    uint256 private flashloanAmount;

    modifier onlyFlashloanContract() {
        require(msg.sender == address(flashloanContract), "LendingPool: Caller is not flashloan contract");
        _;
    }

    modifier notDuringFlashloan() {
        require(!isFlashloanActive(), "LendingPool: Operation not allowed during flashloan");
        _;
    }
    modifier onlyLendingManager() {
        require(msg.sender == address(lendingManager), "LendingPool: Caller is not lending manager");
        _;
    }
    constructor(
        IERC20 asset,
        string memory name,
        string memory symbol,
        uint256 _rateMin,
        uint256 _rateOptimal,
        uint256 _rateMax,
        uint256 _utilOptimal,
        ILendingManager _lendingManager,
        address _feeBeneficiary,
        uint256 _feePercentage,
        IFlashLoaner _flashloanContract
    )
        ERC4626(asset)
        ERC20(name, symbol)
    {
        require(_rateMax >= _rateOptimal && _rateOptimal >= _rateMin, "LendingPool: Rate ordering invalid");
        require(_utilOptimal >= 0 && _utilOptimal < 1e18, "LendingPool: Invalid utilOptimal");
        require(_feePercentage <= 2e16, "LendingPool: Fee exceeds 2%");
        rateMin = _rateMin;
        rateOptimal = _rateOptimal;
        rateMax = _rateMax;
        utilOptimal = _utilOptimal;
        lendingManager = _lendingManager;
        feeBeneficiary = _feeBeneficiary;
        feePercentage = _feePercentage;
        flashloanContract = _flashloanContract;

        index = 1e18;
        lastUpdate = block.timestamp;
        _poolCash = 0;
    }

    function isFlashloanActive() public view returns (bool) {
        return flashloanAmount > 0;
    }
    function getCash() external view returns (uint256) {
        return _poolCash;
    }
    function getAnnualRate() external view returns (uint256 annualRate) {
        uint256 poolCash = _poolCash;
        uint256 currentDebt = (totalBorrowNormalized * index) / 1e18;
        uint256 totalSupplied = poolCash + currentDebt;
        uint256 utilization = totalSupplied > 0 ? (currentDebt * 1e18) / totalSupplied : 0;
        if (utilization <= utilOptimal) {
            annualRate = rateMin + ((rateOptimal - rateMin) * utilization) / utilOptimal;
        } else {
            annualRate = rateOptimal + ((rateMax - rateOptimal) * (utilization - utilOptimal)) / (1e18 - utilOptimal);
        }
        return annualRate;
    }
    // --- Fixed-Point Math Utilities ---
    function rpow(uint256 x, uint256 n, uint256 base) internal pure returns (uint256 result) {
        result = base;
        while (n > 0) {
            if (n & 1 == 1) {
                result = (result * x) / base;
            }
            x = (x * x) / base;
            n >>= 1;
        }
    }
   /**
     * @notice Approximates ln(1 + x) using a three‑term Taylor series.
     * @dev x is assumed to be small (typical annual rates) and is in 1e18 fixed-point.
     * ln(1+x) ≈ x - x²/2 + x³/3.
     * (Reordered as x + x³/3 - x²/2 to reduce intermediate underflow.)
     */
    function ln1p(uint256 x) internal pure returns (uint256) {
        uint256 x2 = (x * x) / 1e18;
        uint256 x3 = (x2 * x) / 1e18;
        return x + (x3 / 3) - (x2 / 2);
    }

    /**
     * @notice Updates the compounded interest index.
     */
    function updateIndex() notDuringFlashloan public {
        uint256 timeElapsed = block.timestamp - lastUpdate;
        if (timeElapsed == 0) return;

        uint256 poolCash = _poolCash;
        uint256 currentDebt = (totalBorrowNormalized * index) / 1e18;
        uint256 totalSupplied = poolCash + currentDebt;
        uint256 utilization = totalSupplied > 0 ? (currentDebt * 1e18) / totalSupplied : 0;
        uint256 annualRate;

        if (utilization <= utilOptimal) {
            annualRate = rateMin + ((rateOptimal - rateMin) * utilization) / utilOptimal;
        } else {
            annualRate = rateOptimal + ((rateMax - rateOptimal) * (utilization - utilOptimal)) / (1e18 - utilOptimal);
        }

        uint256 perSecondLogRate = ln1p(annualRate);
        uint256 perSecondRate = perSecondLogRate / 31536000; // Seconds per year.
        uint256 perSecondFactor = 1e18 + perSecondRate;
        uint256 compoundedFactor = rpow(perSecondFactor, timeElapsed, 1e18);

        index = (index * compoundedFactor) / 1e18;
        lastUpdate = block.timestamp;
    }

    /**
     * @notice Returns the total assets of the pool.
     * Applies the `notDuringFlashloan` modifier to avoid view reentrancy.
     */
    function totalAssets() public view override(ERC4626, IERC4626) notDuringFlashloan returns (uint256) {
        uint256 poolCash = _poolCash;
        uint256 currentDebt = (totalBorrowNormalized * index) / 1e18;
        return poolCash + currentDebt;
    }

    // --- Borrow & Repay (called by LendingManager) ---
    function borrow(uint256 amount, address to) external nonReentrant notDuringFlashloan onlyLendingManager {
        updateIndex();
        require(amount <= _poolCash, "LendingPool: Insufficient liquidity");
        uint256 normalizedDebt = Math.mulDiv(amount, 1e18, index, Math.Rounding.Ceil);
        totalBorrowNormalized += normalizedDebt;
        _poolCash -= amount;
        IERC20(asset()).safeTransfer(to, amount);
    }

    function repay(uint256 amount) external nonReentrant notDuringFlashloan onlyLendingManager {
        updateIndex();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        _poolCash += amount;
        uint256 normalizedRepay = Math.mulDiv(amount, 1e18, index, Math.Rounding.Floor);
        
        if (normalizedRepay > totalBorrowNormalized) {
            normalizedRepay = totalBorrowNormalized;
        }

        totalBorrowNormalized -= normalizedRepay;
    }

    function mint(uint256 shares, address receiver) public override(ERC4626, IERC4626) nonReentrant notDuringFlashloan returns (uint256 assets) {
        updateIndex();
        assets = super.mint(shares, receiver);
        _poolCash += assets;
        return assets;
    }
    function deposit(uint256 assets, address receiver) public override(ERC4626, IERC4626) nonReentrant notDuringFlashloan returns (uint256 shares) {
        updateIndex();
        shares = super.deposit(assets, receiver);
        _poolCash += assets;
        return shares;
    }
    
    function withdraw(uint256 assets, address receiver, address owner) public override(ERC4626, IERC4626) nonReentrant notDuringFlashloan returns (uint256 shares) {
        updateIndex();
        uint256 fee = (assets * feePercentage) / 1e18;
        uint256 netAssets = assets - fee;
        shares = super.withdraw(assets, address(this), owner);
        _poolCash -= assets;
        IERC20(asset()).safeTransfer(receiver, netAssets);
        IERC20(asset()).safeTransfer(feeBeneficiary, fee);
        return shares;
    }
    
    function redeem(uint256 shares, address receiver, address owner) public override(ERC4626, IERC4626) nonReentrant notDuringFlashloan returns (uint256 assets) {
        updateIndex();
        assets = super.redeem(shares, address(this), owner);
        uint256 fee = (assets * feePercentage) / 1e18;
        uint256 netAssets = assets - fee;
        _poolCash -= assets;
        IERC20(asset()).safeTransfer(receiver, netAssets);
        IERC20(asset()).safeTransfer(feeBeneficiary, fee);
        return assets;
    }

  
    /**
     * @notice Withdraws a specified amount of liquidity from the pool.
     * Callable only by the FlashLoaner.
     * @param amount The amount to withdraw.
     * @return The amount withdrawn.
     */
    function flashloanWithdraw(uint256 amount) external onlyFlashloanContract nonReentrant returns (uint256) {
        require(amount <= _poolCash, "LendingPool: Not enough cash for flashloan");
        flashloanAmount += amount;  
        _poolCash -= amount;
        IERC20(asset()).safeTransfer(msg.sender, amount);
        return amount;
    }

    /**
     * @notice Returns funds to the pool after a flashloan.
     * @param amount The liquidity amount to restore.
     */
    function flashloanReturn(uint256 amount) external onlyFlashloanContract nonReentrant {
        _poolCash += amount;
        flashloanAmount -= amount;
    }
}
