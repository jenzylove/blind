// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BlindSettlement, IERC20} from "../contracts/BlindSettlement.sol";

/// Stand-ins for QoreChain's precompiles. The real ML-DSA-87 path is proven on testnet
/// (docs/spikes). Here a "signature" is keccak256(pubkey, message), so only the holder
/// of the matching test key can produce it, and any change to the message breaks it.
contract MockStatus {
    mapping(address => bytes) public keys;
    mapping(address => bool) public unproven;
    function set(address who, bytes calldata key, bool proven) external { keys[who] = key; unproven[who] = !proven; }
    function pqcKeyStatus(address who) external view returns (bool, uint8, bytes memory, bool) {
        bytes memory k = keys[who];
        return (k.length > 0, 1, k, k.length > 0 && !unproven[who]);
    }
}

contract MockVerify {
    function pqcVerify(bytes calldata key, bytes calldata sig, bytes calldata message) external pure returns (bool) {
        return sig.length == 32 && bytes32(sig) == keccak256(abi.encodePacked(key, message));
    }
}

contract Token {
    string public symbol;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(string memory s) { symbol = s; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external virtual returns (bool) { return _move(msg.sender, to, a); }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance");
        allowance[f][msg.sender] -= a;
        return _move(f, to, a);
    }
    function _move(address f, address to, uint256 a) internal returns (bool) {
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// A hostile token: when the settlement pays it out, it tries to re-enter withdraw with a valid
/// agent signature. Used to answer the QCAI reentrancy finding.
contract EvilToken is Token {
    address public target;
    bytes public data;
    bool public tried;
    bool public reentryOk;
    constructor() Token("EVIL") {}
    function arm(address t, bytes calldata d) external { target = t; data = d; }
    function transfer(address to, uint256 a) external override returns (bool) {
        if (target != address(0) && !tried) { tried = true; (reentryOk,) = target.call(data); }
        return _move(msg.sender, to, a);
    }
}

contract BlindSettlementTest is Test {
    address constant VERIFY = address(0x0A01);
    address constant STATUS = address(0x0A02);

    BlindSettlement s;
    Token fETH;
    Token fUSD;
    address agent = makeAddr("agent");
    address settler = makeAddr("settler");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address mallory = makeAddr("mallory");

    uint128 bid;
    uint128 ask;
    bytes32 constant SK = keccak256("batch secret key");

    function _key(address who) internal pure returns (bytes memory) { return abi.encodePacked("key-of-", who); }
    function _sign(address who, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(_key(who), message)));
    }

    function setUp() public {
        vm.etch(STATUS, address(new MockStatus()).code);
        vm.etch(VERIFY, address(new MockVerify()).code);
        address[6] memory who = [agent, alice, bob, carol, mallory, settler];
        for (uint256 i; i < who.length; ++i) MockStatus(STATUS).set(who[i], _key(who[i]), true);

        fETH = new Token("fETH");
        fUSD = new Token("fUSD");
        s = new BlindSettlement(IERC20(address(fETH)), IERC20(address(fUSD)), agent, settler, treasury, 100);
        // price = fUSD base units per fETH base unit x 1e18: 2,700 fUSD per fETH = 2700e6 * 1e18 / 1e18
        bid = uint128(uint256(2_690e6) * 1e18 / 1e18);
        ask = uint128(uint256(2_710e6) * 1e18 / 1e18);
        // Market maker inventory sits in the contract.
        fETH.mint(address(s), 1e18);
        fUSD.mint(address(s), 3_000e6);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            fETH.mint(users[i], 1e18);
            fUSD.mint(users[i], 10_000e6);
            vm.startPrank(users[i]);
            fETH.approve(address(s), type(uint256).max);
            fUSD.approve(address(s), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------ helpers

    function _batch() internal returns (uint64 id) {
        vm.prank(settler);
        id = s.create(keccak256(abi.encodePacked(SK)));
    }

    function _flat(uint128 maxNet) internal view returns (BlindSettlement.Curve memory) {
        return BlindSettlement.Curve(bid, ask, bid, ask, maxNet);
    }

    function _commitCurve(uint64 id, BlindSettlement.Curve memory c) internal {
        uint64 exp = uint64(block.number + 50);
        bytes memory sig = _sign(agent, s.quoteMessage(id, c, exp));
        s.commit(id, c, exp, sig);
    }

    function _commit(uint64 id, uint128 maxNet) internal {
        _commitCurve(id, _flat(maxNet));
    }

    function _open(uint64 id) internal {
        vm.roll(block.number + 1);
        s.open(id, abi.encodePacked(SK));
    }

    function _ready(uint128 maxNet) internal returns (uint64 id) {
        id = _batch();
        s.post(id, hex"c0ffee");
        _commit(id, maxNet);
        _open(id);
    }

    function _order(address user, uint64 id, bool buy, uint256 amountIn, uint256 minOut) internal view returns (BlindSettlement.Order memory) {
        return BlindSettlement.Order(user, id, uint64(block.number + 40), buy, amountIn, minOut, 1);
    }

    function _sigOf(BlindSettlement.Order memory o) internal view returns (bytes memory) {
        return _sign(o.user, this.orderMessageOf(o));
    }
    function orderMessageOf(BlindSettlement.Order calldata o) external view returns (bytes memory) { return s.orderMessage(o); }

    function _settle(uint64 id, BlindSettlement.Order[] memory os) internal {
        bytes[] memory sigs = new bytes[](os.length);
        for (uint256 i; i < os.length; ++i) sigs[i] = _sigOf(os[i]);
        vm.prank(settler);
        s.settle(id, os, sigs);
    }

    function _one(BlindSettlement.Order memory o) internal pure returns (BlindSettlement.Order[] memory a) {
        a = new BlindSettlement.Order[](1); a[0] = o;
    }

    // ------------------------------------------------------------ pricing

    function test_netBuyingClearsAtTheAsk() public {
        uint64 id = _ready(0.5e18);
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](3);
        os[0] = _order(alice, id, true, 2_710e6, 0.99e18);   // buys about 1 fETH
        os[1] = _order(bob, id, true, 1_355e6, 0.49e18);     // buys about 0.5 fETH
        os[2] = _order(carol, id, false, 1e18, 2_600e6);     // sells 1 fETH
        uint256 makerEth = fETH.balanceOf(address(s));
        _settle(id, os);
        (,,,,,,,,,,, uint128 price) = s.batches(id);
        assertEq(price, ask);
        assertEq(fETH.balanceOf(alice), 2e18);
        assertEq(fETH.balanceOf(bob), 1.5e18);
        assertEq(fUSD.balanceOf(carol), 10_000e6 + 2_710e6, "the seller also gets the ask: one price for all");
        assertEq(makerEth - fETH.balanceOf(address(s)), 0.5e18, "maker sold the net 0.5 fETH");
    }

    function test_netSellingClearsAtTheBid() public {
        uint64 id = _ready(1e18);
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = _order(alice, id, false, 1e18, 2_600e6);
        os[1] = _order(bob, id, true, 1_345e6, 0.4e18);
        _settle(id, os);
        (,,,,,,,,,,, uint128 price) = s.batches(id);
        assertEq(price, bid);
        assertEq(fUSD.balanceOf(alice), 10_000e6 + 2_690e6);
        assertEq(fETH.balanceOf(bob), 1.5e18);
    }

    function test_crossingInsideTheBandMakerTradesNothing() public {
        uint64 id = _ready(1); // the maker will absorb at most 1 wei of fETH
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = _order(alice, id, true, 2_700e6, 0.99e18);  // 2,700 fUSD
        os[1] = _order(bob, id, false, 1e18, 2_600e6);      // 1 fETH
        uint256 eth0 = fETH.balanceOf(address(s));
        uint256 usd0 = fUSD.balanceOf(address(s));
        _settle(id, os); // still succeeds: users matched each other
        (,,,,,,,,,,, uint128 price) = s.batches(id);
        assertEq(price, 2_700e6);
        assertEq(fETH.balanceOf(address(s)), eth0);
        assertEq(fUSD.balanceOf(address(s)), usd0);
    }

    function testFuzz_priceAlwaysInsideTheCommittedBand(uint96 quoteIn, uint96 baseIn) public view {
        vm.assume(quoteIn > 0 || baseIn > 0);
        uint256 p = s.clearingPrice(_flat(1e18), quoteIn, baseIn);
        assertGe(p, bid);
        assertLe(p, ask);
    }

    // ------------------------------------------------------------ curve

    // bid 2,690 / ask 2,710 at a tiny net, 2,600 / 2,800 at the full 0.5 fETH.
    function _curve() internal view returns (BlindSettlement.Curve memory) {
        return BlindSettlement.Curve(bid, ask, 2_600e6, 2_800e6, 0.5e18);
    }

    function _curveAt(BlindSettlement.Curve memory c, uint256 n, bool makerSells) internal pure returns (uint256) {
        return makerSells ? c.ask + (uint256(c.askMax) - c.ask) * n / c.maxNet : c.bid - (uint256(c.bid) - c.bidMax) * n / c.maxNet;
    }

    function test_curve_smallNetPaysLittleMoreThanTheAsk() public {
        uint64 id = _batch();
        _commitCurve(id, _curve());
        _open(id);
        // Alice buys 0.1 fETH worth alone: price must sit on the curve at n of about 0.1, far below askMax.
        BlindSettlement.Order memory o = _order(alice, id, true, 271e6, 0);
        _settle(id, _one(o));
        (,,,,,,,,,,, uint128 price) = s.batches(id);
        uint256 n = uint256(271e6) * 1e18 / price;
        uint256 onCurve = _curveAt(_curve(), n, true);
        assertApproxEqRel(price, onCurve, 1e12, "price is the curve at its own net (within 1e-6)");
        assertLt(price, 2_750e6);
        assertGt(price, ask);
    }

    function test_curve_matchedFlowNeedsNoMakerAndPaysNoCurve() public {
        uint64 id = _batch();
        _commitCurve(id, _curve());
        _open(id);
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = _order(alice, id, true, 2_700e6, 0);
        os[1] = _order(bob, id, false, 1e18, 0);
        _settle(id, os);
        (,,,,,,,,,,, uint128 price) = s.batches(id);
        assertEq(price, 2_700e6);
    }

    function testFuzz_curve_priceIsTheFixedPoint(uint64 q, uint64 b) public view {
        uint256 quoteIn = uint256(q) % 3_000e6;
        uint256 baseIn = uint256(b) % 1.2e18;
        vm.assume(quoteIn > 0 || baseIn > 0);
        BlindSettlement.Curve memory c = _curve();
        uint256 p = s.clearingPrice(c, quoteIn, baseIn);
        assertGe(p, c.bidMax);
        assertLe(p, c.askMax);
        uint256 baseOut = quoteIn * 1e18 / p;
        if (p > c.ask && p < c.askMax) {
            assertApproxEqRel(p, _curveAt(c, baseOut - baseIn, true), 1e12);
        } else if (p < c.bid && p > c.bidMax) {
            assertApproxEqRel(p, _curveAt(c, baseIn - baseOut, false), 1e12);
        }
    }

    function test_curve_badShapeRefused() public {
        uint64 id = _batch();
        uint64 exp = uint64(block.number + 50);
        BlindSettlement.Curve memory c = BlindSettlement.Curve(bid, ask, bid + 1, ask, 1e18); // bidMax above bid
        bytes memory sig = _sign(agent, s.quoteMessage(id, c, exp));
        vm.expectRevert(BlindSettlement.BadQuote.selector);
        s.commit(id, c, exp, sig);
    }

    // ------------------------------------------------------------ ordering

    function test_cannotOpenBeforeCommit() public {
        uint64 id = _batch();
        vm.roll(block.number + 5);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.open(id, abi.encodePacked(SK));
    }

    function test_cannotOpenInTheCommitBlock() public {
        uint64 id = _batch();
        _commit(id, 1e18);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.open(id, abi.encodePacked(SK));
    }

    function test_cannotOpenWithTheWrongKey() public {
        uint64 id = _batch();
        _commit(id, 1e18);
        vm.roll(block.number + 1);
        vm.expectRevert("wrong batch key");
        s.open(id, abi.encodePacked(keccak256("guess")));
    }

    function test_intakeClosesAtCommit() public {
        uint64 id = _batch();
        _commit(id, 1e18);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.post(id, hex"c0ffee");
    }

    function test_quoteCannotBeCommittedTwice() public {
        uint64 id = _batch();
        _commit(id, 1e18);
        uint64 exp = uint64(block.number + 50);
        bytes memory sig = _sign(agent, s.quoteMessage(id, _flat(1e18), exp));
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.commit(id, _flat(1e18), exp, sig);
    }

    function test_onlyTheSettlerCreatesAndSettles() public {
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.NotSettler.selector);
        s.create(keccak256("x"));
        uint64 id = _ready(1e18);
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(os[0]);
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.NotSettler.selector);
        s.settle(id, os, sigs);
    }

    // ------------------------------------------------------------ drill: what a stolen settler key cannot do

    function test_drill_forgedQuoteRefused() public {
        uint64 id = _batch();
        uint64 exp = uint64(block.number + 50);
        // Settler signs a wildly wide quote with its own key: not the agent's, refused.
        BlindSettlement.Curve memory wide = BlindSettlement.Curve(1, 2, 1, type(uint128).max, type(uint128).max);
        bytes memory sig = _sign(settler, s.quoteMessage(id, wide, exp));
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.commit(id, wide, exp, sig);
    }

    function test_drill_forgedOrderRefused() public {
        uint64 id = _ready(1e18);
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 10_000e6, 0));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(settler, this.orderMessageOf(os[0])); // settler signs for alice
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.settle(id, os, sigs);
    }

    function test_drill_tamperedOrderRefused() public {
        uint64 id = _ready(1e18);
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0.03e18);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        o.amountIn = 10_000e6; // inflate after signing
        o.minOut = 0;
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.settle(id, _one(o), sigs);
    }

    function test_drill_replayRefused() public {
        // A standing order (batch 0) fills once, never again.
        uint64 a = _ready(1e18);
        BlindSettlement.Order memory o = _order(alice, 0, true, 100e6, 0.03e18);
        o.expiry = uint64(block.number + 500);
        _settle(a, _one(o));
        uint64 b = _ready(1e18);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(b, _one(o), sigs);
    }

    function test_drill_sameOrderTwiceInOneBatchRefused() public {
        uint64 id = _ready(1e18);
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = o; os[1] = o;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sigOf(o); sigs[1] = sigs[0];
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 1));
        s.settle(id, os, sigs);
    }

    function test_drill_orderForAnotherBatchRefused() public {
        uint64 a = _ready(1e18);
        uint64 b = _ready(1e18);
        BlindSettlement.Order memory o = _order(alice, a, true, 100e6, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(b, _one(o), sigs);
    }

    function test_drill_userMinOutEnforced() public {
        uint64 id = _ready(1e18);
        // Alice demands more than the ask allows: the whole settle reverts, nothing moves.
        BlindSettlement.Order memory o = _order(alice, id, true, 2_710e6, 1.01e18);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.MinOut.selector, 0));
        s.settle(id, _one(o), sigs);
        assertEq(fUSD.balanceOf(alice), 10_000e6);
    }

    function test_drill_makerSizeCapEnforced() public {
        uint64 id = _ready(0.1e18);
        bytes[] memory sigs = new bytes[](1);
        BlindSettlement.Order memory o = _order(alice, id, true, 2_710e6, 0); // needs 1 fETH from the maker
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.TooBig.selector);
        s.settle(id, _one(o), sigs);
    }

    function test_drill_inventoryCannotBeWithdrawnWithoutTheAgent() public {
        bytes memory sig = _sign(settler, s.withdrawMessage(address(fETH), 1e18, 0));
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.withdraw(address(fETH), 1e18, sig);
    }

    function test_withdrawGoesOnlyToTheTreasuryOnce() public {
        bytes memory sig = _sign(agent, s.withdrawMessage(address(fETH), 0.4e18, 0));
        vm.prank(mallory); // anyone may submit it; the money still goes to the treasury
        s.withdraw(address(fETH), 0.4e18, sig);
        assertEq(fETH.balanceOf(treasury), 0.4e18);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.withdraw(address(fETH), 0.4e18, sig); // nonce moved on
    }

    function test_unprovenKeyRefused() public {
        MockStatus(STATUS).set(alice, _key(alice), false);
        uint64 id = _ready(1e18);
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.KeyNotProven.selector);
        s.settle(id, _one(o), sigs);
    }

    // ------------------------------------------------------------ expiry

    function test_staleQuoteCannotSettle() public {
        uint64 id = _ready(1e18);
        vm.roll(block.number + 60);
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        o.expiry = uint64(block.number + 10);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.settle(id, _one(o), sigs);
    }

    function test_expiredOrderRefused() public {
        uint64 id = _ready(1e18);
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        o.expiry = uint64(block.number - 1);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(id, _one(o), sigs);
    }

    function test_batchSettlesOnce() public {
        uint64 id = _ready(1e18);
        _settle(id, _one(_order(alice, id, true, 100e6, 0)));
        BlindSettlement.Order memory o = _order(bob, id, true, 100e6, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sigOf(o);
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.settle(id, _one(o), sigs);
    }

    // ------------------------------------------------------------ QCAI audit answers (docs/audit)

    /// QCAI #1: a token that re-enters during settle's payout cannot withdraw inventory.
    function test_qcai_reentryDuringSettleIsBlocked() public {
        EvilToken evil = new EvilToken();
        BlindSettlement s2 = new BlindSettlement(IERC20(address(evil)), IERC20(address(fUSD)), agent, settler, treasury, 100);
        evil.mint(address(s2), 1e18);
        vm.prank(alice);
        fUSD.approve(address(s2), type(uint256).max);
        // A valid agent signature for withdrawing everything: the only thing missing is a fresh call.
        bytes memory wsig = _sign(agent, s2.withdrawMessage(address(evil), 1e18, 0));
        evil.arm(address(s2), abi.encodeCall(BlindSettlement.withdraw, (address(evil), 1e18, wsig)));

        vm.prank(settler);
        uint64 id = s2.create(keccak256(abi.encodePacked(SK)));
        BlindSettlement.Curve memory c = _flat(1e18);
        uint64 exp = uint64(block.number + 50);
        s2.commit(id, c, exp, _sign(agent, s2.quoteMessage(id, c, exp)));
        vm.roll(block.number + 1);
        s2.open(id, abi.encodePacked(SK));
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(alice, s2.orderMessage(o));
        vm.prank(settler);
        s2.settle(id, _one(o), sigs);

        assertTrue(evil.tried(), "the token did try to re-enter");
        assertFalse(evil.reentryOk(), "re-entry must fail");
        assertEq(s2.withdrawNonce(), 0, "no withdraw happened");
        assertEq(evil.balanceOf(treasury), 0);
    }

    /// QCAI #3: clearingPrice never overflows for any curve and totals far beyond real use:
    /// prices up to 2^48 (about 280 million fUSD per fETH), maxNet and totals up to 2^72
    /// (4,700 fETH, or 4.7 quadrillion fUSD). Testnet batches use prices near 2^32 and
    /// maxNet near 2^52. Outside the range, checked arithmetic reverts; it never returns a wrong price.
    function testFuzz_qcai_solveHasNoOverflowInRange(uint48 bidMax, uint48 w1, uint48 w2, uint48 w3, uint72 maxNet, uint72 q, uint72 b) public view {
        uint256 lo = bound(bidMax, 1, type(uint48).max / 4);
        uint256 bd = lo + bound(w1, 0, type(uint48).max / 4);
        uint256 ak = bd + 1 + bound(w2, 0, type(uint48).max / 4);
        uint256 hi = ak + bound(w3, 0, type(uint48).max / 4);
        BlindSettlement.Curve memory c = BlindSettlement.Curve(uint128(bd), uint128(ak), uint128(lo), uint128(hi), uint128(bound(maxNet, 1, type(uint72).max)));
        uint256 p = s.clearingPrice(c, q, b);
        if (q > 0 || b > 0) {
            assertGe(p, lo);
            assertLe(p, hi);
        }
    }

    /// QCAI #5: the order loop is bounded. 33 orders are refused before any work.
    function test_qcai_moreThan32OrdersRefused() public {
        uint64 id = _ready(1e18);
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](33);
        bytes[] memory sigs = new bytes[](33);
        for (uint256 i; i < 33; ++i) { os[i] = _order(alice, id, true, 1e6, 0); os[i].nonce = i; sigs[i] = _sigOf(os[i]); }
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.TooBig.selector);
        s.settle(id, os, sigs);
    }
}
