// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Blind's security core, deployed for the Q-Day Drill.
/// Holds QOR. Money leaves only with an ML-DSA-87 signature from the owner's
/// key registered on QoreChain (read from 0x0A02, possession proven), checked
/// on chain by 0x0A01. Nothing here trusts msg.sender, so a stolen classical
/// key gains nothing.
contract DrillVault {
    address constant VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant STATUS = 0x0000000000000000000000000000000000000a02;

    address public immutable owner;
    uint256 public nonce;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount, uint256 nonce);

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function ownerKey() public view returns (bytes memory pubkey) {
        (bool ok, bytes memory ret) =
            STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", owner));
        require(ok && ret.length >= 128, "key status precompile not active");
        (bool registered, uint8 alg, bytes memory key, bool proven) =
            abi.decode(ret, (bool, uint8, bytes, bool));
        require(registered && alg == 1 && proven, "owner has no proven ML-DSA-87 key");
        return key;
    }

    function withdrawMessage(address to, uint256 amount, uint256 n) public view returns (bytes memory) {
        return abi.encodePacked("blind-vault-withdraw-v1", block.chainid, address(this), to, amount, n);
    }

    /// Anyone may submit; only a valid owner ML-DSA-87 signature moves money.
    function withdraw(address payable to, uint256 amount, bytes calldata pqSig) external {
        uint256 n = nonce;
        (bool ok, bytes memory ret) = VERIFY.staticcall(
            abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", ownerKey(), pqSig, withdrawMessage(to, amount, n))
        );
        require(ok && ret.length >= 32 && abi.decode(ret, (bool)), "bad ML-DSA-87 signature");
        nonce = n + 1;
        (bool sent,) = to.call{value: amount}("");
        require(sent, "transfer failed");
        emit Withdrawn(to, amount, n);
    }
}
