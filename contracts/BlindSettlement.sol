// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title Blind: batch trading where nobody can read an order before the price is locked.
/// @notice One market (base / quote), traded in batches:
///   1. The settler opens a batch.
///   2. The settler (the relayer) posts each user's fingerprint: keccak256(order, signature hash, salt).
///      The order itself never leaves the user's browser, so nobody (operator, market maker, a future
///      quantum computer) can read it: there is no key to steal or break.
///   3. The market maker commits its price curve, signed with its ML-DSA-87 key, from its own account.
///      The curve must sit inside a mandate the owner signed with an ML-DSA-87 key. Intake closes.
///   4. Strictly after the commit block, each user reveals their own order (directly, or through the
///      settler); the contract checks it against the fingerprint posted earlier.
///   5. The settler submits revealed orders. The contract checks every user's ML-DSA-87 signature
///      (QoreChain's pqcVerify precompile), computes ONE clearing price from the committed curve,
///      enforces every signed minimum and moves every leg atomically.
/// @dev Access control, every state changing function:
///      open, post, settle: onlySettler.  commit: onlyMaker, plus the agent's ML-DSA-87 signature and the
///      owner's mandate.  reveal: the order's own user or the settler.  setMandate, withdraw: the owner's
///      ML-DSA-87 signature over a nonce (pqcVerify 0x0A01, key from pqcKeyStatus 0x0A02).
///      Nothing trusts msg.sender for prices or amounts. A stolen settler key can only settle orders
///      users really signed and revealed, at the price this contract computes.
///      Arithmetic: Solidity 0.8 checked math everywhere; every uint to int conversion goes through _int,
///      which reverts instead of wrapping; batch totals are capped at 2^128.
contract BlindSettlement {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01; // pqcVerify
    address constant STATUS = 0x0000000000000000000000000000000000000a02; // pqcKeyStatus
    uint256 public constant PRICE_SCALE = 1e18; // price = quote base units per base unit, x 1e18
    uint256 public constant MAX_ORDERS = 32;
    uint256 public constant MAX_POSTS = 64;

    IERC20 public immutable base;
    IERC20 public immutable quote;
    address public immutable agent;    // ML-DSA-87 key that signs the market maker's curves
    address public immutable maker;    // the only account that may commit a curve (the agent's leashed account)
    address public immutable owner;    // ML-DSA-87 key that signs the mandate and inventory withdrawals
    address public immutable settler;  // opens batches and settles them
    address public immutable treasury; // inventory can leave only to this address
    uint64 public immutable revealWindow; // blocks after the commit in which users reveal
    uint64 public immutable settleWindow; // blocks after the reveal window in which the batch may settle
    /// QoreChain's message-signing domain, "qorechain-msg-v1|<chain id>|". Users sign their order under it,
    /// the same form QoreX's signArbitrary and QoreSign's messagePqSignBytes produce.
    bytes public msgDomain;

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
        uint64 openBlock;   // set when the settler opens the batch
        uint64 commitBlock; // the market maker's curve; intake closes
        uint64 settleBlock;
        uint64 quoteExpiry;
        uint32 posted;
        uint32 revealed;
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

    /// What the owner allows the market maker to do. Signed with the owner's ML-DSA-87 key.
    struct Mandate {
        uint128 maxNet;        // largest net size per batch, in base units
        uint32 maxSpreadBps;   // ask over bid at a tiny net
        uint32 bandBps;        // the whole curve within this band of the last clearing price
        uint64 bandWindow;     // ... when that price is at most this many blocks old
        uint128 dailyBaseOut;  // withdrawals per UTC day, base
        uint128 dailyQuoteOut; // withdrawals per UTC day, quote
        uint64 expiry;         // last block the mandate holds
    }

    uint64 public batchCount;
    uint256 public mandateNonce;
    uint256 public withdrawNonce;
    uint256 public lastPrice;
    uint64 public lastPriceBlock;
    Mandate public mandate;
    mapping(uint64 => Batch) public batches;
    mapping(uint64 => mapping(uint256 => bytes32)) public fingerprint; // batch => index => posted fingerprint
    mapping(uint64 => mapping(uint256 => bytes32)) public revealedAs;  // batch => index => hash(order, sig hash)
    mapping(bytes32 => bool) public used; // order hash => filled
    mapping(address => mapping(uint256 => uint256)) public withdrawnOn; // token => UTC day => amount
    uint256 private locked = 1;

    event Opened(uint64 indexed batch);
    event Posted(uint64 indexed batch, uint256 index, bytes32 fingerprint);
    event Committed(uint64 indexed batch, Curve curve, uint64 quoteExpiry);
    event Revealed(uint64 indexed batch, uint256 index, Order order, bytes signature);
    event Filled(uint64 indexed batch, bytes32 indexed orderHash, address indexed user, bool buy, uint256 amountIn, uint256 amountOut);
    event Settled(uint64 indexed batch, uint256 price, uint256 quoteIn, uint256 baseIn, int256 makerBase, int256 makerQuote, uint256 orders);
    event MandateSet(uint256 nonce, Mandate mandate);
    event Withdrawn(address indexed token, uint256 amount, uint256 nonce);

    error NotSettler();
    error NotMaker();
    error NotRevealer();
    error BadPhase();
    error BadSignature();
    error KeyNotProven();
    error BadQuote();
    error OutsideMandate();
    error BadReveal();
    error BadOrder(uint256 index);
    error MinOut(uint256 index);
    error TooBig();
    error TransferFailed();
    error BadToken();
    error OverDailyLimit();

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    modifier onlyMaker() {
        if (msg.sender != maker) revert NotMaker();
        _;
    }

    modifier nonReentrant() {
        require(locked == 1);
        locked = 2;
        _;
        locked = 1;
    }

    constructor(
        IERC20 base_, IERC20 quote_, address agent_, address maker_, address owner_, address settler_, address treasury_,
        uint64 revealWindow_, uint64 settleWindow_, string memory chainName_
    ) {
        if (address(base_).code.length == 0 || address(quote_).code.length == 0 || address(base_) == address(quote_)) revert BadToken();
        msgDomain = bytes.concat("qorechain-msg-v1|", bytes(chainName_), "|");
        base = base_;
        quote = quote_;
        agent = agent_;
        maker = maker_;
        owner = owner_;
        settler = settler_;
        treasury = treasury_;
        revealWindow = revealWindow_;
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
        return abi.encode("blind-quote-v5", block.chainid, address(this), batch, c, quoteExpiry);
    }

    function mandateMessage(Mandate memory m, uint256 nonce) public view returns (bytes memory) {
        return abi.encode("blind-mandate-v5", block.chainid, address(this), m, nonce);
    }

    function withdrawMessage(address token, uint256 amount, uint256 nonce) public view returns (bytes memory) {
        return abi.encode("blind-withdraw-v5", block.chainid, address(this), token, treasury, amount, nonce);
    }

    function orderHash(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    function orderMessage(Order calldata o) public view returns (bytes memory) {
        return abi.encode("blind-order-v1", block.chainid, address(this), o);
    }

    /// The exact bytes a user's ML-DSA-87 key signs: QoreChain's message domain, then the order.
    function signedOrderBytes(Order calldata o) public view returns (bytes memory) {
        return bytes.concat(msgDomain, orderMessage(o));
    }

    /// What a user posts before the price is locked. The salt keeps it unguessable.
    function fingerprintOf(Order calldata o, bytes calldata sig, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(o, keccak256(sig), salt));
    }

    function curveOf(uint64 id) public view returns (Curve memory) {
        Batch storage b = batches[id];
        return Curve(b.bid, b.ask, b.bidMax, b.askMax, b.maxNet);
    }

    // ---------------------------------------------------------------- the owner's mandate

    function setMandate(Mandate calldata m, bytes calldata sig) external {
        uint256 n = mandateNonce;
        _verify(owner, sig, mandateMessage(m, n));
        mandateNonce = n + 1;
        mandate = m;
        emit MandateSet(n, m);
    }

    /// Whether a curve fits the mandate right now. The commit reverts with OutsideMandate if not.
    function withinMandate(Curve calldata c) public view returns (bool) {
        Mandate memory m = mandate;
        if (block.number > m.expiry || c.maxNet > m.maxNet) return false;
        if (uint256(c.ask - c.bid) * 10_000 > uint256(m.maxSpreadBps) * c.bid) return false;
        if (lastPrice != 0 && block.number <= lastPriceBlock + m.bandWindow) {
            if (uint256(c.bidMax) * 10_000 < lastPrice * (10_000 - m.bandBps)) return false;
            if (uint256(c.askMax) * 10_000 > lastPrice * (10_000 + m.bandBps)) return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- batch lifecycle

    function open() external onlySettler returns (uint64 id) {
        id = ++batchCount;
        batches[id].openBlock = uint64(block.number);
        emit Opened(id);
    }

    /// The settler posts each user's fingerprint while the batch is taking orders. Only the settler may:
    /// a direct post could fill a batch with junk fingerprints that nobody will ever reveal.
    function post(uint64 id, bytes32 fp) external onlySettler {
        Batch storage b = batches[id];
        if (b.openBlock == 0 || b.commitBlock != 0) revert BadPhase();
        if (fp == 0 || b.posted >= MAX_POSTS) revert TooBig();
        uint256 i = b.posted++;
        fingerprint[id][i] = fp;
        emit Posted(id, i, fp);
    }

    /// The market maker's curve, fixed while every order is still only a fingerprint. Only the maker
    /// account may commit (its key is limited on chain to this call), the agent's ML-DSA-87 signature
    /// must verify, and the curve must sit inside the owner's mandate. Closes intake.
    function commit(uint64 id, Curve calldata c, uint64 quoteExpiry, bytes calldata sig) external onlyMaker {
        Batch storage b = batches[id];
        if (b.openBlock == 0 || b.commitBlock != 0) revert BadPhase();
        if (c.bidMax == 0 || c.bidMax > c.bid || c.bid >= c.ask || c.ask > c.askMax || c.maxNet == 0 || quoteExpiry <= block.number) {
            revert BadQuote();
        }
        if (!withinMandate(c)) revert OutsideMandate();
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

    /// Strictly after the commit block, the order's own user (or the settler relaying for them) reveals it.
    /// Nothing learned from a reveal changes the outcome: the price curve is already fixed on chain, and
    /// every order in the batch fills at the one price this contract computes.
    function reveal(uint64 id, uint256 index, Order calldata o, bytes calldata sig, bytes32 salt) external {
        if (msg.sender != o.user && msg.sender != settler) revert NotRevealer();
        Batch storage b = batches[id];
        if (b.commitBlock == 0 || block.number <= b.commitBlock || block.number > b.commitBlock + revealWindow || b.settleBlock != 0) {
            revert BadPhase();
        }
        bytes32 fp = fingerprint[id][index];
        if (fp == 0 || revealedAs[id][index] != 0 || fingerprintOf(o, sig, salt) != fp) revert BadReveal();
        revealedAs[id][index] = keccak256(abi.encode(o, keccak256(sig)));
        b.revealed++;
        emit Revealed(id, index, o, sig);
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
        int256 lin = _int(p0 * m) - _int(d * b);
        uint256 disc = uint256(lin * lin) + 4 * m * d * q * PRICE_SCALE;
        int256 root = _int(_sqrt(disc));
        int256 p = (lin + root) / _int(2 * m);
        return p > 0 ? uint256(p) : 1;
    }

    /// uint256 to int256 that reverts instead of wrapping (Solidity does not check this conversion).
    function _int(uint256 x) internal pure returns (int256) {
        if (x > uint256(type(int256).max)) revert TooBig();
        return int256(x);
    }

    /// Babylonian square root: converges in a few dozen iterations for any uint256.
    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }

    /// Settles revealed orders. Allowed once every posted order is revealed or the reveal window is over,
    /// so the settler cannot cut the window short to leave orders out.
    function settle(uint64 id, uint256[] calldata indexes, Order[] calldata orders, bytes[] calldata sigs)
        external
        onlySettler
        nonReentrant
    {
        // Bounded work: at most MAX_ORDERS (32) orders per settlement, each a fixed number of calls.
        if (orders.length > MAX_ORDERS) revert TooBig();
        if (orders.length != sigs.length || orders.length != indexes.length) revert TooBig();
        Batch storage b = batches[id];
        if (b.commitBlock == 0 || b.settleBlock != 0 || block.number <= b.commitBlock) revert BadPhase();
        if (b.revealed < b.posted && block.number <= b.commitBlock + revealWindow) revert BadPhase();
        if (block.number > b.quoteExpiry || block.number > b.commitBlock + revealWindow + settleWindow) revert BadPhase();
        b.settleBlock = uint64(block.number);

        Totals memory t;
        (t.quoteIn, t.baseIn) = _authenticate(id, indexes, orders, sigs);
        if (t.quoteIn > type(uint128).max || t.baseIn > type(uint128).max) revert TooBig();
        t.price = clearingPrice(curveOf(id), t.quoteIn, t.baseIn);
        b.price = uint128(t.price);
        if (t.price != 0) { lastPrice = t.price; lastPriceBlock = uint64(block.number); }
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

    /// Pass 1: every order must be the one its owner revealed; authenticate it, mark it used, total each side.
    function _authenticate(uint64 id, uint256[] calldata indexes, Order[] calldata orders, bytes[] calldata sigs)
        internal returns (uint256 quoteIn, uint256 baseIn)
    {
        for (uint256 i; i < orders.length; ++i) {
            Order calldata o = orders[i];
            if (revealedAs[id][indexes[i]] != keccak256(abi.encode(o, keccak256(sigs[i])))) revert BadOrder(i);
            bytes32 h = orderHash(o);
            if (used[h] || o.amountIn == 0 || block.number > o.expiry || (o.batch != 0 && o.batch != id)) revert BadOrder(i);
            used[h] = true;
            _verify(o.user, sigs[i], signedOrderBytes(o));
            if (o.buy) quoteIn += o.amountIn;
            else baseIn += o.amountIn;
        }
    }

    /// Pass 2: pull every input, then pay every output at the single price.
    function _execute(uint64 id, Order[] calldata orders, uint256 price)
        internal returns (uint256 baseOut, uint256 quoteOut)
    {
        for (uint256 i; i < orders.length; ++i) {
            _safeTransferFrom(orders[i].buy ? quote : base, orders[i].user, orders[i].amountIn);
        }
        for (uint256 i; i < orders.length; ++i) {
            Order calldata o = orders[i];
            uint256 out = o.buy ? o.amountIn * PRICE_SCALE / price : o.amountIn * price / PRICE_SCALE;
            if (out < o.minOut || out == 0) revert MinOut(i);
            if (o.buy) baseOut += out;
            else quoteOut += out;
            _safeTransfer(o.buy ? base : quote, o.user, out);
            emit Filled(id, orderHash(o), o.user, o.buy, o.amountIn, out);
        }
    }

    /// The maker's side: what left (or entered) its inventory. Must stay within its committed size.
    function _finish(uint64 id, uint256 maxNet, Totals memory t, uint256 n) internal {
        int256 makerBase = _int(t.baseIn) - _int(t.baseOut);    // positive: maker bought base
        int256 makerQuote = _int(t.quoteIn) - _int(t.quoteOut); // positive: maker received quote
        uint256 net = makerBase < 0 ? uint256(-makerBase) : uint256(makerBase);
        if (net > maxNet) revert TooBig();
        emit Settled(id, t.price, t.quoteIn, t.baseIn, makerBase, makerQuote, n);
    }

    /// Inventory leaves only to the treasury, only with the owner's ML-DSA-87 signature, and only up to
    /// the mandate's daily limit for that token.
    function withdraw(address token, uint256 amount, bytes calldata sig) external nonReentrant {
        if (token != address(base) && token != address(quote)) revert BadToken();
        uint256 day = block.timestamp / 1 days;
        uint256 cap = token == address(base) ? mandate.dailyBaseOut : mandate.dailyQuoteOut;
        uint256 done = withdrawnOn[token][day] + amount;
        if (done > cap) revert OverDailyLimit();
        uint256 n = withdrawNonce;
        _verify(owner, sig, withdrawMessage(token, amount, n));
        withdrawNonce = n + 1;
        withdrawnOn[token][day] = done;
        _safeTransfer(IERC20(token), treasury, amount);
        emit Withdrawn(token, amount, n);
    }

    /// ERC-20 transfers: the token must have code, the call must succeed, and a returned bool must be
    /// true. Otherwise TransferFailed, and the whole settlement or withdrawal reverts.
    function _safeTransferFrom(IERC20 t, address from, uint256 amount) internal {
        if (address(t).code.length == 0) revert TransferFailed(); // a call to an address with no code would "succeed"
        (bool ok, bytes memory ret) = address(t).call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(IERC20 t, address to, uint256 amount) internal {
        if (address(t).code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = address(t).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
