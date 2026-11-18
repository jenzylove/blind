// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title Blind: sealed batch trading with a market maker that must commit first.
/// @notice One market (base / quote), traded in batches:
///   1. The settler creates a batch and fixes the hash of the batch secret key.
///   2. Users' orders arrive sealed (ML-KEM-1024 envelopes) and are posted on chain.
///   3. The market maker commits a bid, an ask, a maximum net size and an expiry,
///      signed with its ML-DSA-87 key. Intake closes at that moment.
///   4. In a later block the batch key is revealed and anyone can open the envelopes.
///   5. The settler submits the opened orders. The contract checks every user's
///      ML-DSA-87 signature, works out ONE clearing price from the committed quote,
///      enforces every user's signed min-out and moves every leg atomically.
/// @dev Nothing trusts msg.sender for prices or amounts. A stolen settler key can only
///      settle orders users really signed, at the price this contract computes.
contract BlindSettlement {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01; // pqcVerify
    address constant STATUS = 0x0000000000000000000000000000000000000a02; // pqcKeyStatus
    uint256 public constant PRICE_SCALE = 1e18; // price = quote base units per base unit, x 1e18
    uint256 public constant MAX_ORDERS = 32;

    IERC20 public immutable base;
    IERC20 public immutable quote;
    address public immutable agent;    // ML-DSA-87 key that signs quotes and inventory moves
    address public immutable settler;  // the only account that may create and settle batches
    address public immutable treasury; // inventory can leave only to this address
    uint64 public immutable settleWindow; // blocks after open in which a batch may settle

    struct Order {
        address user;
        uint64 batch;   // 0 = standing order, valid in any batch until expiry
        uint64 expiry;  // last block in which it may fill
        bool buy;       // true: pay quote, receive base. false: pay base, receive quote
        uint256 amountIn;
        uint256 minOut;
        uint256 nonce;
    }

    struct Batch {
        bytes32 keyHash;
        uint64 commitBlock;
        uint64 openBlock;
        uint64 settleBlock;
        uint64 quoteExpiry;
        uint32 sealedCount;
        uint128 bid;    // the maker's bid for a tiny net
        uint128 ask;    // the maker's ask for a tiny net
        uint128 bidMax; // its bid when it buys the full maxNet
        uint128 askMax; // its ask when it sells the full maxNet
        uint128 maxNet; // largest net amount of base the market maker will buy or sell
        uint128 price;  // clearing price, set at settlement
    }

    /// The market maker's committed quote curve. The price moves in a straight line from
    /// (bid, ask) at a tiny net to (bidMax, askMax) at maxNet.
    struct Curve {
        uint128 bid;
        uint128 ask;
        uint128 bidMax;
        uint128 askMax;
        uint128 maxNet;
    }

    uint64 public batchCount;
    uint256 public withdrawNonce;
    mapping(uint64 => Batch) public batches;
    mapping(bytes32 => bool) public used; // order hash => filled
    uint256 private locked = 1;

    event Created(uint64 indexed batch, bytes32 keyHash);
    event Sealed(uint64 indexed batch, uint32 index, bytes envelope);
    event Committed(uint64 indexed batch, Curve curve, uint64 quoteExpiry);
    event Opened(uint64 indexed batch, bytes secretKey);
    event Filled(uint64 indexed batch, bytes32 indexed orderHash, address indexed user, bool buy, uint256 amountIn, uint256 amountOut);
    event Settled(uint64 indexed batch, uint256 price, uint256 quoteIn, uint256 baseIn, int256 makerBase, int256 makerQuote, uint256 orders);
    event Withdrawn(address indexed token, uint256 amount, uint256 nonce);

    error NotSettler();
    error BadPhase();
    error BadSignature();
    error KeyNotProven();
    error BadQuote();
    error BadOrder(uint256 index);
    error MinOut(uint256 index);
    error TooBig();
    error TransferFailed();

    modifier nonReentrant() {
        require(locked == 1);
        locked = 2;
        _;
        locked = 1;
    }

    constructor(IERC20 base_, IERC20 quote_, address agent_, address settler_, address treasury_, uint64 settleWindow_) {
        base = base_;
        quote = quote_;
        agent = agent_;
        settler = settler_;
        treasury = treasury_;
        settleWindow = settleWindow_;
    }

    // ---------------------------------------------------------------- keys

    /// The account's ML-DSA-87 public key as registered on QoreChain, possession proven.
    function keyOf(address who) public view returns (bytes memory key) {
        (bool ok, bytes memory ret) = STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", who));
        if (!ok || ret.length < 128) revert KeyNotProven();
        bool registered;
        uint8 alg;
        bool proven;
        (registered, alg, key, proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || alg != 1 || !proven) revert KeyNotProven();
    }

    function _verify(address who, bytes calldata sig, bytes memory message) internal view {
        (bool ok, bytes memory ret) =
            VERIFY.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", keyOf(who), sig, message));
        if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert BadSignature();
    }

    // ---------------------------------------------------------------- messages (what keys sign)

    function quoteMessage(uint64 batch, Curve memory c, uint64 quoteExpiry) public view returns (bytes memory) {
        return abi.encode("blind-quote-v2", block.chainid, address(this), batch, c, quoteExpiry);
    }

    function curveOf(uint64 id) public view returns (Curve memory) {
        Batch storage b = batches[id];
        return Curve(b.bid, b.ask, b.bidMax, b.askMax, b.maxNet);
    }

    function orderHash(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    function orderMessage(Order calldata o) public view returns (bytes memory) {
        return abi.encode("blind-order-v1", block.chainid, address(this), o);
    }

    function withdrawMessage(address token, uint256 amount, uint256 nonce) public view returns (bytes memory) {
        return abi.encode("blind-withdraw-v1", block.chainid, address(this), token, treasury, amount, nonce);
    }

    // ---------------------------------------------------------------- batch lifecycle

    function create(bytes32 keyHash) external returns (uint64 id) {
        if (msg.sender != settler) revert NotSettler();
        require(keyHash != 0);
        id = ++batchCount;
        batches[id].keyHash = keyHash;
        emit Created(id, keyHash);
    }

    /// Anyone may post a sealed order while the batch is taking orders.
    function post(uint64 id, bytes calldata envelope) external {
        Batch storage b = batches[id];
        if (b.keyHash == 0 || b.commitBlock != 0) revert BadPhase();
        require(envelope.length > 0 && envelope.length <= 8192);
        emit Sealed(id, b.sealedCount++, envelope);
    }

    /// The market maker's curve, fixed before any order can be read. Anyone may submit it;
    /// only the agent's ML-DSA-87 signature makes it valid. Closes intake.
    function commit(uint64 id, Curve calldata c, uint64 quoteExpiry, bytes calldata sig) external {
        Batch storage b = batches[id];
        if (b.keyHash == 0 || b.commitBlock != 0) revert BadPhase();
        if (c.bidMax == 0 || c.bidMax > c.bid || c.bid >= c.ask || c.ask > c.askMax || c.maxNet == 0 || quoteExpiry <= block.number) {
            revert BadQuote();
        }
        _verify(agent, sig, quoteMessage(id, c, quoteExpiry));
        b.bid = c.bid;
        b.ask = c.ask;
        b.bidMax = c.bidMax;
        b.askMax = c.askMax;
        b.maxNet = c.maxNet;
        b.quoteExpiry = quoteExpiry;
        b.commitBlock = uint64(block.number);
        emit Committed(id, c, quoteExpiry);
    }

    /// Reveal the batch key, strictly after the commit block. Anyone holding the key may call.
    function open(uint64 id, bytes calldata secretKey) external {
        Batch storage b = batches[id];
        if (b.commitBlock == 0 || block.number <= b.commitBlock || b.openBlock != 0) revert BadPhase();
        require(keccak256(secretKey) == b.keyHash, "wrong batch key");
        b.openBlock = uint64(block.number);
        emit Opened(id, secretKey);
    }

    /// The clearing price for given totals under a committed curve.
    /// Net buying: the maker sells n base and the price is ask + (askMax - ask) * n / maxNet.
    /// Net selling: the maker buys n base and the price is bid - (bid - bidMax) * n / maxNet.
    /// n itself depends on the price (buyers spend a fixed amount of quote), so the contract
    /// solves the fixed point exactly: maxNet*P^2 - (P0*maxNet - D*B)*P - D*Q*S = 0, one positive root.
    /// If buys and sells cross inside (bid, ask) they clear at the crossing price, maker trades nothing.
    function clearingPrice(Curve memory c, uint256 quoteIn, uint256 baseIn) public pure returns (uint256) {
        if (quoteIn == 0 && baseIn == 0) return 0;
        if (quoteIn * PRICE_SCALE / c.ask > baseIn) {
            uint256 pa = _solve(c.ask, c.askMax - c.ask, c.maxNet, quoteIn, baseIn);
            return pa < c.ask ? c.ask : (pa > c.askMax ? c.askMax : pa);
        }
        if (quoteIn * PRICE_SCALE / c.bid < baseIn) {
            uint256 pb = _solve(c.bid, c.bid - c.bidMax, c.maxNet, quoteIn, baseIn);
            return pb > c.bid ? c.bid : (pb < c.bidMax ? c.bidMax : pb);
        }
        uint256 p = quoteIn * PRICE_SCALE / baseIn;
        return p < c.bid ? c.bid : (p > c.ask ? c.ask : p);
    }

    /// Positive root of m*P^2 - (p0*m - d*B)*P - d*Q*S = 0 (the same form on both sides).
    function _solve(uint256 p0, uint256 d, uint256 m, uint256 q, uint256 b) internal pure returns (uint256) {
        if (d == 0) return p0;
        int256 lin = int256(p0 * m) - int256(d * b);
        uint256 disc = uint256(lin * lin) + 4 * m * d * q * PRICE_SCALE;
        int256 root = int256(_sqrt(disc));
        int256 p = (lin + root) / int256(2 * m);
        return p > 0 ? uint256(p) : 1;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }

    function settle(uint64 id, Order[] calldata orders, bytes[] calldata sigs) external nonReentrant {
        if (msg.sender != settler) revert NotSettler();
        Batch storage b = batches[id];
        if (b.openBlock == 0 || b.settleBlock != 0) revert BadPhase();
        if (block.number > b.quoteExpiry || block.number > b.openBlock + settleWindow) revert BadPhase();
        if (orders.length != sigs.length || orders.length > MAX_ORDERS) revert TooBig();
        b.settleBlock = uint64(block.number);

        Totals memory t;
        (t.quoteIn, t.baseIn) = _authenticate(id, orders, sigs);
        t.price = clearingPrice(curveOf(id), t.quoteIn, t.baseIn);
        b.price = uint128(t.price);
        (t.baseOut, t.quoteOut) = _execute(id, orders, t.price);
        _finish(id, b.maxNet, t, orders.length);
    }

    struct Totals {
        uint256 price;
        uint256 quoteIn;
        uint256 baseIn;
        uint256 baseOut;
        uint256 quoteOut;
    }

    /// Pass 1: authenticate every order, mark it used, total each side.
    function _authenticate(uint64 id, Order[] calldata orders, bytes[] calldata sigs)
        internal returns (uint256 quoteIn, uint256 baseIn)
    {
        for (uint256 i; i < orders.length; ++i) {
            Order calldata o = orders[i];
            bytes32 h = orderHash(o);
            if (used[h] || o.amountIn == 0 || block.number > o.expiry || (o.batch != 0 && o.batch != id)) revert BadOrder(i);
            used[h] = true;
            _verify(o.user, sigs[i], orderMessage(o));
            if (o.buy) quoteIn += o.amountIn;
            else baseIn += o.amountIn;
        }
    }

    /// Pass 2: pull every input, then pay every output at the single price.
    function _execute(uint64 id, Order[] calldata orders, uint256 price)
        internal returns (uint256 baseOut, uint256 quoteOut)
    {
        for (uint256 i; i < orders.length; ++i) {
            _pull(orders[i].buy ? quote : base, orders[i].user, orders[i].amountIn);
        }
        for (uint256 i; i < orders.length; ++i) {
            Order calldata o = orders[i];
            uint256 out = o.buy ? o.amountIn * PRICE_SCALE / price : o.amountIn * price / PRICE_SCALE;
            if (out < o.minOut || out == 0) revert MinOut(i);
            if (o.buy) baseOut += out;
            else quoteOut += out;
            _pay(o.buy ? base : quote, o.user, out);
            emit Filled(id, orderHash(o), o.user, o.buy, o.amountIn, out);
        }
    }

    /// The maker's side: what left (or entered) its inventory. Must stay within its committed size.
    function _finish(uint64 id, uint256 maxNet, Totals memory t, uint256 n) internal {
        int256 makerBase = int256(t.baseIn) - int256(t.baseOut);    // positive: maker bought base
        int256 makerQuote = int256(t.quoteIn) - int256(t.quoteOut); // positive: maker received quote
        uint256 net = makerBase < 0 ? uint256(-makerBase) : uint256(makerBase);
        if (net > maxNet) revert TooBig();
        emit Settled(id, t.price, t.quoteIn, t.baseIn, makerBase, makerQuote, n);
    }

    /// Inventory leaves only to the treasury, and only with the agent's ML-DSA-87 signature.
    function withdraw(address token, uint256 amount, bytes calldata sig) external nonReentrant {
        uint256 n = withdrawNonce;
        _verify(agent, sig, withdrawMessage(token, amount, n));
        withdrawNonce = n + 1;
        _pay(IERC20(token), treasury, amount);
        emit Withdrawn(token, amount, n);
    }

    function _pull(IERC20 t, address from, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(t).call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _pay(IERC20 t, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(t).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
