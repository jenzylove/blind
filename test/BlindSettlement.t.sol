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
/// owner signature. Used to answer the QCAI reentrancy finding.
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

/// A token that says "no" without reverting: transfer returns false and moves nothing.
contract FalseToken is Token {
    constructor() Token("false") {}
    function transfer(address, uint256) external pure override returns (bool) { return false; }
}

/// A token whose transfer returns something that is not a bool.
contract GarbageToken is Token {
    constructor() Token("garbage") {}
    function transfer(address, uint256) external pure override returns (bool) {
        assembly { mstore(0, 2) mstore(32, 3) return(0, 64) }
    }
}

contract BlindSettlementTest is Test {
    address constant VERIFY = address(0x0A01);
    address constant STATUS = address(0x0A02);

    BlindSettlement s;
    Token fETH;
    Token fUSD;
    address agent = makeAddr("agent");
    address maker = makeAddr("maker");
    address owner = makeAddr("owner");
    address settler = makeAddr("settler");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address mallory = makeAddr("mallory");

    uint128 bid;
    uint128 ask;
    uint64 constant REVEAL = 10;
    uint64 constant SETTLE = 100;

    function _key(address who) internal pure returns (bytes memory) { return abi.encodePacked("key-of-", who); }
    function _sign(address who, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(_key(who), message)));
    }

    function _deploy(IERC20 b, IERC20 q) internal returns (BlindSettlement) {
        return new BlindSettlement(b, q, agent, maker, owner, settler, treasury, REVEAL, SETTLE, "qorechain-diana");
    }

    function _mandate() internal view returns (BlindSettlement.Mandate memory) {
        // 2 fETH per batch, 5% spread, the whole curve within 10% of the last price for 1,000 blocks,
        // 0.5 fETH or 2,000 fUSD out per day.
        return BlindSettlement.Mandate(2e18, 500, 1_000, 1_000, 0.5e18, 2_000e6, uint64(block.number + 100_000));
    }

    function _setMandate(BlindSettlement c, BlindSettlement.Mandate memory m) internal {
        c.setMandate(m, _sign(owner, c.mandateMessage(m, c.mandateNonce())));
    }

    function setUp() public {
        vm.etch(STATUS, address(new MockStatus()).code);
        vm.etch(VERIFY, address(new MockVerify()).code);
        address[8] memory who = [agent, owner, alice, bob, carol, mallory, settler, maker];
        for (uint256 i; i < who.length; ++i) MockStatus(STATUS).set(who[i], _key(who[i]), true);

        fETH = new Token("fETH");
        fUSD = new Token("fUSD");
        s = _deploy(IERC20(address(fETH)), IERC20(address(fUSD)));
        _setMandate(s, _mandate());
        // price = fUSD base units per fETH base unit x 1e18: 2,700 fUSD per fETH = 2700e6
        bid = 2_690e6;
        ask = 2_710e6;
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
        id = s.open();
    }

    function _flat(uint128 maxNet) internal view returns (BlindSettlement.Curve memory) {
        return BlindSettlement.Curve(bid, ask, bid, ask, maxNet);
    }

    function _commitCurve(uint64 id, BlindSettlement.Curve memory c) internal {
        uint64 exp = uint64(block.number + 50);
        bytes memory sig = _sign(agent, s.quoteMessage(id, c, exp));
        vm.prank(maker);
        s.commit(id, c, exp, sig);
    }

    function _order(address user, uint64 id, bool buy, uint256 amountIn, uint256 minOut) internal view returns (BlindSettlement.Order memory) {
        return BlindSettlement.Order(user, id, uint64(block.number + 40), buy, amountIn, minOut, 1);
    }

    function signedOrderBytesOf(BlindSettlement.Order calldata o) external view returns (bytes memory) { return s.signedOrderBytes(o); }
    function orderMessageOf(BlindSettlement.Order calldata o) external view returns (bytes memory) { return s.orderMessage(o); }
    function _sigOf(BlindSettlement.Order memory o) internal view returns (bytes memory) { return _sign(o.user, this.signedOrderBytesOf(o)); }

    function _sigsOf(BlindSettlement.Order[] memory os) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](os.length);
        for (uint256 i; i < os.length; ++i) sigs[i] = _sigOf(os[i]);
    }

    function _salt(uint64 id, uint256 i) internal pure returns (bytes32) { return keccak256(abi.encode("salt", id, i)); }

    /// v5: only the settler (the relayer) posts fingerprints.
    function _post(uint64 id, bytes32 fp) internal {
        vm.prank(settler);
        s.post(id, fp);
    }

    /// v5: the settler relays reveals (the order's own user may also reveal directly).
    function _reveal(uint64 id, uint256 index, BlindSettlement.Order memory o, bytes memory sig, bytes32 salt) internal {
        vm.prank(settler);
        s.reveal(id, index, o, sig, salt);
    }

    function _one(BlindSettlement.Order memory o) internal pure returns (BlindSettlement.Order[] memory a) {
        a = new BlindSettlement.Order[](1); a[0] = o;
    }

    /// Post every order's fingerprint, commit the curve, then reveal every order one block later.
    function _prep(uint64 id, BlindSettlement.Order[] memory os, bytes[] memory sigs, BlindSettlement.Curve memory c)
        internal returns (uint256[] memory idx)
    {
        idx = new uint256[](os.length);
        for (uint256 i; i < os.length; ++i) {
            (,,,, uint32 posted,,,,,,,) = s.batches(id);
            idx[i] = posted;
            _post(id, s.fingerprintOf(os[i], sigs[i], _salt(id, i)));
        }
        _commitCurve(id, c);
        vm.roll(block.number + 1);
        for (uint256 i; i < os.length; ++i) _reveal(id, idx[i], os[i], sigs[i], _salt(id, i));
    }

    function _settle(uint64 id, BlindSettlement.Order[] memory os, BlindSettlement.Curve memory c) internal {
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, c);
        vm.prank(settler);
        s.settle(id, idx, os, sigs);
    }

    function _price(uint64 id) internal view returns (uint128 p) {
        (,,,,,,,,,,, p) = s.batches(id);
    }

    // ------------------------------------------------------------ pricing

    function test_netBuyingClearsAtTheAsk() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](3);
        os[0] = _order(alice, id, true, 2_710e6, 0.99e18);
        os[1] = _order(bob, id, true, 1_355e6, 0.49e18);
        os[2] = _order(carol, id, false, 1e18, 2_600e6);
        uint256 makerEth = fETH.balanceOf(address(s));
        _settle(id, os, _flat(0.5e18));
        assertEq(_price(id), ask);
        assertEq(fETH.balanceOf(alice), 2e18);
        assertEq(fETH.balanceOf(bob), 1.5e18);
        assertEq(fUSD.balanceOf(carol), 10_000e6 + 2_710e6, "the seller also gets the ask: one price for all");
        assertEq(makerEth - fETH.balanceOf(address(s)), 0.5e18, "maker sold the net 0.5 fETH");
    }

    function test_netSellingClearsAtTheBid() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = _order(alice, id, false, 1e18, 2_600e6);
        os[1] = _order(bob, id, true, 1_345e6, 0.4e18);
        _settle(id, os, _flat(1e18));
        assertEq(_price(id), bid);
        assertEq(fUSD.balanceOf(alice), 10_000e6 + 2_690e6);
        assertEq(fETH.balanceOf(bob), 1.5e18);
    }

    function test_crossingInsideTheBandMakerTradesNothing() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = _order(alice, id, true, 2_700e6, 0.99e18);
        os[1] = _order(bob, id, false, 1e18, 2_600e6);
        uint256 eth0 = fETH.balanceOf(address(s));
        uint256 usd0 = fUSD.balanceOf(address(s));
        _settle(id, os, _flat(1));
        assertEq(_price(id), 2_700e6);
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

    function _curve() internal view returns (BlindSettlement.Curve memory) {
        return BlindSettlement.Curve(bid, ask, 2_600e6, 2_800e6, 0.5e18);
    }

    function _curveAt(BlindSettlement.Curve memory c, uint256 n, bool makerSells) internal pure returns (uint256) {
        return makerSells ? c.ask + (uint256(c.askMax) - c.ask) * n / c.maxNet : c.bid - (uint256(c.bid) - c.bidMax) * n / c.maxNet;
    }

    function test_curve_smallNetPaysLittleMoreThanTheAsk() public {
        uint64 id = _batch();
        _settle(id, _one(_order(alice, id, true, 271e6, 0)), _curve());
        uint256 p = _price(id);
        uint256 n = uint256(271e6) * 1e18 / p;
        assertApproxEqRel(p, _curveAt(_curve(), n, true), 1e12, "price is the curve at its own net (within 1e-6)");
        assertLt(p, 2_750e6);
        assertGt(p, ask);
    }

    function test_curve_matchedFlowNeedsNoMakerAndPaysNoCurve() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = _order(alice, id, true, 2_700e6, 0);
        os[1] = _order(bob, id, false, 1e18, 0);
        _settle(id, os, _curve());
        assertEq(_price(id), 2_700e6);
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
        if (p > c.ask && p < c.askMax) assertApproxEqRel(p, _curveAt(c, baseOut - baseIn, true), 1e12);
        else if (p < c.bid && p > c.bidMax) assertApproxEqRel(p, _curveAt(c, baseIn - baseOut, false), 1e12);
    }

    function test_curve_badShapeRefused() public {
        uint64 id = _batch();
        uint64 exp = uint64(block.number + 50);
        BlindSettlement.Curve memory c = BlindSettlement.Curve(bid, ask, bid + 1, ask, 1e18);
        bytes memory sig = _sign(agent, s.quoteMessage(id, c, exp));
        vm.prank(maker);
        vm.expectRevert(BlindSettlement.BadQuote.selector);
        s.commit(id, c, exp, sig);
    }

    // ------------------------------------------------------------ v4: nobody reads an order before the price is locked

    function _postOne(uint64 id, BlindSettlement.Order memory o) internal returns (bytes memory sig) {
        sig = _sigOf(o);
        _post(id, s.fingerprintOf(o, sig, _salt(id, 0)));
    }

    /// On chain before the commit there is only a 32 byte fingerprint: no side, no amount, no key to steal.
    function test_v4_beforeTheCommitTheChainHoldsOnlyAFingerprint() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _postOne(id, o);
        assertEq(s.fingerprint(id, 0), s.fingerprintOf(o, sig, _salt(id, 0)));
        assertEq(s.revealedAs(id, 0), bytes32(0));
    }

    function test_v4_cannotRevealBeforeTheCommit() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _postOne(id, o);
        vm.roll(block.number + 5);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        _reveal(id, 0, o, sig, _salt(id, 0));
    }

    function test_v4_cannotRevealInTheCommitBlock() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _postOne(id, o);
        _commitCurve(id, _flat(1e18));
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        _reveal(id, 0, o, sig, _salt(id, 0));
    }

    function test_v4_revealMustMatchTheFingerprint() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _postOne(id, o);
        _commitCurve(id, _flat(1e18));
        vm.roll(block.number + 1);
        vm.expectRevert(BlindSettlement.BadReveal.selector);
        _reveal(id, 0, o, sig, keccak256("a guessed salt"));
        o.amountIn = 9_000e6; // a different order behind the same fingerprint
        vm.expectRevert(BlindSettlement.BadReveal.selector);
        _reveal(id, 0, o, sig, _salt(id, 0));
    }

    function test_v4_revealOnlyOnce() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _postOne(id, o);
        _commitCurve(id, _flat(1e18));
        vm.roll(block.number + 1);
        _reveal(id, 0, o, sig, _salt(id, 0));
        vm.expectRevert(BlindSettlement.BadReveal.selector);
        _reveal(id, 0, o, sig, _salt(id, 0));
    }

    function test_v4_revealWindowCloses() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _postOne(id, o);
        _commitCurve(id, _flat(1e18));
        vm.roll(block.number + REVEAL + 1);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        _reveal(id, 0, o, sig, _salt(id, 0));
    }

    /// The settler cannot cut the reveal window short to leave someone out.
    function test_v4_settleWaitsForEveryRevealOrTheWindow() public {
        uint64 id = _batch();
        BlindSettlement.Order memory a = _order(alice, id, true, 100e6, 0);
        BlindSettlement.Order memory b = _order(bob, id, true, 100e6, 0);
        bytes memory sa = _sigOf(a);
        bytes memory sb = _sigOf(b);
        _post(id, s.fingerprintOf(a, sa, _salt(id, 0)));
        _post(id, s.fingerprintOf(b, sb, _salt(id, 1)));
        _commitCurve(id, _flat(1e18));
        vm.roll(block.number + 1);
        _reveal(id, 0, a, sa, _salt(id, 0)); // bob has not revealed yet
        uint256[] memory idx = new uint256[](1);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sa;
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.settle(id, idx, _one(a), sigs);
        vm.roll(block.number + REVEAL); // window over: bob chose not to reveal, alice settles
        vm.prank(settler);
        s.settle(id, idx, _one(a), sigs);
        assertGt(_price(id), 0);
    }

    function test_v4_unrevealedOrderCannotBeSettled() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _postOne(id, o);
        _commitCurve(id, _flat(1e18));
        vm.roll(block.number + REVEAL + 1);
        uint256[] memory idx = new uint256[](1);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sig;
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(id, idx, _one(o), sigs);
    }

    function test_intakeClosesAtCommit() public {
        uint64 id = _batch();
        _commitCurve(id, _flat(1e18));
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        _post(id, keccak256("late"));
    }

    function test_quoteCannotBeCommittedTwice() public {
        uint64 id = _batch();
        _commitCurve(id, _flat(1e18));
        uint64 exp = uint64(block.number + 50);
        bytes memory sig = _sign(agent, s.quoteMessage(id, _flat(1e18), exp));
        vm.prank(maker);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.commit(id, _flat(1e18), exp, sig);
    }

    function test_onlyTheSettlerOpensAndSettles() public {
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.NotSettler.selector);
        s.open();
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0));
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.NotSettler.selector);
        s.settle(id, idx, os, sigs);
    }

    // ------------------------------------------------------------ v4: the market maker's leash

    function test_v4_onlyTheMakerAccountCommits() public {
        uint64 id = _batch();
        uint64 exp = uint64(block.number + 50);
        bytes memory sig = _sign(agent, s.quoteMessage(id, _flat(1e18), exp)); // a valid agent signature
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.NotMaker.selector);
        s.commit(id, _flat(1e18), exp, sig);
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.NotMaker.selector);
        s.commit(id, _flat(1e18), exp, sig);
    }

    function _commitExpectOutside(BlindSettlement.Curve memory c) internal {
        uint64 id = _batch();
        uint64 exp = uint64(block.number + 50);
        bytes memory sig = _sign(agent, s.quoteMessage(id, c, exp));
        vm.prank(maker);
        vm.expectRevert(BlindSettlement.OutsideMandate.selector);
        s.commit(id, c, exp, sig);
    }

    function test_v4_mandateCapsSize() public {
        _commitExpectOutside(_flat(2e18 + 1));
    }

    function test_v4_mandateCapsSpread() public {
        _commitExpectOutside(BlindSettlement.Curve(2_000e6, 2_200e6, 2_000e6, 2_200e6, 1e18)); // 10% spread
    }

    function test_v4_mandateKeepsTheCurveNearTheLastPrice() public {
        uint64 a = _batch();
        _settle(a, _one(_order(alice, a, true, 100e6, 0)), _flat(1e18)); // last price 2,710
        _commitExpectOutside(BlindSettlement.Curve(bid, ask, bid, 3_100e6, 1e18)); // askMax 14% above
        _commitExpectOutside(BlindSettlement.Curve(bid, ask, 2_300e6, ask, 1e18)); // bidMax 15% below
    }

    function test_v4_expiredMandateStopsTheMaker() public {
        vm.roll(block.number + 100_001);
        _commitExpectOutside(_flat(1e18));
    }

    function test_v4_mandateNeedsTheOwnersSignature() public {
        BlindSettlement.Mandate memory m = _mandate();
        m.maxNet = type(uint128).max;
        bytes memory sig = _sign(agent, s.mandateMessage(m, s.mandateNonce())); // the agent tries to widen its own leash
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.setMandate(m, sig);
    }

    function test_v4_mandateSignatureCannotBeReplayed() public {
        BlindSettlement.Mandate memory m = _mandate();
        bytes memory sig = _sign(owner, s.mandateMessage(m, s.mandateNonce()));
        s.setMandate(m, sig);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.setMandate(m, sig);
    }

    // ------------------------------------------------------------ drill: what a stolen settler key cannot do

    function test_drill_forgedQuoteRefused() public {
        uint64 id = _batch();
        uint64 exp = uint64(block.number + 50);
        BlindSettlement.Curve memory c = _flat(1e18);
        bytes memory sig = _sign(settler, s.quoteMessage(id, c, exp));
        vm.prank(maker);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.commit(id, c, exp, sig);
    }

    function test_drill_forgedOrderRefused() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 1_000e6, 0));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(settler, this.signedOrderBytesOf(os[0])); // settler signs for alice
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.settle(id, idx, os, sigs);
    }

    function test_drill_tamperedOrderRefused() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0.03e18));
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        os[0].amountIn = 9_000e6; // the settler inflates the revealed order
        os[0].minOut = 0;
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(id, idx, os, sigs);
    }

    function test_drill_replayRefused() public {
        uint64 a = _batch();
        BlindSettlement.Order memory o = _order(alice, 0, true, 100e6, 0.03e18); // standing order
        o.expiry = uint64(block.number + 500);
        _settle(a, _one(o), _flat(1e18));
        uint64 b = _batch();
        BlindSettlement.Order[] memory os = _one(o);
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(b, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(b, idx, os, sigs);
    }

    function test_drill_sameOrderTwiceInOneBatchRefused() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](2);
        os[0] = o; os[1] = o;
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 1));
        s.settle(id, idx, os, sigs);
    }

    function test_drill_orderForAnotherBatchRefused() public {
        uint64 a = _batch();
        uint64 b = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, a, true, 100e6, 0));
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(b, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(b, idx, os, sigs);
    }

    function test_drill_userMinOutEnforced() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 2_710e6, 1.01e18));
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.MinOut.selector, 0));
        s.settle(id, idx, os, sigs);
        assertEq(fUSD.balanceOf(alice), 10_000e6);
    }

    function test_drill_makerSizeCapEnforced() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 2_710e6, 0)); // needs 1 fETH from the maker
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(0.1e18));
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.TooBig.selector);
        s.settle(id, idx, os, sigs);
    }

    function test_unprovenKeyRefused() public {
        MockStatus(STATUS).set(alice, _key(alice), false);
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0));
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.KeyNotProven.selector);
        s.settle(id, idx, os, sigs);
    }

    function test_staleQuoteCannotSettle() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0));
        os[0].expiry = uint64(block.number + 200);
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.roll(block.number + 60); // the quote expired 50 blocks after the commit
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.settle(id, idx, os, sigs);
    }

    function test_expiredOrderRefused() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0));
        os[0].expiry = uint64(block.number);
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(BlindSettlement.BadOrder.selector, 0));
        s.settle(id, idx, os, sigs);
    }

    function test_batchSettlesOnce() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0));
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        s.settle(id, idx, os, sigs);
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadPhase.selector);
        s.settle(id, idx, os, sigs);
    }

    // ------------------------------------------------------------ inventory leaves only to the treasury, within the mandate

    function test_withdrawNeedsTheOwner() public {
        bytes memory sig = _sign(agent, s.withdrawMessage(address(fETH), 0.1e18, 0));
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.withdraw(address(fETH), 0.1e18, sig);
    }

    function test_withdrawGoesOnlyToTheTreasuryOnce() public {
        bytes memory sig = _sign(owner, s.withdrawMessage(address(fETH), 0.2e18, 0));
        vm.prank(mallory); // anyone may submit it; the money still goes to the treasury
        s.withdraw(address(fETH), 0.2e18, sig);
        assertEq(fETH.balanceOf(treasury), 0.2e18);
        vm.expectRevert(BlindSettlement.BadSignature.selector); // the nonce moved on (and still within the daily cap)
        s.withdraw(address(fETH), 0.2e18, sig);
    }

    function test_v4_withdrawCappedPerDay() public {
        s.withdraw(address(fETH), 0.4e18, _sign(owner, s.withdrawMessage(address(fETH), 0.4e18, 0)));
        bytes memory sig = _sign(owner, s.withdrawMessage(address(fETH), 0.2e18, 1));
        vm.expectRevert(BlindSettlement.OverDailyLimit.selector);
        s.withdraw(address(fETH), 0.2e18, sig); // 0.6 > 0.5 per day
        vm.warp(block.timestamp + 1 days);
        s.withdraw(address(fETH), 0.2e18, sig);
        assertEq(fETH.balanceOf(treasury), 0.6e18);
    }

    function test_v3_withdrawOnlyTheTradingTokens() public {
        address other = address(new Token("OTHER"));
        bytes memory sig = _sign(owner, s.withdrawMessage(other, 1, 0));
        vm.expectRevert(BlindSettlement.BadToken.selector);
        s.withdraw(other, 1, sig);
    }

    // ------------------------------------------------------------ QCAI audit answers

    /// QCAI #1: a token that re-enters during settle's payout cannot withdraw inventory.
    function test_qcai_reentryDuringSettleIsBlocked() public {
        EvilToken evil = new EvilToken();
        BlindSettlement s2 = _deploy(IERC20(address(evil)), IERC20(address(fUSD)));
        _setMandate(s2, _mandate());
        evil.mint(address(s2), 1e18);
        vm.prank(alice);
        fUSD.approve(address(s2), type(uint256).max);
        bytes memory wsig = _sign(owner, s2.withdrawMessage(address(evil), 0.1e18, 0));
        evil.arm(address(s2), abi.encodeCall(BlindSettlement.withdraw, (address(evil), 0.1e18, wsig)));

        vm.prank(settler);
        uint64 id = s2.open();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _sign(alice, s2.signedOrderBytes(o));
        bytes32 fp = s2.fingerprintOf(o, sig, bytes32(uint256(1)));
        vm.prank(settler);
        s2.post(id, fp);
        BlindSettlement.Curve memory c = _flat(1e18);
        uint64 exp = uint64(block.number + 50);
        bytes memory qsig = _sign(agent, s2.quoteMessage(id, c, exp));
        vm.prank(maker);
        s2.commit(id, c, exp, qsig);
        vm.roll(block.number + 1);
        vm.prank(alice);
        s2.reveal(id, 0, o, sig, bytes32(uint256(1)));
        uint256[] memory idx = new uint256[](1);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sig;
        vm.prank(settler);
        s2.settle(id, idx, _one(o), sigs);

        assertTrue(evil.tried(), "the token did try to re-enter");
        assertFalse(evil.reentryOk(), "re-entry must fail");
        assertEq(s2.withdrawNonce(), 0, "no withdraw happened");
        assertEq(evil.balanceOf(treasury), 0);
    }

    /// QCAI #3: clearingPrice never overflows for curves and totals far beyond real use.
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

    /// QCAI #5: the order loop is bounded. 33 orders are refused.
    function test_qcai_moreThan32OrdersRefused() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = new BlindSettlement.Order[](33);
        for (uint256 i; i < 33; ++i) { os[i] = _order(alice, id, true, 1e6, 0); os[i].nonce = i; }
        bytes[] memory sigs = _sigsOf(os);
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.TooBig.selector);
        s.settle(id, idx, os, sigs);
    }

    function test_v4_postsAreBounded() public {
        uint64 id = _batch();
        for (uint256 i; i < 64; ++i) _post(id, keccak256(abi.encode(i)));
        vm.expectRevert(BlindSettlement.TooBig.selector);
        _post(id, keccak256("one too many"));
    }

    // ------------------------------------------------------------ v3: wallet signing domain and token checks

    function test_v3_msgDomainIsQoreChainsMessageDomain() public view {
        assertEq(s.msgDomain(), bytes("qorechain-msg-v1|qorechain-diana|"));
    }

    function test_v3_signatureWithoutTheDomainRefused() public {
        uint64 id = _batch();
        BlindSettlement.Order[] memory os = _one(_order(alice, id, true, 100e6, 0));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(alice, this.orderMessageOf(os[0]));
        uint256[] memory idx = _prep(id, os, sigs, _flat(1e18));
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.settle(id, idx, os, sigs);
    }

    function test_v3_tokensMustBeContracts() public {
        vm.expectRevert(BlindSettlement.BadToken.selector);
        _deploy(IERC20(makeAddr("not a token")), IERC20(address(fUSD)));
    }

    // ------------------------------------------------------------ v5: QCAI v4 findings, closed with tests

    /// Nobody but the settler can post: a batch cannot be flooded with junk fingerprints from outside.
    function test_v5_onlyTheSettlerPosts() public {
        uint64 id = _batch();
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.NotSettler.selector);
        s.post(id, keccak256("junk"));
        vm.prank(maker);
        vm.expectRevert(BlindSettlement.NotSettler.selector);
        s.post(id, keccak256("junk"));
    }

    /// A reveal comes from the order's own user or the settler relaying it, nobody else.
    function test_v5_revealOnlyByItsUserOrTheSettler() public {
        uint64 id = _batch();
        BlindSettlement.Order memory o = _order(alice, id, true, 100e6, 0);
        bytes memory sig = _sigOf(o);
        _post(id, s.fingerprintOf(o, sig, _salt(id, 0)));
        _commitCurve(id, _flat(1e18));
        vm.roll(block.number + 1);
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.NotRevealer.selector);
        s.reveal(id, 0, o, sig, _salt(id, 0));
        vm.prank(alice);
        s.reveal(id, 0, o, sig, _salt(id, 0));
        assertTrue(s.revealedAs(id, 0) != bytes32(0));
    }

    /// Only the maker account may commit, and every other role is refused (QCAI: access control on commit).
    function test_v5_commitRefusesEveryOtherRole() public {
        uint64 id = _batch();
        BlindSettlement.Curve memory c = _flat(1e18);
        uint64 exp = uint64(block.number + 100);
        bytes memory sig = _sign(agent, s.quoteMessage(id, c, exp));
        address[5] memory others = [settler, agent, owner, alice, mallory];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(BlindSettlement.NotMaker.selector);
            s.commit(id, c, exp, sig);
        }
    }

    /// Past int256 the price math reverts instead of wrapping to a wrong price (QCAI: overflow in _solve).
    function test_v5_solveRevertsInsteadOfWrapping() public {
        uint128 top = type(uint128).max;
        BlindSettlement.Curve memory c = BlindSettlement.Curve(top - 3, top - 2, top - 4, top, top);
        vm.expectRevert(BlindSettlement.TooBig.selector);
        s.clearingPrice(c, uint256(1) << 120, 0);
    }

    /// More than MAX_ORDERS orders are refused before any work is done (QCAI: unbounded loop in settle).
    function test_v5_settleRefusesMoreThan32OrdersFirst() public {
        uint64 id = _batch();
        uint256 n = s.MAX_ORDERS() + 1;
        vm.prank(settler);
        vm.expectRevert(BlindSettlement.TooBig.selector);
        s.settle(id, new uint256[](n), new BlindSettlement.Order[](n), new bytes[](n));
    }

    /// A transfer that returns false, or returns something that is not a bool, reverts the whole call
    /// (QCAI v5 finding: return values from external calls).
    function test_v5_falseOrGarbageTransferReturnReverts() public {
        Token[2] memory bad = [Token(new FalseToken()), Token(new GarbageToken())];
        for (uint256 i; i < 2; ++i) {
            BlindSettlement c = _deploy(IERC20(address(bad[i])), IERC20(address(fUSD)));
            _setMandate(c, _mandate());
            bad[i].mint(address(c), 1e18);
            bytes memory sig = _sign(owner, c.withdrawMessage(address(bad[i]), 0.1e18, 0));
            vm.expectRevert();
            c.withdraw(address(bad[i]), 0.1e18, sig);
            assertEq(bad[i].balanceOf(address(c)), 1e18);
        }
    }

    /// setMandate is open to any sender on purpose (the owner's key is a post quantum key, not an EVM account),
    /// so the owner's ML-DSA-87 signature over a fresh nonce is the access control. A stranger's own
    /// signature, and a replay of the owner's, are both refused (QCAI v5 finding: access control on setMandate).
    function test_v5_setMandateNeedsTheOwnersFreshSignature() public {
        BlindSettlement.Mandate memory m = _mandate();
        m.maxNet = 100e18;
        uint256 n = s.mandateNonce();
        bytes memory strangerSig = _sign(mallory, s.mandateMessage(m, n));
        bytes memory ownerSig = _sign(owner, s.mandateMessage(m, n));
        vm.prank(mallory);
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.setMandate(m, strangerSig);
        vm.prank(mallory);
        s.setMandate(m, ownerSig); // relayed by anyone, but only what the owner signed
        vm.expectRevert(BlindSettlement.BadSignature.selector);
        s.setMandate(m, ownerSig); // the nonce moved on
    }
}
