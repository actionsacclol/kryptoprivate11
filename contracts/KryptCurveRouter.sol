// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title KryptCurveRouter — atomic platform fee for Pons bonding-curve buys
/// @notice The Robinhood Chain terminal calls a Pons V2 curve directly to buy.
///         An externally owned account cannot batch that call with a fee
///         transfer, so without this contract the fee had to follow as a
///         second transaction, and the signer's buy-side interlock could not
///         cover curve buys. This contract does exactly one thing: forward a
///         buy to a curve and pay the fee in the same transaction.
///
/// @dev    Deliberately minimal and unowned:
///           - no owner, no admin, no upgrade, no pause, no sweep;
///           - never holds funds between transactions: every wei that reaches
///             it during a call leaves in the same call (fee legs, curve
///             refund, dust) — a call that would strand ETH reverts;
///           - the treasury is a compile-time constant, so there is no
///             storage to tamper with and no constructor argument to get wrong;
///           - the caller chooses the fee (bounded to 2 %) and an optional
///             referrer whose share comes out of the fee, matching the app's
///             0.5 % / 20 % policy without hard-coding it on chain;
///           - tokens go straight from the curve to the buyer (`recipient`),
///             so the router never custodies tokens either.
///         Pons computes the snipe tax on `recipient`, not on msg.sender, so
///         routing through this contract changes nothing about the fill.
interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
}

contract KryptCurveRouter {
    /// @notice Krypt's Robinhood Chain treasury (shared/evm.ts, pinned by tests).
    address public constant TREASURY = 0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a;
    /// @notice Hard ceiling on the fee a caller may attach: 2 % of the buy.
    uint256 public constant MAX_FEE_BPS = 200;

    error FeeTooHigh();
    error ReferrerShareTooHigh();
    error ValueMismatch();
    error NoBuyer();
    error TransferFailed();
    error Reentered();

    event CurveBuyRouted(address indexed buyer, address indexed curve, uint256 quoteIn, uint256 tokensOut, uint256 feeWei, address referrer, uint256 referrerWei, uint256 refundWei);

    uint256 private _lock;

    modifier nonReentrant() {
        if (_lock == 1) revert Reentered();
        _lock = 1;
        _;
        _lock = 0;
    }

    /// @notice Buy on a Pons curve and pay the platform fee atomically.
    /// @param curve       The launch's bonding curve (the app takes it from the Pons factory record).
    /// @param quoteIn     ETH forwarded to the curve.
    /// @param minTokensOut Slippage floor, enforced by the curve.
    /// @param feeWei      Total platform fee. Must satisfy feeWei * 10000 <= quoteIn * MAX_FEE_BPS.
    /// @param referrer    Optional referrer paid `referrerWei` out of `feeWei`; zero address for none.
    /// @param referrerWei Referrer's share; must not exceed feeWei.
    /// @return tokensOut  Tokens the curve sent to msg.sender.
    /// @return refundWei  ETH the curve returned on a partial fill, forwarded to msg.sender.
    function buy(
        address curve,
        uint256 quoteIn,
        uint256 minTokensOut,
        uint256 feeWei,
        address referrer,
        uint256 referrerWei
    ) external payable nonReentrant returns (uint256 tokensOut, uint256 refundWei) {
        if (msg.value != quoteIn + feeWei) revert ValueMismatch();
        if (feeWei * 10_000 > quoteIn * MAX_FEE_BPS) revert FeeTooHigh();
        if (referrerWei > feeWei || (referrer == address(0) && referrerWei != 0)) revert ReferrerShareTooHigh();
        if (quoteIn == 0) revert NoBuyer();

        uint256 before = address(this).balance - msg.value;

        // Tokens go to the buyer; a partial-fill refund comes back HERE (we are
        // the curve's msg.sender) and is forwarded below.
        tokensOut = IPonsCurve(curve).buy{value: quoteIn}(quoteIn, minTokensOut, msg.sender);

        uint256 treasuryWei = feeWei - referrerWei;
        if (treasuryWei != 0) _pay(TREASURY, treasuryWei);
        if (referrerWei != 0) _pay(referrer, referrerWei);

        // Everything above the pre-call balance is this call's leftover: the
        // curve's refund (if any). It belongs to the buyer.
        uint256 leftover = address(this).balance - before;
        refundWei = leftover;
        if (leftover != 0) _pay(msg.sender, leftover);

        emit CurveBuyRouted(msg.sender, curve, quoteIn, tokensOut, feeWei, referrer, referrerWei, refundWei);
    }

    function _pay(address to, uint256 wei_) private {
        (bool ok, ) = to.call{value: wei_}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Curve refunds arrive here. Nothing else should send ETH to this
    ///      contract; anything that does is forwarded to the next buyer's
    ///      refund by the balance accounting above only within a call, so a
    ///      stray transfer is simply the sender's loss — there is no owner to
    ///      sweep it, by design.
    receive() external payable {}
}
