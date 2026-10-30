// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IRewardState {
    function root() external view returns (bytes32);
    function pendingRoot() external view returns (bytes32, bytes32, uint256);
    function claimed(address, address) external view returns (uint256);
    function recipients(address) external view returns (address);
}

/// @notice Stateless assertion to CALL immediately before setRoot in the SAME
/// Safe MultiSend. It has no authority, storage, transfer or root-changing method.
contract ClaimSnapshotCheck {
    error WrongChain();
    error WrongRoot();
    error PendingRoot();
    error WrongRecipient();
    error BadSnapshots();
    error ClaimedChanged(uint256 index);

    /// @dev Each snapshot is address(20) | tokenIndex(1) | claimed(12).
    /// uint96 is lossless for every reviewed snapshot in this recovery bundle.
    function check(
        uint256 chainId,
        IRewardState distributor,
        bytes32 expectedRoot,
        address treasury,
        address[] calldata tokens,
        bytes calldata snapshots
    ) external view {
        if (block.chainid != chainId) revert WrongChain();
        if (distributor.root() != expectedRoot) revert WrongRoot();
        (,, uint256 validAt) = distributor.pendingRoot();
        if (validAt != 0) revert PendingRoot();
        address recipient = distributor.recipients(treasury);
        if (recipient != address(0) && recipient != treasury) revert WrongRecipient();
        if (snapshots.length % 33 != 0 || tokens.length > 256) revert BadSnapshots();
        // Reuse one ABI buffer: thousands of high-level calls otherwise expand
        // memory enough to approach Ethereum's per-transaction gas limit.
        bytes memory query = abi.encodeCall(IRewardState.claimed, (address(0), address(0)));
        for (uint256 offset; offset < snapshots.length; offset += 33) {
            address account;
            uint256 expected;
            assembly ("memory-safe") {
                let entry := add(snapshots.offset, offset)
                account := shr(96, calldataload(entry))
                expected := shr(160, calldataload(add(entry, 21)))
            }
            address token = tokens[uint8(snapshots[offset + 20])];
            bool ok;
            uint256 actual;
            assembly ("memory-safe") {
                mstore(add(query, 36), account)
                mstore(add(query, 68), token)
                ok := staticcall(gas(), distributor, add(query, 32), 68, 0, 32)
                ok := and(ok, eq(returndatasize(), 32))
                actual := mload(0)
            }
            if (!ok || actual != expected) revert ClaimedChanged(offset / 33);
        }
    }
}
